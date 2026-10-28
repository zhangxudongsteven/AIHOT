// Request-count quotas share the receipt admission transaction. Reservations protect capacity for a
// named channel; they are not extra calls above the platform ceiling or estimates of money spent.
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";

export interface SpaceBudgetInput {
  perMinute: number;
  perHour: number;
  perDay: number;
  reservedMinute?: number;
  reservedHour?: number;
  reservedDay?: number;
  reason: string;
}

export interface SpaceBudget {
  space_id: string;
  service: string;
  per_minute: number;
  per_hour: number;
  per_day: number;
  reserved_minute: number;
  reserved_hour: number;
  reserved_day: number;
  note: string | null;
  updated_at: Date;
}

export type BudgetLimits = Pick<SpaceBudgetInput, "perMinute" | "perHour" | "perDay">;
export type BudgetWindow = "minute" | "hour" | "day";
const windows = ["minute", "hour", "day"] as const;
const retryAfter = { minute: 60, hour: 600, day: 3600 };
const invalidQuota = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

function validateLimits(limits: BudgetLimits): void {
  for (const value of [limits.perMinute, limits.perHour, limits.perDay]) {
    if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) throw invalidQuota("budgets are non-negative integers (0 stops the service)");
  }
}

/** Caller holds the platform service lock; a zero still works as the platform emergency stop. */
export async function validatePlatformReservations(tx: Db, service: string, limits: BudgetLimits, options: { allowStopped?: boolean } = {}): Promise<void> {
  validateLimits(limits);
  if (options.allowStopped !== false && [limits.perMinute, limits.perHour, limits.perDay].includes(0)) return;
  const [row] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT coalesce(sum(reserved_minute), 0) AS minute, coalesce(sum(reserved_hour), 0) AS hour,
           coalesce(sum(reserved_day), 0) AS day FROM space_budgets WHERE service = ${service}`;
  if (row!.minute > limits.perMinute || row!.hour > limits.perHour || row!.day > limits.perDay) {
    throw invalidQuota("platform budget cannot be lower than allocated channel reservations");
  }
}

/** An absent channel row means no additional limit; no business quota is created implicitly. */
export async function setSpaceBudget(spaceId: string, service: string, input: SpaceBudgetInput, actor: string): Promise<SpaceBudget> {
  if (!spaceId?.trim() || !service?.trim()) throw invalidQuota("space and service are required");
  if (!input.reason?.trim()) throw invalidQuota("reason is required");
  validateLimits(input);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + service}))`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"space-budget:" + spaceId + ":" + service}))`;
    if (!(await tx`SELECT 1 FROM spaces WHERE id = ${spaceId}`).length) throw new Error(`Unknown space: ${spaceId}`);
    const [before] = await tx<SpaceBudget[]>`SELECT * FROM space_budgets WHERE space_id = ${spaceId} AND service = ${service}`;
    // Editing request ceilings must not silently release an existing channel's reserved capacity.
    const reserved = { perMinute: input.reservedMinute ?? before?.reserved_minute ?? 0,
      perHour: input.reservedHour ?? before?.reserved_hour ?? 0, perDay: input.reservedDay ?? before?.reserved_day ?? 0 };
    validateLimits(reserved);
    if (reserved.perMinute > input.perMinute || reserved.perHour > input.perHour || reserved.perDay > input.perDay) {
      throw invalidQuota("channel reservations cannot exceed its limits");
    }
    const [after] = await tx<SpaceBudget[]>`INSERT INTO space_budgets
      (space_id, service, per_minute, per_hour, per_day, reserved_minute, reserved_hour, reserved_day, note)
      VALUES (${spaceId}, ${service}, ${input.perMinute}, ${input.perHour}, ${input.perDay},
        ${reserved.perMinute}, ${reserved.perHour}, ${reserved.perDay}, ${input.reason})
      ON CONFLICT (space_id, service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour,
        per_day = EXCLUDED.per_day, reserved_minute = EXCLUDED.reserved_minute, reserved_hour = EXCLUDED.reserved_hour,
        reserved_day = EXCLUDED.reserved_day, note = EXCLUDED.note, updated_at = now() RETURNING *`;
    const [platform] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
    if (!platform && [reserved.perMinute, reserved.perHour, reserved.perDay].some(n => n > 0)) {
      throw invalidQuota("a finite platform budget is required before reserving channel capacity");
    }
    if (platform) await validatePlatformReservations(tx, service, { perMinute: platform.per_minute, perHour: platform.per_hour, perDay: platform.per_day }, { allowStopped: false });
    await audit(actor, "space.budget.update", `space:${spaceId}:budget:${service}`, input.reason, before ?? null, after, { db: tx });
    return after!;
  });
}

export async function getSpaceBudgets(spaceId: string): Promise<(SpaceBudget & { used_minute: number; used_hour: number; used_day: number })[]> {
  return sql`SELECT b.*,
      (SELECT count(*)::int FROM receipt_attempts a WHERE a.space_id = b.space_id AND a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 minute') AS used_minute,
      (SELECT count(*)::int FROM receipt_attempts a WHERE a.space_id = b.space_id AND a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour') AS used_hour,
      (SELECT count(*)::int FROM receipt_attempts a WHERE a.space_id = b.space_id AND a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day') AS used_day
    FROM space_budgets b WHERE b.space_id = ${spaceId} ORDER BY b.service`;
}

/** Called after the service and channel locks, before a paid attempt is inserted. All attempt statuses
 * count: unknown outcomes, rejected responses, model fallbacks and retries never refund capacity. */
export async function checkSpaceQuota(tx: Db, service: string, spaceId: string | null, platform: { per_minute: number; per_hour: number; per_day: number } | undefined): Promise<{ window: BudgetWindow | "stopped"; scope: "space" | "reservation"; retryAfterSeconds: number } | null> {
  const policies = await tx<(SpaceBudget & { minute: number; hour: number; day: number })[]>`
    SELECT b.*, count(a.id) FILTER (WHERE a.started_at > now() - interval '1 minute') AS minute,
      count(a.id) FILTER (WHERE a.started_at > now() - interval '1 hour') AS hour, count(a.id) AS day
    FROM space_budgets b LEFT JOIN receipt_attempts a ON a.space_id = b.space_id AND a.service = b.service
      AND a.origin = 'live' AND a.started_at > now() - interval '1 day'
    WHERE b.service = ${service} GROUP BY b.space_id, b.service`;
  const own = policies.find(b => b.space_id === spaceId);
  if (own) {
    if (windows.some(window => own[`per_${window}`] === 0)) return { window: "stopped", scope: "space", retryAfterSeconds: 3600 };
    for (const window of windows) if (own[window] >= own[`per_${window}`]) {
      return { window, scope: "space", retryAfterSeconds: retryAfter[window] };
    }
  }
  if (!platform || !policies.some(b => windows.some(window => b[`reserved_${window}`] > 0))) return null;
  const [used] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute') AS minute,
      count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS hour, count(*) AS day
    FROM receipt_attempts WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'`;
  for (const window of windows) {
    const held = policies.filter(b => b.space_id !== spaceId).reduce((sum, b) => sum + Math.max(0, b[`reserved_${window}`] - b[window]), 0);
    if (used![window] >= platform[`per_${window}`] - held) return { window, scope: "reservation", retryAfterSeconds: retryAfter[window] };
  }
  return null;
}
