// Operator settings: about-page QR codes (replaced without a release), notification targets
// (switching a group on records enabled_at so older content is never back-filled) and per-service
// request budgets (the circuit breaker paid calls check before sending).
import type { AdminBudget, AdminNotifyTarget, AdminSettings, BeforeJson } from "@aihot/contracts/admin";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { loadContact, type ContactSettings } from "../site/contact.ts";
import { audit } from "../audit.ts";
import { z } from "zod";
import { DEFAULT_SPACE_ID } from "../spaces/context.ts";
import { validatePlatformReservations } from "../spaces/quotas.ts";

type TargetRouting = Pick<BeforeJson<AdminNotifyTarget>, "key" | "space_id" | "kind" | "enabled" | "enabled_at" | "config_ref" | "subject_kinds">;

const MAX_QR_BYTES = 2 * 1024 * 1024;

export async function replaceContactQr(input: { slot: keyof ContactSettings; data: Buffer }, actor: string) {
  if (input.slot !== "wechatQr" && input.slot !== "feishuQr") throw new Error("unknown slot");
  if (input.data.length > MAX_QR_BYTES) throw new Error("二维码图片最大 2MB");
  const meta = await sharp(input.data).metadata().catch(() => null);
  if (!meta || !["png", "jpeg", "webp"].includes(meta.format ?? "")) throw new Error("需要 PNG、JPG 或 WebP 图片");
  if ((meta.width ?? 0) < 120 || (meta.height ?? 0) < 120) throw new Error("图片太小，二维码可能扫不出来");
  const ext = meta.format === "jpeg" ? "jpg" : meta.format!;
  const name = `qr-${input.slot === "wechatQr" ? "wechat" : "feishu"}-${sha256(input.data).slice(0, 8)}.${ext}`;
  const dir = path.join(config.dataDir, "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), input.data);
  const before = await loadContact();
  const next = { ...before, [input.slot]: `/contact/${name}` };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('contact_qr', ${sql.json(next)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await audit(actor, "settings.contact_qr", "settings:contact_qr", null, { [input.slot]: before[input.slot] }, { [input.slot]: next[input.slot] });
  return next;
}

/** The settings page: contact QR codes, content push targets and paid-service budgets. */
export async function settingsOverview(): Promise<BeforeJson<AdminSettings>> {
  const [contact, targets, budgets] = await Promise.all([loadContact(), listTargets(), listBudgets()]);
  return { contact, targets, budgets };
}

export async function listTargets(spaceId?: string): Promise<BeforeJson<AdminNotifyTarget>[]> {
  return sql<BeforeJson<AdminNotifyTarget>[]>`
    SELECT t.key, t.space_id, t.subject_kinds, t.purpose, t.kind, t.enabled, t.enabled_at, t.config_ref, t.note, t.updated_at,
           (SELECT count(*)::int FROM deliveries d WHERE d.target_key = t.key AND d.created_at > now() - interval '7 days') AS deliveries_7d,
           (SELECT max(d.sent_at) FROM deliveries d WHERE d.target_key = t.key) AS last_sent_at
    FROM notify_targets t WHERE (${spaceId ?? null}::text IS NULL OR t.space_id = ${spaceId ?? null}) ORDER BY t.space_id, t.purpose, t.key`;
}

export async function setTargetEnabled(key: string, enabled: boolean, reason: string, actor: string, spaceId = DEFAULT_SPACE_ID) {
  if (!reason?.trim()) throw new Error("reason is required");
  return sql.begin(async tx => {
    const [before] = await tx`SELECT enabled, enabled_at FROM notify_targets WHERE key = ${key} AND space_id = ${spaceId} FOR UPDATE`;
    if (!before) return null;
    const [after] = await tx<Pick<TargetRouting, "key" | "space_id" | "enabled" | "enabled_at">[]>`
      UPDATE notify_targets SET enabled = ${enabled}, enabled_at = CASE WHEN ${enabled} AND NOT enabled THEN now() ELSE enabled_at END, updated_at = now()
      WHERE key = ${key} AND space_id = ${spaceId} RETURNING key, space_id, enabled, enabled_at`;
    await audit(actor, enabled ? "notify.enable" : "notify.disable", `notify-target:${key}`, reason, before, after, { db: tx });
    return { ...after!, pushEnabledHere: config.feishuContentPushEnabled };
  });
}

const ContentTargetInput = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  kind: z.enum(["feishu_webhook", "log"]),
  configRef: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable(),
  subjectKinds: z.array(z.enum(["selected", "report"])).min(1),
  enabled: z.boolean(), reason: z.string().trim().min(1),
}).strict();

/** Credentials stay in the integrations secret store; the database holds only the reference name. */
export async function configureContentTarget(spaceId: string, input: z.infer<typeof ContentTargetInput>, actor: string) {
  const value = ContentTargetInput.parse(input);
  if (value.kind === "feishu_webhook" && value.enabled && !value.configRef) throw new Error("An enabled webhook target requires a credential reference");
  if (spaceId !== DEFAULT_SPACE_ID && ["FEISHU_PUSH_WEBHOOK_URL", "FEISHU_PUSH_MIRROR_WEBHOOK_URL"].includes(value.configRef ?? "")) throw new Error("A channel must use its own credential reference");
  const key = spaceId === DEFAULT_SPACE_ID ? value.name : `space:${spaceId}:${value.name}`;
  return sql.begin(async tx => {
    if (!(await tx`SELECT 1 FROM spaces WHERE id = ${spaceId}`).length) throw new Error(`Unknown space: ${spaceId}`);
    const [before] = await tx`SELECT * FROM notify_targets WHERE key = ${key} FOR UPDATE`;
    if (before && (before.space_id !== spaceId || before.purpose !== "content")) throw new Error("Target belongs to a different space or purpose");
    const kinds = [...new Set(value.subjectKinds)].sort();
    const [after] = await tx<TargetRouting[]>`INSERT INTO notify_targets (key, space_id, purpose, kind, enabled, enabled_at, config_ref, subject_kinds, note)
      VALUES (${key}, ${spaceId}, 'content', ${value.kind}, ${value.enabled}, CASE WHEN ${value.enabled} THEN now() ELSE NULL END, ${value.configRef}, ${kinds}::text[], ${value.reason})
      ON CONFLICT (key) DO UPDATE SET kind = EXCLUDED.kind, enabled = EXCLUDED.enabled,
        enabled_at = CASE WHEN EXCLUDED.enabled AND (NOT notify_targets.enabled OR notify_targets.kind IS DISTINCT FROM EXCLUDED.kind
          OR notify_targets.config_ref IS DISTINCT FROM EXCLUDED.config_ref OR notify_targets.subject_kinds IS DISTINCT FROM EXCLUDED.subject_kinds) THEN now() ELSE notify_targets.enabled_at END,
        config_ref = EXCLUDED.config_ref, subject_kinds = EXCLUDED.subject_kinds, note = EXCLUDED.note, updated_at = now()
      WHERE notify_targets.space_id = EXCLUDED.space_id AND notify_targets.purpose = 'content'
      RETURNING key, space_id, kind, enabled, enabled_at, config_ref, subject_kinds`;
    if (!after) throw new Error("Target belongs to a different space or purpose");
    await audit(actor, "notify.configure", `space:${spaceId}:notify-target:${key}`, value.reason, before ?? null, after, { db: tx });
    return { ...after, pushEnabledHere: config.feishuContentPushEnabled };
  });
}

export async function listBudgets(): Promise<BeforeJson<AdminBudget>[]> {
  return sql<BeforeJson<AdminBudget>[]>`
    SELECT b.service, b.per_minute, b.per_hour, b.per_day, b.note, b.updated_at,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day') AS used_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour') AS used_hour
    FROM budgets b ORDER BY b.service`;
}

export async function updateBudget(service: string, input: { perMinute: number; perHour: number; perDay: number; reason: string }, actor: string) {
  if (!service?.trim()) throw new Error("service is required");
  if (!input.reason?.trim()) throw new Error("reason is required");
  for (const v of [input.perMinute, input.perHour, input.perDay]) if (!Number.isInteger(v) || v < 0) throw new Error("budgets are non-negative integers (0 stops the service)");
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + service}))`;
    await validatePlatformReservations(tx, service, input);
    const [before] = await tx`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
    const [after] = await tx`
    INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, ${input.perMinute}, ${input.perHour}, ${input.perDay}, ${input.reason})
    ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day, note = EXCLUDED.note, updated_at = now()
    RETURNING service, per_minute, per_hour, per_day`;
    await audit(actor, "budget.update", `budget:${service}`, input.reason, before ?? null, after, { db: tx });
    return after;
  });
}
