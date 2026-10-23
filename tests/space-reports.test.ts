import { gate, pointModels, stub, tag } from "./setup.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { buildApp } from "../apps/api/src/app.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { beijingAt } from "@aihot/contracts/time";
import { configForContext, defaultSpaceConfig, storeSpaceConfig, type SpaceContext } from "@aihot/backend/spaces/context";
import { composeDaily, composeWeekly, composeMonthly, composeDueReports, dueDaily, periodPrompt } from "@aihot/backend/reports/compose";
import { dailyMemory } from "@aihot/backend/reports/edition";
import { correctReportClassification } from "@aihot/backend/reports/correct";
import { withPublicationSpace } from "@aihot/backend/publication/context";
import { feedIssues, listReports, loadReport, v1Daily, v1Period } from "@aihot/backend/publication/reports";
import { loadDiscoveryEntries } from "@aihot/backend/publication/sitemap";

const app = await buildApp();
let address: string;
const requests: string[] = [];
const provider = await stub((_hit, request) => {
  requests.push(request.body);
  return { choices: [{ message: { content: JSON.stringify({ overview: "本期有新公告。", sections: {} }) } }] };
});
pointModels(provider.url);
before(async () => {
  // A separate test database exercises the deliberate natural-key cutover, never a live installation.
  await sql`ALTER TABLE reports DROP CONSTRAINT reports_kind_key_key`;
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});
after(async () => { app.server.closeAllConnections(); await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

type Fixture = { context: SpaceContext; source: string; name: string; category: string; second: string };
async function channel(name: string, daily = "08:00"): Promise<Fixture> {
  const id = `reports-${tag()}`;
  await sql`INSERT INTO spaces (id, slug) VALUES (${id}, ${id})`;
  const pack = structuredClone(defaultSpaceConfig());
  pack.siteName = name;
  pack.categories = [
    { key: `${id}-one`, label: `${name}公告`, guide: "公告", section: `${name}公告`, tagColor: "blue" },
    { key: `${id}-two`, label: `${name}研究`, guide: "研究", section: `${name}研究`, tagColor: "green" },
  ];
  pack.reports = { editionTimes: { daily, weekly: "10:00", monthly: "10:30" }, quiet: { title: `${name}暂无新动态`, paragraph: "{start} 至 {end}暂无新动态。" }, release: null, plainTerms: [] };
  pack.prompts["report-period"] += `\n仅处理${name}。`;
  const context = await storeSpaceConfig(id, pack);
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${id}`;
  const source = `source-${tag()}`;
  await sql`INSERT INTO sources (id, space_id, name, kind, tier, participation_mode) VALUES (${source}, ${id}, ${name}, 'rss', 'T1', 'editorial')`;
  return { context, source, name, category: pack.categories[0]!.key, second: pack.categories[1]!.key };
}

async function item(f: Fixture, date: string, title = `${f.name}新公告`) {
  const id = `report-item-${tag()}`;
  const at = new Date(beijingAt(date, "08:00").getTime() - 12 * 3600_000);
  await sql`INSERT INTO articles (id, space_id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${f.context.spaceId}, ${f.source}, ${id}, ${`https://example.invalid/${id}`}, ${title}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, space_id, title, summary, source_id, category, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score)
    VALUES (${id}, ${f.context.spaceId}, ${title}, ${`${title}的公开摘要。`}, ${f.source}, ${f.category}, 'news', ${`https://example.invalid/${id}`}, ${at}, ${at}, ${at}, true, true, ${at}, 'public', 90)`;
  return id;
}
const read = <T>(f: Fixture, fn: () => T | Promise<T>) => withPublicationSpace({ id: f.context.spaceId, slug: f.context.spaceId, name: f.name, configVersion: f.context.configVersion }, fn);
const saved = async (f: Fixture, kind: string, key: string) => (await sql`SELECT * FROM reports WHERE space_id = ${f.context.spaceId} AND kind = ${kind} AND key = ${key}`)[0]!;

test("daily, weekly and monthly issues at the same date remain independent through every report read", async () => {
  const a = await channel("安全频道");
  const b = await channel("硬件频道");
  const [ai, bi] = await Promise.all([item(a, "2024-02-08"), item(b, "2024-02-08")]);
  const calls = provider.hits();
  await Promise.all([composeDaily("2024-02-08", undefined, a.context), composeDaily("2024-02-08", undefined, b.context)]);
  assert.equal(provider.hits(), calls, "daily composition never calls a model");
  await Promise.all([a, b].flatMap(f => [composeWeekly("2024-W06", undefined, f.context), composeMonthly("2024-02", undefined, f.context)]));
  for (const [own, other, ownId, foreignId] of [[a, b, ai, bi], [b, a, bi, ai]] as const) {
    for (const [kind, key] of [["daily", "2024-02-08"], ["weekly", "2024-W06"], ["monthly", "2024-02"]] as const) {
      const r = await saved(own, kind, key);
      assert.equal(r.config_version, own.context.configVersion);
      assert.ok(JSON.stringify(r.content).includes(ownId));
      assert.ok(!JSON.stringify(r.content).includes(foreignId));
      const [detail, index, feed] = await read(own, () => Promise.all([loadReport(kind, key), listReports(kind), feedIssues(kind, 10)]));
      const output = JSON.stringify([detail, index, feed]);
      assert.ok(output.includes(own.name));
      assert.ok(!output.includes(other.name));
      assert.ok(!output.includes(foreignId));
      assert.equal(index.length, 1);
      assert.equal(detail?.issueNumber, 1);
    }
    const v1 = await read(own, () => Promise.all([v1Daily("latest"), v1Period("weekly", "latest"), v1Period("monthly", "latest")]));
    assert.ok(JSON.stringify(v1).includes(`/channels/${own.context.spaceId}/daily/2024-02-08`));
    assert.ok(!JSON.stringify(v1).includes(foreignId));
    const urls = await read(own, () => loadDiscoveryEntries());
    assert.ok(urls.some(e => e.loc === `/channels/${own.context.spaceId}/weekly/2024-W06`));
    const receipts = await sql`SELECT status, config_version FROM receipts WHERE space_id = ${own.context.spaceId}`;
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every(r => r.status === "completed" && r.config_version === own.context.configVersion));
  }
  assert.equal(await loadReport("daily", "2024-02-08"), null, "legacy URLs never read either channel");
  assert.equal(requests.length, 4);
  for (const request of requests) assert.notEqual(request.includes(a.name), request.includes(b.name), "one model request carries one channel's prompt and evidence");
});

test("memory, regeneration and classification corrections use only their own report series", async () => {
  const a = await channel("甲频道");
  const b = await channel("乙频道");
  const ai = await item(a, "2024-03-04"), bi = await item(b, "2024-03-04");
  await Promise.all([composeDaily("2024-03-04", undefined, a.context), composeDaily("2024-03-04", undefined, b.context)]);
  const beforeB = await saved(b, "daily", "2024-03-04");
  const memory = await dailyMemory("2024-03-05", a.context);
  assert.ok(memory.keys.has(`a:${ai}`));
  assert.ok(!memory.keys.has(`a:${bi}`));
  await sql`UPDATE publications SET category = ${a.second}, title = '甲频道修订公告' WHERE article_id = ${ai}`;
  await sql.begin(tx => correctReportClassification(tx, ai, "更正栏目", a.context));
  const corrected = await saved(a, "daily", "2024-03-04");
  assert.equal(corrected.content.sections[0].label, "甲频道研究");
  assert.equal(corrected.revision, 2);
  await composeDaily("2024-03-04", "明确重编", a.context);
  assert.equal((await saved(a, "daily", "2024-03-04")).revision, 3);
  assert.deepEqual(await saved(b, "daily", "2024-03-04"), beforeB);
  assert.equal(await sql.begin(tx => correctReportClassification(tx, bi, "不能跨频道", a.context)), false);
  const revisions = await sql`SELECT report_id,config_version FROM report_revisions WHERE report_id IN (${corrected.id}, ${beforeB.id})`;
  assert.equal(revisions.length, 2);
  assert.ok(revisions.every(r => r.report_id === corrected.id && r.config_version === a.context.configVersion));
  const updated = structuredClone(configForContext(a.context));
  updated.reports!.quiet.title += "（新配置）";
  const next = await storeSpaceConfig(a.context.spaceId, updated);
  await sql`UPDATE spaces SET active_config_version = ${next.configVersion} WHERE id = ${next.spaceId}`;
  await composeDaily("2024-03-04", "按新快照重编", next);
  assert.equal((await saved(a, "daily", "2024-03-04")).config_version, next.configVersion);
  const [oldVersion] = await sql`SELECT config_version FROM report_revisions WHERE report_id = ${corrected.id} AND revision = 3`;
  assert.equal(oldVersion!.config_version, a.context.configVersion);
  const current = await saved(a, "daily", "2024-03-04");
  await sql`UPDATE publications SET category = ${a.category} WHERE article_id = ${ai}`;
  assert.equal(await sql.begin(tx => correctReportClassification(tx, ai, "旧快照更正", a.context)), false);
  assert.deepEqual(await saved(a, "daily", "2024-03-04"), current);
});

test("missing candidates in one channel do not suppress another channel and schedules retain snapshot times", async () => {
  const a = await channel("空频道", "12:00");
  const b = await channel("正常频道", "09:00");
  await item(b, "2024-04-02");
  const now = beijingAt("2024-04-02", "10:00");
  assert.equal(dueDaily(now, a.context), "2024-04-01");
  assert.equal(dueDaily(now, b.context), "2024-04-02");
  await assert.rejects(composeDueReports(now, 8, a.context), /nothing judged|reports:/);
  assert.deepEqual(await composeDueReports(now, 8, b.context), { generated: ["daily:2024-04-02"], failed: [] });
  assert.equal((await saved(b, "daily", "2024-04-02")).window_end.toISOString(), beijingAt("2024-04-02", "09:00").toISOString());
  assert.ok(periodPrompt("weekly", "2024-04-01", "2024-04-07", [], b.context).system.includes("正常频道"));
  await sql`UPDATE spaces SET enabled = false WHERE id = ${b.context.spaceId}`;
  await assert.rejects(composeDaily("2024-04-02", undefined, b.context), /disabled/);
});

test("foreign and missing article references in stored report JSON cannot leak through report outlets", async () => {
  const a = await channel("可见频道"), b = await channel("私有引用频道");
  const ai = await item(a, "2024-06-03"), bi = await item(b, "2024-06-03", "foreign-secret-headline");
  await composeDaily("2024-06-03", undefined, a.context);
  const r = await saved(a, "daily", "2024-06-03");
  r.content.sections[0].items.push({ itemId: bi, title: "foreign-secret-headline", summary: "foreign-secret-body" }, { itemId: "missing-foreign", title: "missing-secret" });
  r.content.leadItemId = bi;
  r.content.lead = { title: "foreign-secret-headline", leadParagraph: "foreign-secret-body" };
  await sql`UPDATE reports SET content = ${sql.json(r.content)} WHERE id = ${r.id}`;
  const output = await read(a, () => Promise.all([loadReport("daily", "2024-06-03"), listReports("daily"), feedIssues("daily", 10), v1Daily("latest")]));
  const serialized = JSON.stringify(output);
  assert.ok(serialized.includes(ai));
  assert.ok(!serialized.includes("foreign-secret"));
  assert.ok(!serialized.includes("missing-secret"));
  assert.ok(!serialized.includes(bi));
});


test("HTTP, RSS, Agent Markdown and MCP report tools retain the endpoint channel", async () => {
  const a = await channel("公开甲频道"), b = await channel("公开乙频道");
  await Promise.all([item(a, "2024-07-04"), item(b, "2024-07-04")]);
  await Promise.all([a, b].map(f => composeDaily("2024-07-04", undefined, f.context)));
  await Promise.all([a, b].flatMap(f => [composeWeekly("2024-W27", undefined, f.context), composeMonthly("2024-07", undefined, f.context)]));
  const calls = provider.hits();
  for (const [own, foreign] of [[a, b], [b, a]]) {
    const slug = own!.context.spaceId;
    const endpoint = `/api/v1/spaces/${slug}`;
    for (const [kind, key, plural] of [["daily", "2024-07-04", "dailies"], ["weekly", "2024-W27", "weeklies"], ["monthly", "2024-07", "monthlies"]]) {
      for (const path of [`/api/site/spaces/${slug}/reports/${kind}/${key}`, `/api/site/spaces/${slug}/reports/${kind}/latest-page`, `${endpoint}/${plural}/${key}`, `${endpoint}/agent/${kind}/${key}`, `/channels/${slug}/feed/${kind}.xml`]) {
        const response = await app.inject(path);
        assert.equal(response.statusCode, 200, `${path}: ${response.body.slice(0, 200)}`);
        assert.ok(response.body.includes(own!.name), path);
        assert.ok(!response.body.includes(foreign!.name), path);
      }
      assert.equal((await app.inject(`/api/site/reports/${kind}/${key}`)).statusCode, 404);
    }
    const llms = await app.inject(`/channels/${slug}/llms.txt`);
    assert.ok(llms.body.includes(`/channels/${slug}/feed/daily.xml`));
    assert.ok(llms.body.includes(`/channels/${slug}/feed/weekly.xml`));
    const client = new Client({ name: "channel-report-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`/api/mcp/spaces/${slug}`, address)));
      for (const name of [MCP_TOOL_NAMES.daily, MCP_TOOL_NAMES.weekly, MCP_TOOL_NAMES.monthly]) {
        const result = await client.callTool({ name, arguments: {} });
        assert.notEqual(result.isError, true);
        assert.ok(JSON.stringify(result).includes(own!.name));
        assert.ok(!JSON.stringify(result).includes(foreign!.name));
      }
    } finally { await client.close(); }
  }
  const first = await app.inject(`/api/v1/spaces/${a.context.spaceId}/dailies/latest`);
  const other = await app.inject({ url: `/api/v1/spaces/${b.context.spaceId}/dailies/latest`, headers: { "if-none-match": String(first.headers.etag) } });
  assert.equal(other.statusCode, 200);
  assert.notEqual(other.headers.etag, first.headers.etag);
  assert.equal(provider.hits(), calls, "every public outlet only reads already composed reports");
});

for (const [kind, key, compose] of [["weekly", "2024-W35", composeWeekly], ["monthly", "2024-08", composeMonthly]] as const) {
  test(`a delayed ${kind} regeneration cannot overwrite a newer active configuration`, async () => {
    const f = await channel(`竞态${kind}频道`);
    const id = await item(f, "2024-08-30");
    await composeDaily("2024-08-30", undefined, f.context);
    await compose(key, undefined, f.context);
    // Change input so this regeneration cannot reuse the first publication's paid response.
    await sql`UPDATE publications SET title = '重编后的频道公告' WHERE article_id = ${id}`;
    const entered = gate(), release = gate();
    const held = await stub(async hit => {
      if (hit === 1) { entered.open(); await release.promise; }
      return { choices: [{ message: { content: JSON.stringify({ overview: "频道公告已有进展。", sections: {} }) } }] };
    });
    pointModels(held.url);
    let pending: ReturnType<typeof compose> | undefined;
    try {
      pending = compose(key, "旧版本重编", f.context);
      await entered.promise;
      const value = structuredClone(configForContext(f.context));
      value.prompts["report-period"] += "\n新的频道报告版本。";
      const newer = await storeSpaceConfig(f.context.spaceId, value);
      await sql`UPDATE spaces SET active_config_version = ${newer.configVersion} WHERE id = ${newer.spaceId}`;
      assert.equal((await compose(key, "新版本重编", newer))?.status, "published");
      const expected = await saved(f, kind, key);
      assert.equal(expected.config_version, newer.configVersion);
      const revisions = await sql`SELECT * FROM report_revisions WHERE report_id = ${expected.id} ORDER BY revision`;
      const jobs = await sql`SELECT id FROM pgboss.job WHERE data->>'reportId' = ${String(expected.id)}`;
      release.open();
      assert.equal((await pending)?.status, "stale");
      assert.deepEqual(await saved(f, kind, key), expected);
      assert.deepEqual(await sql`SELECT * FROM report_revisions WHERE report_id = ${expected.id} ORDER BY revision`, revisions);
      assert.deepEqual(await sql`SELECT id FROM pgboss.job WHERE data->>'reportId' = ${String(expected.id)}`, jobs);
      const receipts = await sql`SELECT status FROM receipts WHERE space_id = ${f.context.spaceId} AND purpose = ${`report_${kind}`}`;
      assert.equal(receipts.length, 3);
      assert.ok(receipts.every(r => r.status === "completed"), "the old response stays accounted for without being published");
    } finally {
      release.open();
      await pending;
      pointModels(provider.url);
      await held.close();
    }
  });
}

test("disabling a channel while its monthly model is in flight saves no report or push and claims no generated issue", async () => {
  const f = await channel("停用中的报告频道");
  await item(f, "2024-08-30");
  await composeDaily("2024-08-30", undefined, f.context);
  for (const date of ["2024-08-31", "2024-09-01"]) {
    await sql`INSERT INTO reports (space_id,config_version,kind,key,window_start,window_end,content,generated_at)
      VALUES (${f.context.spaceId},${f.context.configVersion},'daily',${date},now(),now(),'{}',now())`;
  }
  const entered = gate(), release = gate();
  const held = await stub(async () => {
    entered.open(); await release.promise;
    return { choices: [{ message: { content: JSON.stringify({ overview: "本期公告汇总。", sections: {} }) } }] };
  });
  pointModels(held.url);
  let pending: ReturnType<typeof composeDueReports> | undefined;
  try {
    const jobs = await sql`SELECT id FROM pgboss.job WHERE name = 'notify.report' AND data->'context'->>'spaceId' = ${f.context.spaceId}`;
    pending = composeDueReports(beijingAt("2024-09-01", "11:00"), 8, f.context);
    await entered.promise;
    await sql`UPDATE spaces SET enabled = false WHERE id = ${f.context.spaceId}`;
    release.open();
    assert.deepEqual(await pending, { generated: [], failed: [] });
    assert.equal(await saved(f, "monthly", "2024-08"), undefined);
    assert.deepEqual(await sql`SELECT id FROM pgboss.job WHERE name = 'notify.report' AND data->'context'->>'spaceId' = ${f.context.spaceId}`, jobs);
    const [receipt] = await sql`SELECT status FROM receipts WHERE space_id = ${f.context.spaceId} AND purpose = 'report_monthly'`;
    assert.equal(receipt!.status, "completed");
  } finally {
    release.open();
    await pending;
    pointModels(provider.url);
    await held.close();
  }
});
