import { gate, pointModels, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { defaultSpaceConfig, resolveSpaceContext, storeSpaceConfig, type SpaceContext } from "@aihot/backend/spaces/context";
import { getSpaceBudgets, setSpaceBudget, validatePlatformReservations } from "@aihot/backend/spaces/quotas";
import { BudgetExceededError, paidRequest, ReceiptUnknownError, rejectReceivedResponse, releaseUnknownReceipt, type ReceiptRequest } from "@aihot/backend/providers/receipts";
import { chatJson } from "@aihot/backend/providers/llm";

after(closeDb);

async function channel() {
  const spaceId = `quota-${tag()}`;
  await sql`INSERT INTO spaces (id, slug, enabled) VALUES (${spaceId}, ${spaceId}, true)`;
  const context = await storeSpaceConfig(spaceId, defaultSpaceConfig());
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${spaceId}`;
  return context;
}
const request = (service: string, context?: SpaceContext): ReceiptRequest => ({ service, context, purpose: "quota_test", identity: tag() });
const answer = async () => ({ response: { ok: true } });
const quota = (context: SpaceContext, service: string, n: number) => setSpaceBudget(context.spaceId, service,
  { perMinute: n, perHour: n, perDay: n, reason: "quota fixture" }, "test");

test("concurrent channel requests reserve one slot, while another channel continues independently", async () => {
  const [a, b] = await Promise.all([channel(), channel()]);
  const service = `channel-concurrency-${tag()}`;
  await quota(a, service, 1);
  await quota(b, service, 1);
  const held = gate();
  const entered = gate();
  const first = paidRequest(request(service, a), async () => { entered.open(); await held.promise; return answer(); });
  await entered.promise;
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => paidRequest(request(service, a), answer)));
  assert.ok(attempts.every(result => result.status === "rejected" && result.reason instanceof BudgetExceededError && result.reason.scope === "space"));
  await paidRequest(request(service, b), answer);
  held.open();
  await first;
  const usage = await getSpaceBudgets(a.spaceId);
  assert.equal(usage[0]!.used_day, 1);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE service = ${service}`).length, 2);
});

test("platform capacity remains a shared hard ceiling even when both channel limits have room", async () => {
  const [a, b] = await Promise.all([channel(), channel()]);
  const service = `platform-concurrency-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 1, 100, 100)`;
  await quota(a, service, 100); await quota(b, service, 100);
  const outcomes = await Promise.allSettled([paidRequest(request(service, a), answer), paidRequest(request(service, b), answer)]);
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  const failure = outcomes.find(o => o.status === "rejected");
  assert.ok(failure?.status === "rejected" && failure.reason instanceof BudgetExceededError && failure.reason.scope === "platform");
});

for (const window of [
  { name: "minute", perMinute: 1, perHour: 20, perDay: 20, age: "2 minutes" },
  { name: "hour", perMinute: 20, perHour: 1, perDay: 20, age: "2 hours" },
  { name: "day", perMinute: 20, perHour: 20, perDay: 1, age: "2 days" },
]) test(`channel ${window.name} quota counts attempts independently and releases aged capacity`, async () => {
  const context = await channel();
  const service = `window-${window.name}-${tag()}`;
  await setSpaceBudget(context.spaceId, service, { ...window, reason: "window fixture" }, "test");
  await paidRequest(request(service, context), answer);
  await assert.rejects(paidRequest(request(service, context), answer), (error: unknown) => error instanceof BudgetExceededError && error.message.endsWith(`:${window.name})`));
  await sql`UPDATE receipt_attempts SET started_at = now() - ${window.age}::interval WHERE service = ${service}`;
  await paidRequest(request(service, context), answer);
});

test("zero quota stops new calls but preserves saved answers and the default legacy receipt bridge", async () => {
  const context = await resolveSpaceContext("default");
  const service = `legacy-quota-${tag()}`;
  const oldRequest = request(service);
  const old = await paidRequest(oldRequest, answer);
  await quota(context, service, 0);
  let hits = 0;
  const reused = await paidRequest({ ...oldRequest, context }, async () => { hits++; return answer(); });
  assert.equal(reused.receiptId, old.receiptId);
  assert.equal(reused.reused, true);
  await assert.rejects(paidRequest(request(service, context), async () => { hits++; return answer(); }), BudgetExceededError);
  assert.equal(hits, 0);
  const rows = await sql`SELECT space_id, config_version FROM receipt_attempts WHERE receipt_id = ${old.receiptId}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.space_id, "default");
  assert.equal((await getSpaceBudgets("default")).find(row => row.service === service)!.used_day, 1);
});

test("unknown outcomes and unusable responses retain their quota when released or retried", async () => {
  const context = await channel();
  const service = `unknown-quota-${tag()}`;
  const req = request(service, context);
  await quota(context, service, 2);
  let id = 0;
  await assert.rejects(paidRequest(req, async () => { throw new Error("local timeout"); }), (error: unknown) => {
    assert.ok(error instanceof ReceiptUnknownError); id = error.receiptId; return true;
  });
  await assert.rejects(paidRequest(req, answer), ReceiptUnknownError);
  await releaseUnknownReceipt(sql, id, "explicit test release");
  const retried = await paidRequest(req, answer);
  assert.equal(retried.receiptId, id);
  await rejectReceivedResponse(id, "unusable test answer");
  await assert.rejects(paidRequest(req, answer), BudgetExceededError);
  assert.equal((await getSpaceBudgets(context.spaceId))[0]!.used_day, 2);
});

test("explicit safety reservations survive ordinary and platform traffic without exceeding the total", async () => {
  const [reserved, ordinary] = await Promise.all([channel(), channel()]);
  const service = `reserved-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 5, 5, 5)`;
  await setSpaceBudget(reserved.spaceId, service, { perMinute: 5, perHour: 5, perDay: 5,
    reservedMinute: 3, reservedHour: 3, reservedDay: 3, reason: "explicit reserved capacity" }, "test");
  // No row for the ordinary channel: lack of an individual limit cannot bypass the reservation.
  await paidRequest(request(service, ordinary), answer);
  await paidRequest(request(service), answer);
  const blocked = await Promise.allSettled(Array.from({ length: 6 }, () => paidRequest(request(service, ordinary), answer)));
  assert.ok(blocked.every(r => r.status === "rejected" && r.reason instanceof BudgetExceededError && r.reason.scope === "reservation"));
  await assert.rejects(paidRequest(request(service), answer), (error: unknown) => error instanceof BudgetExceededError && error.scope === "reservation");
  await Promise.all(Array.from({ length: 3 }, () => paidRequest(request(service, reserved), answer)));
  await assert.rejects(paidRequest(request(service, reserved), answer), (error: unknown) => error instanceof BudgetExceededError && error.scope === "platform");
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE service = ${service}`).length, 5);
});

test("reservation edits cannot overallocate and platform emergency stop remains available", async () => {
  const [a, b] = await Promise.all([channel(), channel()]);
  const service = `reservation-edit-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 5, 5, 5)`;
  const policy = { perMinute: 5, perHour: 5, perDay: 5, reservedDay: 3, reason: "reservation test" };
  await setSpaceBudget(a.spaceId, service, policy, "test");
  await assert.rejects(setSpaceBudget(b.spaceId, service, policy, "test"), /lower than allocated/);
  assert.equal((await getSpaceBudgets(b.spaceId)).length, 0, "failed reservation write rolls back");
  await assert.rejects(sql.begin(tx => validatePlatformReservations(tx, service, { perMinute: 5, perHour: 5, perDay: 2 })), /lower than allocated/);
  await sql.begin(tx => validatePlatformReservations(tx, service, { perMinute: 0, perHour: 5, perDay: 2 }));
  await assert.rejects(setSpaceBudget(a.spaceId, `${service}-unbounded`, policy, "test"), /finite platform budget/);
  await assert.rejects(setSpaceBudget(a.spaceId, service, { ...policy, perDay: 1 }, "test"), /cannot exceed/);
  await assert.rejects(setSpaceBudget(a.spaceId, service, { ...policy, perDay: -1 }, "test"), /non-negative/);
  await sql`UPDATE budgets SET per_day = 0 WHERE service = ${service}`;
  await assert.rejects(setSpaceBudget(b.spaceId, service, { ...policy, reservedDay: 1 }, "test"), /lower than allocated/,
    "new reservations require capacity even while the platform is stopped");
});

test("concurrent reservation edits cannot promise the same remaining platform capacity twice", async () => {
  const [a, b] = await Promise.all([channel(), channel()]);
  const service = `reservation-race-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 3, 3, 3)`;
  const input = { perMinute: 3, perHour: 3, perDay: 3, reservedMinute: 2, reservedHour: 2, reservedDay: 2, reason: "concurrent reservation" };
  const results = await Promise.allSettled([setSpaceBudget(a.spaceId, service, input, "test"), setSpaceBudget(b.spaceId, service, input, "test")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const [reserved] = await sql`SELECT sum(reserved_day)::int AS reserved FROM space_budgets WHERE service = ${service}`;
  assert.equal(reserved!.reserved, 2);
});

test("model fallback attempts charge their own channel and service, and quota refusal never triggers fallback", async () => {
  const [a, b] = await Promise.all([channel(), channel()]);
  const primary = await stub(() => new Reply(503, { error: "local unavailable" }));
  const backup = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
  pointModels(primary.url, ["deepseek-flash"]);
  pointModels(backup.url, ["qwen3.8-flash"]);
  try {
    await quota(a, "deepseek", 1); await quota(a, "dashscope", 1); await quota(b, "deepseek", 0);
    const opts = { context: a, model: "deepseek-flash", fallbackModel: "qwen3.8-flash", purpose: "quota_fallback",
      subject: tag(), promptVersion: "test", system: "test", user: tag(), schema: z.object({ ok: z.boolean() }) };
    const result = await chatJson(opts);
    assert.equal(result.model, "qwen3.8-flash");
    assert.equal((await chatJson(opts)).reused, true);
    assert.deepEqual([primary.hits(), backup.hits()], [1, 1]);
    assert.deepEqual((await getSpaceBudgets(a.spaceId)).map(row => [row.service, row.used_day]), [["dashscope", 1], ["deepseek", 1]]);
    await assert.rejects(chatJson({ ...opts, context: b, user: tag() }), (error: unknown) => error instanceof BudgetExceededError && error.scope === "space");
    assert.deepEqual([primary.hits(), backup.hits()], [1, 1]);
  } finally { await primary.close(); await backup.close(); }
});
