// Failure cases: concurrent claims duplicate a fact; an ambiguous webhook reply looks delivered;
// a retry bypasses target disable/withdrawal; a mirror sends after the first target awaited a withdrawal.
// A lost reply must still suppress regrouped siblings; enabling a group must not replay older items.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { deliverContent, resendDelivery } from "@aihot/backend/notify/deliver";
import { pushSelected } from "@aihot/backend/notify/selected";
import { pushReport } from "@aihot/backend/notify/reports";
import { selectedContent } from "@aihot/backend/notify/selected-content";
import { ensureContentTargets, resolveDelivery } from "@aihot/backend/notify/deliver";
import { defaultSpaceConfig, storeSpaceConfig, type SpaceContext } from "@aihot/backend/spaces/context";
import { cutoverSpaceIdentity } from "../scripts/space-cutover.ts";

const T = tag();
const TARGET = `test-delivery-${T}`;
const WEBHOOK = "https://delivery.invalid/test";
const ids: number[] = [];
const requests: number[] = [];
let answer = async (_id: number) => Response.json({ code: 0 });

before(async () => {
  process.env.TEST_DELIVERY_WEBHOOK = WEBHOOK;
  // Exercise the live branch entirely in-process; any unexpected network request fails the test.
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), WEBHOOK);
    const id = JSON.parse(String(init?.body)).card.id as number;
    requests.push(id);
    return answer(id);
  }) as typeof fetch;
  config.feishuContentPushEnabled = true;
  await sql`INSERT INTO notify_targets (key, purpose, kind, config_ref, enabled, subject_kinds)
    VALUES (${TARGET}, 'content', 'feishu_webhook', 'TEST_DELIVERY_WEBHOOK', true, ARRAY['selected','test'])`;
});
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  config.feishuContentPushEnabled = false;
  await closeDb();
});

/** A delivery that sends the card it stored (a selected article's card is built afresh instead). */
async function delivery(status = "unknown") {
  const [row] = await sql<{ id: number }[]>`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status)
    VALUES (${TARGET}, 'test', 'test', ${`${T}-${ids.length}`}, ${status}) RETURNING id`;
  ids.push(row.id);
  await sql`UPDATE deliveries SET payload = ${sql.json({ id: row.id })} WHERE id = ${row.id}`;
  return row.id;
}
const state = async (id: number) => (await sql<{ status: string; attempts: number; version: string }[]>`
  SELECT status, attempts, updated_at::text AS version FROM deliveries WHERE id = ${id}`)[0];
test("disabled pushes and missing credentials leave the retry available without sending", async () => {
  const id = await delivery();
  const before = await state(id);
  config.feishuContentPushEnabled = false;
  try { await assert.rejects(resendDelivery(id), /disabled/); }
  finally { config.feishuContentPushEnabled = true; }
  delete process.env.TEST_DELIVERY_WEBHOOK;
  try { await assert.rejects(resendDelivery(id), /webhook not configured/); }
  finally { process.env.TEST_DELIVERY_WEBHOOK = WEBHOOK; }
  assert.deepEqual(await state(id), before);
  assert.equal(requests.filter((n) => n === id).length, 0);
});

test("only an explicit webhook acknowledgement counts as delivered", async () => {
  for (const [reply, expected] of [
    [() => new Response("<html>proxy error</html>"), "unknown"],
    [() => Response.json({}), "unknown"],
    [() => Response.json(null), "unknown"],
    [() => Response.json({ code: 0 }, { status: 503 }), "unknown"],
    [() => Response.json({ code: 99 }), "failed"],
    [() => new Response("rejected", { status: 400 }), "failed"],
    [() => Response.json({ StatusCode: 0 }), "sent"],
    [() => Response.json({ code: 0 }), "sent"],
    [() => { throw new Error("connection lost"); }, "unknown"],
  ] as const) {
    const id = await delivery("failed");
    answer = async () => reply();
    try {
      assert.equal((await resendDelivery(id)).status, expected);
      assert.equal((await state(id)).status, expected);
    } finally { answer = async () => Response.json({ code: 0 }); }
  }
});

test("a disabled target cannot receive a manual retry", async () => {
  const id = await delivery();
  const before = await state(id);
  await sql`UPDATE notify_targets SET enabled = false WHERE key = ${TARGET}`;
  try {
    await assert.rejects(resendDelivery(id), /disabled|停用/);
    assert.deepEqual(await state(id), before);
    assert.equal(requests.filter((n) => n === id).length, 0);
  } finally { await sql`UPDATE notify_targets SET enabled = true WHERE key = ${TARGET}`; }
});

async function selectedItem() {
  const id = `delivery-item-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${TARGET}, 'Delivery test', 'rss', 'T1') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${TARGET}, ${id}, 'https://example.com/delivery', ${id}, now(), now())`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility)
    VALUES (${id}, ${id}, ${TARGET}, 'news', 'https://example.com/delivery', now(), now(), now(), now(), true, true, now() - interval '1 minute', 'public')`;
  return id;
}

test("a withdrawn selected item cannot be sent through manual recovery", async () => {
  const articleId = await selectedItem();
  const id = await delivery();
  await sql`UPDATE deliveries SET subject_kind = 'selected', subject_id = ${articleId} WHERE id = ${id}`;
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${articleId}`;
  await assert.rejects(resendDelivery(id), /不可推送|not public|不再/);
  assert.equal(requests.filter((n) => n === id).length, 0);
  assert.equal((await state(id)).status, "unknown");
});

test("a withdrawal while one target is sending stops the following mirror", async () => {
  const articleId = await selectedItem();
  const mirror = `${TARGET}-mirror`;
  await sql`INSERT INTO notify_targets (key, purpose, kind, config_ref, enabled)
    VALUES (${mirror}, 'content', 'feishu_webhook', 'TEST_DELIVERY_WEBHOOK', true)`;
  const arrived = gate();
  const finish = gate();
  const before = requests.length;
  answer = async () => { arrived.open(); await finish.promise; return Response.json({ code: 0 }); };
  const sending = pushSelected(articleId);
  try {
    await arrived.promise;
    await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${articleId}`;
    finish.open();
    await sending;
    assert.equal(requests.length - before, 1, "only the already in-flight card leaves");
  } finally {
    finish.open(); await sending;
    answer = async () => Response.json({ code: 0 });
    await sql`UPDATE notify_targets SET enabled = false WHERE key = ${mirror}`;
  }
});

test("a lost webhook reply still suppresses another report later grouped into the same fact", async () => {
  const first = await selectedItem();
  const sibling = await selectedItem();
  const before = requests.length;
  answer = async () => { throw new Error("reply lost after the group may have received the card"); };
  try { await pushSelected(first); }
  finally { answer = async () => Response.json({ code: 0 }); }
  assert.equal(requests.length - before, 1);
  const [sent] = await sql<{ status: string }[]>`SELECT status FROM deliveries WHERE target_key = ${TARGET} AND subject_id = ${first}`;
  assert.equal(sent!.status, "unknown");

  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`delivery-fact-${tag()}`}, 'same announcement') RETURNING id`;
  for (const id of [first, sibling]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`UPDATE publications SET fact_id = ${fact!.id} WHERE article_id = ${id}`;
  }
  await pushSelected(sibling);
  assert.equal(requests.length - before, 1, "an unknown sibling outcome is not permission to send again");
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key = ${TARGET} AND subject_id = ${sibling}`).length, 0);

  await pushSelected(await selectedItem());
  assert.equal(requests.length - before, 2, "an unrelated announcement can still be delivered");
});

// Failure cases: an already sent article is temporarily removed for regrouping, then reselected
// under a fact key; an earlier fact becomes a different fact; pending/sending/unknown self-deliveries
// are mistaken for permission to send again; a definitely failed delivery loses manual recovery.
test("regrouping the same selected article cannot send it again under a new fact identity", async () => {
  for (const status of ["sent", "unknown", "pending", "sending", "failed"] as const) {
    const id = await selectedItem();
    const before = requests.length;
    await pushSelected(id);
    assert.equal(requests.length - before, 1, "the initial selected article was actually sent through the local webhook");
    const [original] = await sql<{ id: number }[]>`UPDATE deliveries SET status=${status}
      WHERE target_key=${TARGET} AND subject_kind='selected' AND subject_id=${id} RETURNING id`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,title)
      VALUES(${`self-delivery-fact-${tag()}`},'confirmed announcement') RETURNING id`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${id},'report')`;
    await sql`UPDATE publications SET fact_id=${fact!.id} WHERE article_id=${id}`;
    if (status === "failed") {
      await resendDelivery(original!.id);
      assert.equal(requests.length - before, 2, "a confirmed failed delivery still has explicit recovery");
    }
    const sent = requests.length;
    await pushSelected(id);
    assert.equal(requests.length, sent, `${status} self-delivery must not be repeated with a new dedupe key`);
    assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key=${TARGET} AND subject_id=${id}`).length, 1);
  }
});

test("enabling a group excludes earlier content and includes content arriving at its activation time", async () => {
  const enabledAt = new Date(Date.now() - 60_000);
  const before = requests.length;
  await sql`UPDATE notify_targets SET enabled_at = ${enabledAt} WHERE key = ${TARGET}`;
  try {
    for (const [offset, expected] of [[-1, 0], [0, 1]] as const) {
      const id = await selectedItem();
      await sql`UPDATE publications SET discovered_at = ${new Date(enabledAt.getTime() + offset)} WHERE article_id = ${id}`;
      await pushSelected(id);
      assert.equal(requests.length - before, expected, `arrival ${offset}ms relative to activation`);
      assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key = ${TARGET} AND subject_id = ${id}`).length, expected);
    }
  } finally { await sql`UPDATE notify_targets SET enabled_at = NULL WHERE key = ${TARGET}`; }
});

test("concurrent sibling claims reserve a target once, including the pending delivery", async () => {
  const blocker = gate<number>();
  const release = gate();
  const holding = sql.begin(async (tx) => {
    await tx`LOCK TABLE deliveries IN SHARE MODE`;
    blocker.open((await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await release.promise;
  });
  const pid = await blocker.promise;
  const subjects = [`${T}-sibling-a`, `${T}-sibling-b`];
  const before = requests.length;
  const done = Promise.all(subjects.map((subjectId) => deliverContent({
    subjectKind: "test", subjectId, dedupeKey: subjectId, contentAt: new Date(), card: { id: 999 }, siblings: subjects,
  })));
  try {
    const deadline = performance.now() + 5000;
    while (true) {
      const [row] = await sql<{ n: number }[]>`WITH RECURSIVE waiting(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
      ) SELECT count(*)::int AS n FROM waiting`;
      if (row!.n >= 2) break;
      assert.ok(performance.now() < deadline, "both target claims reach the held delivery table");
      await delay(10);
    }
  } finally { release.open(); await holding; }
  await done;
  assert.equal(requests.length - before, 1);
});

async function channel(label: string) {
  const spaceId = `notify-${label}-${tag()}`;
  await sql`INSERT INTO spaces(id,slug,enabled) VALUES(${spaceId},${spaceId},true)`;
  const context = await storeSpaceConfig(spaceId, { ...defaultSpaceConfig(), siteName: `频道 ${label}`, reasonLabel: `关注 ${label}` });
  await sql`UPDATE spaces SET active_config_version=${context.configVersion} WHERE id=${spaceId}`;
  const target = `${spaceId}-target`;
  await sql`INSERT INTO notify_targets(space_id,key,purpose,kind,config_ref,enabled,subject_kinds)
    VALUES(${spaceId},${target},'content','feishu_webhook','TEST_DELIVERY_WEBHOOK',true,ARRAY['selected','report','test'])`;
  return { context, target };
}

async function channelSelected(context: SpaceContext, title: string) {
  const id = `channel-item-${tag()}`;
  const source = `channel-source-${tag()}`;
  await sql`INSERT INTO sources(space_id,id,name,kind,tier) VALUES(${context.spaceId},${source},'官方消息','rss','T1')`;
  await sql`INSERT INTO articles(space_id,id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${context.spaceId},${id},${source},${id},'https://example.com/notice',${title},now(),now())`;
  await sql`INSERT INTO publications(space_id,article_id,title,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,eligible,selected,visible_after,visibility)
    VALUES(${context.spaceId},${id},${title},${source},'news','https://example.com/notice',now(),now(),now(),now(),true,true,now()-interval '1 minute','public')`;
  return id;
}

test("same-title selected cards have separate channel leases, targets, links and delivery history", async () => {
  const [a, b] = await Promise.all([channel('A'), channel('B')]);
  const [first, second] = await Promise.all([channelSelected(a.context, '同一条官方公告'), channelSelected(b.context, '同一条官方公告')]);
  const before = requests.length;
  const outcomes = await Promise.all([pushSelected(first, undefined, a.context), pushSelected(second, undefined, b.context)]);
  assert.deepEqual(outcomes.map(x => x.status), ['pushed','pushed']);
  assert.equal(requests.length-before, 2);
  const rows = await sql<{ space_id: string; target_key: string; subject_id: string; config_version: string; payload: unknown }[]>`
    SELECT space_id,target_key,subject_id,config_version,payload FROM deliveries WHERE subject_id=ANY(${[first,second]}::text[]) ORDER BY subject_id`;
  for (const [id, owner] of [[first,a],[second,b]] as const) {
    const row = rows.find(x => x.subject_id===id)!;
    assert.equal(row.space_id,owner.context.spaceId);
    assert.equal(row.target_key,owner.target);
    assert.equal(row.config_version,owner.context.configVersion);
    assert.match(JSON.stringify(row.payload),new RegExp(`/channels/${owner.context.spaceId}/items/${id}`));
  }
  assert.equal((await sql`SELECT 1 FROM delivery_leases WHERE space_id=ANY(${[a.context.spaceId,b.context.spaceId]}::text[])`).length,2);
  assert.equal((await selectedContent(first,undefined,b.context)).status,'skipped');
  assert.equal((await pushSelected(first)).status,'skipped','legacy callers remain default-channel only');
  const original = requests.length;
  assert.deepEqual(await deliverContent({subjectKind:'selected',subjectId:first,dedupeKey:'forged-target',contentAt:new Date(),card:{},targetKey:b.target},a.context),[]);
  assert.equal(requests.length,original);
  await assert.rejects(sql`INSERT INTO deliveries(space_id,config_version,target_key,subject_kind,subject_id,dedupe_key,status)
    VALUES(${b.context.spaceId},${b.context.configVersion},${a.target},'selected',${second},'forged-cross-target','pending')`, /foreign key/);
});

test("unknown outcomes and manual recovery retain the owning channel even after configuration changes", async () => {
  const a = await channel('recovery');
  const b = await channel('other');
  const id = await channelSelected(a.context,'恢复流程公告');
  answer = async () => { throw new Error('reply lost'); };
  try { await pushSelected(id,undefined,a.context); }
  finally { answer = async () => Response.json({code:0}); }
  const [delivery] = await sql<{id:number;config_version:string}[]>`SELECT id,config_version FROM deliveries WHERE space_id=${a.context.spaceId} AND subject_id=${id}`;
  const count = requests.length;
  await pushSelected(id,undefined,a.context);
  await assert.rejects(resendDelivery(delivery!.id,undefined,b.context),/not found/);
  assert.equal(await resolveDelivery(delivery!.id,{outcome:'sent',note:'wrong channel'},'test',b.context),null);
  assert.equal(requests.length,count);
  assert.equal((await state(delivery!.id)).status,'unknown');
  const changed = await storeSpaceConfig(a.context.spaceId,{...defaultSpaceConfig(),siteName:'变更后的频道名称'});
  await sql`UPDATE spaces SET active_config_version=${changed.configVersion} WHERE id=${a.context.spaceId}`;
  await resendDelivery(delivery!.id,undefined,changed);
  const [stored] = await sql<{payload:unknown;config_version:string}[]>`SELECT payload,config_version FROM deliveries WHERE id=${delivery!.id}`;
  assert.match(JSON.stringify(stored!.payload),/频道 recovery/);
  assert.doesNotMatch(JSON.stringify(stored!.payload),/变更后的频道名称/);
  assert.equal(stored!.config_version,a.context.configVersion);
  assert.equal((await state(delivery!.id)).status,'sent');
});

test("channel suspension and unsubscribing a target block recovery without changing the uncertain outcome", async () => {
  const a = await channel('suspend');
  const id = await channelSelected(a.context,'停用频道公告');
  answer = async () => { throw new Error('reply lost'); };
  try { await pushSelected(id,undefined,a.context); }
  finally { answer = async () => Response.json({code:0}); }
  const [delivery] = await sql<{id:number}[]>`SELECT id FROM deliveries WHERE space_id=${a.context.spaceId} AND subject_id=${id}`;
  const before = await state(delivery!.id);
  const count = requests.length;
  await sql`UPDATE spaces SET enabled=false WHERE id=${a.context.spaceId}`;
  await assert.rejects(resendDelivery(delivery!.id,undefined,a.context),/disabled/);
  await sql`UPDATE spaces SET enabled=true WHERE id=${a.context.spaceId}`;
  await sql`UPDATE notify_targets SET subject_kinds=ARRAY['report'] WHERE key=${a.target}`;
  await assert.rejects(resendDelivery(delivery!.id,undefined,a.context),/取消订阅/);
  assert.equal(requests.length,count);
  assert.deepEqual(await state(delivery!.id),before);
  await sql`UPDATE spaces SET enabled=false WHERE id=${a.context.spaceId}`;
  assert.equal((await resolveDelivery(delivery!.id,{outcome:'sent',note:'operator checked group'},'test',a.context))?.status,'sent');
  assert.equal(requests.length,count,'manual reconciliation works without reactivating the channel or sending');
});

test("new-channel target initialization never inherits the default webhook secret reference", async () => {
  const a = await channel('new');
  await sql`UPDATE spaces SET enabled=false WHERE id=${a.context.spaceId}`;
  await ensureContentTargets(a.context);
  const rows = await sql<{enabled:boolean;config_ref:string|null;subject_kinds:string[]}[]>`
    SELECT enabled,config_ref,subject_kinds FROM notify_targets WHERE space_id=${a.context.spaceId} AND key<>${a.target}`;
  assert.equal(rows.length,2);
  assert.ok(rows.every(x=>!x.enabled && x.config_ref===null));
  assert.ok(rows.every(x=>JSON.stringify(x.subject_kinds)==='["selected"]'));
});

async function channelReport(context: SpaceContext,key: string, contentAt = new Date(Date.now()-60_000)) {
  const [report] = await sql<{id:number}[]>`INSERT INTO reports(space_id,config_version,kind,key,window_start,window_end,content,generated_at)
    VALUES(${context.spaceId},${context.configVersion},'daily',${key},${new Date(contentAt.getTime()-86400000)},${contentAt},
      ${sql.json({lead:{title:`日报 ${context.spaceId}`,leadParagraph:'该频道日报摘要'},sections:[],metrics:{totalEvents:0}})},now()) RETURNING id`;
  return report!.id;
}

test("same-day reports require explicit report subscriptions and stay within channel targets", async () => {
  await cutoverSpaceIdentity(sql);
  const [a,b] = await Promise.all([channel('report-A'),channel('report-B')]);
  const [first,second] = await Promise.all([channelReport(a.context,'2026-10-20'),channelReport(b.context,'2026-10-20')]);
  await sql`UPDATE notify_targets SET subject_kinds=ARRAY['selected'] WHERE key=${a.target}`;
  const before = requests.length;
  assert.equal((await pushReport(first,a.context)).status,'skipped');
  assert.equal((await pushReport(first,b.context)).status,'skipped');
  await sql`UPDATE notify_targets SET subject_kinds=ARRAY['report'] WHERE key=${a.target}`;
  const outcomes = await Promise.all([pushReport(first,a.context),pushReport(second,b.context)]);
  assert.ok(outcomes.every(x=>x.status==='pushed'));
  assert.equal(requests.length-before,2);
  const deliveries = await sql<{space_id:string;target_key:string;subject_id:string;payload:unknown}[]>`
    SELECT space_id,target_key,subject_id,payload FROM deliveries WHERE subject_kind='report' AND subject_id=ANY(${[String(first),String(second)]}::text[])`;
  for (const [id,owner] of [[first,a],[second,b]] as const) {
    const row=deliveries.find(x=>x.subject_id===String(id))!;
    assert.equal(row.space_id,owner.context.spaceId);
    assert.equal(row.target_key,owner.target);
    assert.match(JSON.stringify(row.payload),new RegExp(`/channels/${owner.context.spaceId}/daily/2026-10-20`));
  }
  await pushReport(first,a.context);
  await pushReport(second,b.context);
  assert.equal(requests.length-before,2,'replayed jobs never resend an existing report');
});

test("report backfills stay silent and manual recovery rebuilds corrected public content", async () => {
  const a=await channel('report-recovery');
  const old=await channelReport(a.context,'2026-10-19',new Date(Date.now()-86400000));
  await sql`UPDATE notify_targets SET enabled_at=now()-interval '1 hour' WHERE key=${a.target}`;
  const before=requests.length;
  assert.equal((await pushReport(old,a.context)).status,'skipped');
  assert.equal(requests.length,before);
  const id=await channelReport(a.context,'2026-10-21');
  answer=async()=>{throw new Error('reply lost');};
  try {await pushReport(id,a.context);} finally {answer=async()=>Response.json({code:0});}
  const [delivery]=await sql<{id:number}[]>`SELECT id FROM deliveries WHERE space_id=${a.context.spaceId} AND subject_kind='report' AND subject_id=${String(id)}`;
  await sql`UPDATE reports SET content=${sql.json({lead:{title:'修订后的日报标题',leadParagraph:'修订后的日报摘要'},sections:[],metrics:{totalEvents:0}})},revision=revision+1 WHERE id=${id}`;
  await resendDelivery(delivery!.id,undefined,a.context);
  const [updated]=await sql<{payload:unknown}[]>`SELECT payload FROM deliveries WHERE id=${delivery!.id}`;
  assert.match(JSON.stringify(updated!.payload),/修订后的日报标题/);
  await sql`UPDATE deliveries SET status='unknown' WHERE id=${delivery!.id}`;
  await sql`DELETE FROM reports WHERE id=${id}`;
  await assert.rejects(resendDelivery(delivery!.id,undefined,a.context),/不再符合/);
});
