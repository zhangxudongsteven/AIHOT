import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { beijingAt } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { defaultSpaceConfig, storeSpaceConfig } from "@aihot/backend/spaces/context";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { checkAlerts, collectFindings } from "@aihot/backend/operations/alerts";

const at = (date: string, time = "10:00") => beijingAt(date, time).getTime();
const key = (date: string) => `report.daily:${date}`;
const daily = (keys: string[]) => keys.filter(k => k.startsWith("report.daily"));
async function report(date: string, spaceId = "default") {
  await sql`INSERT INTO reports(space_id,kind,key,window_start,window_end,content,generated_at) VALUES(${spaceId},'daily',${date},${new Date(at(date))},${new Date(at(date))},'{}',${new Date(at(date))})`;
}
before(async () => { await getBoss(); await sql`ALTER TABLE reports DROP CONSTRAINT reports_kind_key_key`; });
beforeEach(async () => {
  Object.assign(process.env, { COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true", FEISHU_INTERNAL_ENABLED: "false" });
  await sql`DELETE FROM reports`;
  await sql`DELETE FROM job_runs WHERE job='reports.compose'`;
  await sql`DELETE FROM settings WHERE key IN ('alerts.state','heartbeat.worker')`;
});
after(async () => { await stopBoss(); await closeDb(); });

test("midnight preserves a missing edition; each date recovers only when its report exists", async () => {
  let result = await checkAlerts(at("2026-10-06", "23:30"));
  assert.deepEqual(daily(result.sent), [key("2026-10-06")]);
  result = await checkAlerts(at("2026-10-07", "00:10"));
  assert.deepEqual(daily(result.open), [key("2026-10-06")]);
  assert.deepEqual(daily(result.sent), []);
  result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(daily(result.open).sort(), [key("2026-10-06"), key("2026-10-07")]);
  await report("2026-10-07");
  result = await checkAlerts(at("2026-10-07", "10:10"));
  assert.deepEqual(daily(result.sent), [`${key("2026-10-07")}:recovered`]);
  assert.deepEqual(daily(result.open), [key("2026-10-06")]);
  await report("2026-10-06");
  assert.deepEqual(daily((await checkAlerts(at("2026-10-07", "10:20"))).sent), [`${key("2026-10-06")}:recovered`]);
  assert.deepEqual(daily((await checkAlerts(at("2026-10-07", "10:30"))).sent), []);
});

test("recent gap detection uses report activity and each edition's overdue time", async () => {
  await sql`INSERT INTO job_runs(job,started_at,status) VALUES('reports.compose',${new Date(at("2026-10-05"))},'failed')`;
  await report("2026-10-06");
  const findings = await collectFindings(at("2026-10-07", "09:59"));
  assert.deepEqual(daily(findings.map(f => f.key)), [key("2026-10-05")]);
  await report("2026-09-01");
  assert.deepEqual(daily((await collectFindings(at("2026-10-07"))).map(f => f.key)),
    [1,2,3,4,5,7].map(d => key(`2026-10-0${d}`)));
});

test("open dates outlive disabled generation and restarts keep checking missing editions", async () => {
  await checkAlerts(at("2026-10-01"));
  process.env.MODEL_CALLS_ENABLED = "false";
  let result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(daily(result.open), [key("2026-10-01")]);
  assert.deepEqual(daily(result.sent), []);
  process.env.MODEL_CALLS_ENABLED = "true";
  await sql`INSERT INTO settings(key,value) VALUES('heartbeat.worker',${sql.json({ startedAt: new Date(at("2026-10-07")).toISOString() })})`;
  result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(daily(result.open), [key("2026-10-01"), key("2026-10-07")]);
  assert.ok(result.sent.includes(key("2026-10-01")), "a restart keeps checking the unresolved edition");
  await sql`DELETE FROM settings WHERE key='heartbeat.worker'`;
  result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(result.sent, [], "rechecking after the restart does not duplicate the reminder");
  process.env.COLLECT_ENABLED = "false";
  await report("2026-10-01");
  assert.ok((await checkAlerts(at("2026-10-07", "10:10"))).sent.includes(`${key("2026-10-01")}:recovered`));
});

test("an edition still missing past the scan window is closed once instead of reminded forever", async () => {
  await checkAlerts(at("2026-10-01"));
  let result = await checkAlerts(at("2026-10-08"));
  assert.ok(result.sent.includes(`${key("2026-10-01")}:expired`));
  assert.ok(!result.open.includes(key("2026-10-01")));
  result = await checkAlerts(at("2026-10-08", "12:00"));
  assert.ok(!result.sent.some(k => k.startsWith(key("2026-10-01"))));
});


async function channel(name: string, dailyTime = "08:00") {
  const id = `alert-${tag()}`;
  const pack = structuredClone(defaultSpaceConfig());
  pack.siteName = name;
  pack.reports!.editionTimes.daily = dailyTime;
  await sql`INSERT INTO spaces(id,slug) VALUES(${id},${id})`;
  const context = await storeSpaceConfig(id, pack);
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${id}`;
  return id;
}
const scopedKey = (spaceId: string, date: string) => `report.daily:${encodeURIComponent(spaceId)}:${date}`;

test("a published issue in another channel cannot mask a missing daily, and each schedule controls overdue", async () => {
  const a = await channel("甲日报"), b = await channel("乙日报", "12:00");
  try {
    await report("2026-10-07");
    await report("2026-10-07", a);
    assert.deepEqual(daily((await collectFindings(at("2026-10-07", "13:59"))).map(f => f.key)), []);
    const findings = (await collectFindings(at("2026-10-07", "14:00"))).filter(f => f.key.startsWith("report.daily"));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.key, scopedKey(b, "2026-10-07"));
    assert.ok(findings[0]!.title.includes("乙日报"));
    assert.ok(!findings[0]!.title.includes("甲日报"));
    const opened = await checkAlerts(at("2026-10-07", "14:00"));
    assert.ok(opened.open.includes(scopedKey(b, "2026-10-07")));
    await report("2026-10-07", b);
    assert.ok((await checkAlerts(at("2026-10-07", "14:10"))).sent.includes(`${scopedKey(b, "2026-10-07")}:recovered`));
  } finally { await sql`UPDATE spaces SET enabled = false WHERE id IN (${a},${b})`; }
});

test("paused or disabled channel incidents recover only when that channel's missing edition exists", async () => {
  const a = await channel("甲缺刊"), b = await channel("乙缺刊");
  const date = "2026-10-08";
  try {
    await report(date);
    const result = await checkAlerts(at(date));
    assert.ok(result.open.includes(scopedKey(a, date)) && result.open.includes(scopedKey(b, date)));
    await report(date, a);
    process.env.MODEL_CALLS_ENABLED = "false";
    await sql`UPDATE spaces SET enabled = false WHERE id = ${b}`;
    const paused = await checkAlerts(at(date, "10:10"));
    assert.ok(paused.sent.includes(`${scopedKey(a, date)}:recovered`));
    assert.ok(paused.open.includes(scopedKey(b, date)));
    assert.ok(!paused.sent.includes(`${scopedKey(b, date)}:recovered`));
    const expired = await checkAlerts(at("2026-10-15"));
    assert.ok(expired.sent.includes(`${scopedKey(b, date)}:expired`));
    assert.ok(!expired.open.includes(scopedKey(b, date)));
  } finally { await sql`UPDATE spaces SET enabled = false WHERE id IN (${a},${b})`; }
});
