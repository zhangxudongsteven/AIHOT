import { gate, pointModels, stub, tag } from "./setup.ts";
import { analysisStep, SELECTING_SCORE } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { defaultSpaceConfig, resolveSpaceContext, storeSpaceConfig, type SpaceContext } from "@aihot/backend/spaces/context";
import { runInEnabledSpaces } from "@aihot/backend/jobs/spaces";
import { queueProcessing, processArticle, settleNonEditorial } from "@aihot/backend/jobs/content";
import { getBoss, enqueue, scopeJobData, QUEUES, stopBoss, type JobData } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadItemDetail, exportMarkdown } from "@aihot/backend/publication/detail";
import { loadItemShare } from "@aihot/backend/publication/og";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { selectedContent } from "@aihot/backend/notify/selected-content";
import { listedCondition } from "@aihot/backend/publication/scope";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { loadPool } from "@aihot/backend/publication/pool";
import { selectedSnapshot, v1Items } from "@aihot/backend/publication/v1";
import { cutoverSpaceIdentity } from "../scripts/space-cutover.ts";
import { composeDaily } from "@aihot/backend/reports/compose";
import { translateArticle } from "@aihot/backend/editorial/translate";

after(async () => { await stopBoss(); await closeDb(); });

async function fixture() {
  const spaceId = `jobs-${tag()}`;
  await sql`INSERT INTO spaces (id, slug, enabled) VALUES (${spaceId}, ${spaceId}, true)`;
  const context = await storeSpaceConfig(spaceId, defaultSpaceConfig());
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${spaceId}`;
  const source = `source-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier, space_id) VALUES (${source}, 'Fixture source', 'rss', 'T1', ${spaceId})`;
  const url = `https://example.invalid/${tag()}`;
  const { articleId } = await upsertMaterial({ sourceId: source, url, title: '频道测试材料',
    bodyText: '一份只属于内部测试频道的公开公告样本。', bodyStatus: 'ok', publishedAt: new Date(), via: 'fetch' }, sql, context);
  return { context, articleId, source, url };
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'processing did not reach the held database row');
    await delay(10);
  }
}

test("concurrent submissions of one evaluation tag advance once and retain one runnable job", async () => {
  const { context, articleId } = await fixture();
  const jobs = await Promise.all(Array.from({ length: 6 }, () => queueProcessing(articleId, { context, attemptTag: 'same-review' })));
  assert.equal(jobs.filter(Boolean).length, 1);
  const [article] = await sql`SELECT processing_generation, processing_config_version FROM articles WHERE id = ${articleId}`;
  assert.equal(article!.processing_generation, 1);
  assert.equal(article!.processing_config_version, context.configVersion);
  const queued = await sql<{ data: JobData['content.analyze'] }[]>`SELECT data FROM pgboss.job WHERE data->>'articleId' = ${articleId}`;
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.data.generation, 1);
  assert.equal(queued[0]!.data.inputRevision, 1);
  assert.deepEqual(queued[0]!.data.context, context);
});

test("a body-needed continuation waiting on a newer evaluation cannot restore its old configuration", async () => {
  const { context, articleId } = await fixture();
  await sql`UPDATE articles SET body_status = 'pending', body_text = NULL WHERE id = ${articleId}`;
  const changed = structuredClone(defaultSpaceConfig());
  changed.prompts.prefilter += '\nNew body evaluation.';
  const newer = await storeSpaceConfig(context.spaceId, changed);
  let pending: Promise<{ state: string }> | undefined;
  await sql.begin(async tx => {
    const [held] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM articles WHERE id = ${articleId} FOR UPDATE`;
    pending = processArticle(articleId, { context, inputRevision: 1, generation: 0 });
    // The old analysis reads its input, decides it needs a body, and then waits to enqueue it.
    await waitFor(async () => (await sql`SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND ${held!.pid} = ANY(pg_blocking_pids(pid))`).length > 0);
    await queueProcessing(articleId, { context: newer, attemptTag: 'new-body-review', db: tx });
  });
  await pending;
  const [article] = await sql`SELECT processing_generation, processing_config_version FROM articles WHERE id = ${articleId}`;
  assert.equal(article!.processing_generation, 1);
  assert.equal(article!.processing_config_version, newer.configVersion);
  const queued = await sql<{ data: JobData['content.extract-body'] }[]>`SELECT data FROM pgboss.job WHERE data->>'articleId' = ${articleId}`;
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.data.generation, 1);
  assert.deepEqual(queued[0]!.data.context, newer);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE space_id = ${context.spaceId}`).length, 0);
});

test("a delayed discussion settlement cannot erase a newer evaluation's failure or regroup", async () => {
  const { context, articleId, source } = await fixture();
  await sql`UPDATE sources SET participation_mode = 'hot_signal' WHERE id = ${source}`;
  const state = async () => ({ ...(await sql`SELECT processing_state, processing_attempts, processing_retry_at,
    processing_generation, processing_config_version FROM articles WHERE id = ${articleId}`)[0] });
  let pending: Promise<{ state: string }> | undefined;
  let expected: Awaited<ReturnType<typeof state>> | undefined;
  await sql.begin(async tx => {
    const [held] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM articles WHERE id = ${articleId} FOR UPDATE`;
    pending = processArticle(articleId, { context, inputRevision: 1, generation: 0 });
    await waitFor(async () => (await sql`SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND ${held!.pid} = ANY(pg_blocking_pids(pid))`).length > 0);
    await queueProcessing(articleId, { context, attemptTag: 'new-discussion-review', db: tx });
    [expected] = await tx`UPDATE articles SET processing_state = 'failed', processing_attempts = 3,
      processing_retry_at = now() + interval '1 hour' WHERE id = ${articleId}
      RETURNING processing_state, processing_attempts, processing_retry_at, processing_generation, processing_config_version`;
  });
  await pending;
  assert.deepEqual(await state(), { ...expected });
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.group} AND data->>'articleId' = ${articleId}`).length, 0);
  await sql`UPDATE articles SET grouping_generation = 1 WHERE id = ${articleId}`;
  assert.deepEqual(await settleNonEditorial(articleId, { context, inputRevision: 1, generation: 1, groupingGeneration: 0 }), { group: false });
  assert.deepEqual(await settleNonEditorial(articleId, { context, inputRevision: 0, generation: 1, groupingGeneration: 1 }), { group: false });
  const changed = structuredClone(defaultSpaceConfig());
  changed.prompts.prefilter += '\nDifferent discussion rules.';
  const different = await storeSpaceConfig(context.spaceId, changed);
  assert.deepEqual(await settleNonEditorial(articleId, { context: different, inputRevision: 1, generation: 1, groupingGeneration: 1 }), { group: false });
  assert.deepEqual(await state(), { ...expected }, 'only the matching evaluation may clear failure state');
  assert.deepEqual(await settleNonEditorial(articleId, { context, inputRevision: 1, generation: 1, groupingGeneration: 1 }), { group: true });
  const settled = await state();
  assert.equal(settled.processing_state, 'skipped');
  assert.equal(settled.processing_attempts, 0);
  assert.equal(settled.processing_retry_at, null);
});

test("extraction rejects obsolete task inputs and discards an answer overtaken by re-evaluation", async () => {
  const { context, articleId } = await fixture();
  const entered = gate();
  const release = gate();
  const provider = await stub(async hit => {
    if (hit === 1) { entered.open(); await release.promise; }
    return { article: { title: '频道正文', content_state: { blocks: [{ text: 'The original publisher provides detailed specifications and availability. '.repeat(12) }] } } };
  });
  process.env.SOCIALDATA_BASE_URL = provider.url;
  process.env.SOCIALDATA_API_KEY = 'test-key';
  const allowPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  await sql`UPDATE articles SET body_status = 'pending', body_text = NULL,
    x_post = ${sql.json({ tweetId: `${Date.now()}`, text: 'https://x.com/i/article/123' })} WHERE id = ${articleId}`;
  const changed = structuredClone(defaultSpaceConfig());
  changed.prompts.prefilter += '\nExtract with new rules.';
  const newer = await storeSpaceConfig(context.spaceId, changed);
  try {
    await queueProcessing(articleId, { context: newer, attemptTag: 'extract-review-1' });
    assert.equal(await extractArticleBody(articleId, { context, inputRevision: 1, generation: 0 }), 'skipped');
    assert.equal(await extractArticleBody(articleId, { context, inputRevision: 1, generation: 1 }), 'skipped', 'even a current generation cannot use another configuration');
    assert.equal(await extractArticleBody(articleId, { context: newer, inputRevision: 0, generation: 1 }), 'skipped');
    assert.equal(provider.hits(), 0, 'obsolete tasks never reach the paid provider');
    const pending = extractArticleBody(articleId, { context: newer, inputRevision: 1, generation: 1 });
    await entered.promise;
    await queueProcessing(articleId, { context: newer, attemptTag: 'extract-review-2' });
    release.open();
    assert.equal(await pending, 'skipped');
    const [unchanged] = await sql`SELECT revision, body_text, body_status, processing_generation FROM articles WHERE id = ${articleId}`;
    assert.equal(unchanged!.revision, 1);
    assert.equal(unchanged!.body_status, 'pending');
    assert.equal(unchanged!.body_text, null);
    assert.equal(unchanged!.processing_generation, 2);
    assert.equal(await extractArticleBody(articleId, { context: newer, inputRevision: 1, generation: 2 }), 'ok');
    assert.equal((await sql`SELECT revision FROM articles WHERE id = ${articleId}`)[0]!.revision, 2);
    assert.equal(provider.hits(), 1, 'a valid successor can reuse the same extraction receipt');
    const receipts = await sql`SELECT config_version FROM receipts WHERE space_id = ${context.spaceId}`;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.config_version, newer.configVersion);
  } finally {
    release.open();
    config.allowPrivateNetworkFetch = allowPrivate;
    await provider.close();
  }
});

test("successful analysis queues grouping independently for each revision and evaluation", async () => {
  const provider = await stub((_hit, request) => {
    const step = analysisStep(request.body);
    const content = step === 'prefilter' ? { label: 'PASS', reason: 'fixture announcement' }
      : step === 'score' ? { attentionScore: SELECTING_SCORE }
      : step === 'structure' ? { category: 'ai-models', tags: [], subjects: [], fact: null }
      : { itemType: 'model_release', authorRole: 'principal', tags: ['模型发布'], editorialJudgment: '模型能力提升', titleZh: '模型发布公告', summaryZh: '模型发布并提供评测和价格。' };
    return { choices: [{ message: { content: JSON.stringify(content) } }] };
  });
  pointModels(provider.url);
  try {
    const { context, articleId, source, url } = await fixture();
    assert.equal((await processArticle(articleId, { context, inputRevision: 1, generation: 0 })).state, 'pass');
    await queueProcessing(articleId, { context, attemptTag: 'another-analysis' });
    assert.equal((await processArticle(articleId, { context, inputRevision: 1, generation: 1, attemptTag: 'another-analysis' })).state, 'pass');
    await upsertMaterial({ sourceId: source, url, title: '频道测试材料更新', bodyText: '更新后的公开公告样本，包含新的技术参数。', bodyStatus: 'ok', publishedAt: new Date(), via: 'fetch' }, sql, context);
    assert.equal((await processArticle(articleId, { context, inputRevision: 2, generation: 1, attemptTag: 'another-analysis' })).state, 'pass');
    const jobs = await sql<{ data: JobData['events.group']; priority: number }[]>`SELECT data, priority FROM pgboss.job
      WHERE name = ${QUEUES.group} AND data->>'articleId' = ${articleId} ORDER BY created_on`;
    assert.equal(jobs.length, 3, 'a queued older grouping must not suppress the new generation or revision');
    assert.deepEqual(jobs.map(job => [job.data.inputRevision, job.data.generation]), [[1, 0], [1, 1], [2, 1]]);
    assert.ok(jobs.every(job => job.priority === 0 && job.data.context?.spaceId === context.spaceId));
  } finally { await provider.close(); }
});

test("queued tasks preserve configuration and generation; an old task cannot start a new evaluation", async () => {
  const { context, articleId } = await fixture();
  const first = await queueProcessing(articleId, { context });
  const boss = await getBoss();
  const queued = (await boss.getJobById<JobData['content.analyze']>(QUEUES.analyze, first!))!.data;
  assert.deepEqual(queued.context, context);
  assert.equal(queued.inputRevision, 1);
  assert.equal(queued.generation, 0);
  const changed = structuredClone(defaultSpaceConfig());
  changed.prompts.prefilter += '\nFixture rule revision.';
  const newer = await storeSpaceConfig(context.spaceId, changed);
  await sql`UPDATE spaces SET active_config_version = ${newer.configVersion} WHERE id = ${context.spaceId}`;
  const retry = await scopeJobData(QUEUES.analyze, queued, sql, true);
  assert.deepEqual(retry.context, context, 'recovery uses the enqueued historical version');
  const second = await queueProcessing(articleId, { attemptTag: 'explicit-rule-review' });
  const reevaluated = (await boss.getJobById<JobData['content.analyze']>(QUEUES.analyze, second!))!.data;
  assert.deepEqual(reevaluated.context, newer);
  assert.equal(reevaluated.generation, 1);
  assert.equal((await processArticle(articleId, queued)).state, 'stale');
  assert.equal(Number((await sql`SELECT count(*) AS n FROM receipts WHERE space_id = ${context.spaceId}`)[0]!.n), 0);
  await assert.rejects(scopeJobData(QUEUES.analyze, { ...queued, context: { ...context, spaceId: 'default' } }), /does not own/);
  await assert.rejects(scopeJobData(QUEUES.analyze, { articleId }, sql, true), /legacy/);
  await sql`UPDATE spaces SET enabled = false WHERE id = ${context.spaceId}`;
  await assert.rejects(resolveSpaceContext(context.spaceId, context.configVersion), /disabled/);
});

test("internal channel projections cannot reach default detail, Markdown, share cards, ledger or notifications", async () => {
  const { context, articleId } = await fixture();
  await sql`INSERT INTO analyses (space_id, article_id, input_revision, origin, config_version, relevance, title_zh, summary_zh, selected, score, category)
    VALUES (${context.spaceId}, ${articleId}, 1, 'rule', ${context.configVersion}, 'pass', '内部频道公告', '该条目不应从默认网站出口读取。', true, 100, 'ai-models')`;
  const result = await publishArticle(articleId, { releasedAt: new Date() });
  assert.equal(result?.selected, true, 'internal publication is available for event recall');
  assert.equal((await sql`SELECT 1 FROM publications p WHERE p.article_id = ${articleId} AND ${listedCondition(new Date(), context.spaceId)}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM publications p WHERE p.article_id = ${articleId} AND ${listedCondition(new Date())}`).length, 0);
  assert.equal((await loadItemDetail(articleId)).kind, 'not_found');
  assert.equal(await exportMarkdown(articleId), null);
  assert.equal(await loadItemShare(articleId), null);
  assert.equal((await itemAvailability([articleId]))[articleId]?.status, 'unavailable');
  assert.equal((await selectedContent(articleId)).status, 'skipped');
  assert.equal((await sql`SELECT 1 FROM selected_ledger WHERE article_id = ${articleId} AND space_id = ${context.spaceId}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.notifySelected} AND data->>'articleId' = ${articleId}`).length, 0);
  assert.equal((await translateArticle(articleId)).status, 'skipped');
  assert.equal((await sql`SELECT 1 FROM receipts WHERE space_id = ${context.spaceId}`).length, 0, 'an unavailable translation never calls a model');

  const source = `default-source-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${source}, 'Default source', 'rss', 'T1')`;
  const { articleId: publicId } = await upsertMaterial({ sourceId: source, url: `https://example.invalid/${tag()}`,
    title: '默认网站公告', bodyText: '默认网站的公开材料。', bodyStatus: 'ok', publishedAt: new Date(), via: 'fetch' });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected, score, category)
    VALUES (${publicId}, 1, 'rule', 'pass', '默认网站公告', '默认网站摘要。', true, 100, 'ai-models')`;
  await publishArticle(publicId, { releasedAt: new Date() });
  const pool = await loadPool({ channel: 'all', category: null, tag: null });
  assert.ok(pool.items.some(i => i.id === publicId));
  assert.ok(!pool.items.some(i => i.id === articleId));
  for (const kind of ['all', 'selected', 'selected-full'] as const) {
    const rss = await itemFeed(kind, null);
    assert.ok(rss.includes(publicId));
    assert.ok(!rss.includes(articleId));
  }
  for (const mode of ['all', 'selected'] as const) {
    const response = await v1Items({ mode, window: '7d', by: 'timeline', category: null, q: null, limit: 100, cursor: null });
    assert.ok(response.items.some(i => i.id === publicId));
    assert.ok(!response.items.some(i => i.id === articleId));
  }
  // The read boundary also rejects an old or imported ledger row from another channel.
  await sql`INSERT INTO selected_ledger (seq, article_id, op, visible_at, payload)
    SELECT (SELECT max(seq) + 1 FROM selected_ledger), ${articleId}, 'upsert', visible_at, jsonb_set(payload, '{id}', to_jsonb(${articleId}::text))
    FROM selected_ledger WHERE article_id = ${publicId} ORDER BY seq DESC LIMIT 1`;
  await sql`INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq)
    SELECT ${articleId}, true, 'foreign-fixture', seq FROM selected_ledger WHERE article_id = ${articleId} ORDER BY seq DESC LIMIT 1
    ON CONFLICT (article_id) DO UPDATE SET last_seq = EXCLUDED.last_seq`;
  const snapshot = await selectedSnapshot({ limit: 100, page: null });
  assert.ok(snapshot.items.some(i => i.id === publicId));
  assert.ok(!snapshot.items.some(i => i.id === articleId));
});


test("one failed channel timer does not starve other channels and retains separate run records", async () => {
  const a = await fixture();
  const b = await fixture();
  const visited: string[] = [];
  const name = `space-timer-${tag()}`;
  await assert.rejects(runInEnabledSpaces(name, async context => {
    visited.push(context.spaceId);
    if (context.spaceId === a.context.spaceId) throw new Error('fixture failure');
    return { done: true };
  }), AggregateError);
  assert.ok(visited.includes(b.context.spaceId));
  const rows = await sql<{ job: string; status: string }[]>`SELECT job,status FROM job_runs WHERE job = ANY(${[`${name}:${a.context.spaceId}`, `${name}:${b.context.spaceId}`]}::text[])`;
  assert.equal(rows.find(r => r.job.endsWith(a.context.spaceId))?.status, 'failed');
  assert.equal(rows.find(r => r.job.endsWith(b.context.spaceId))?.status, 'ok');
});


test("new selections queue notification and media with the article channel and retain their configuration on replay", async () => {
  const a = await fixture(), b = await fixture();
  await sql`INSERT INTO analyses(space_id,article_id,input_revision,origin,config_version,relevance,title_zh,summary_zh,selected,score,category)
    VALUES(${a.context.spaceId},${a.articleId},1,'rule',${a.context.configVersion},'pass','新刊通知标题','当前频道的通知摘要',true,100,'ai-models')`;
  await sql`UPDATE articles SET grouping_status='complete',grouped_at=now(),selection_adds_value=true WHERE id=${a.articleId}`;
  assert.equal((await publishArticle(a.articleId))?.selected,true);
  const jobs=await sql<{name:typeof QUEUES.notifySelected|typeof QUEUES.prepareMedia;data:JobData['notify.selected']}[]>`
    SELECT name,data FROM pgboss.job WHERE name=ANY(${[QUEUES.notifySelected,QUEUES.prepareMedia]}::text[]) AND data->>'articleId'=${a.articleId}`;
  assert.equal(jobs.length,2);
  const changed=structuredClone(defaultSpaceConfig());
  changed.siteName='队列创建后的频道名称';
  const next=await storeSpaceConfig(a.context.spaceId,changed);
  await sql`UPDATE spaces SET active_config_version=${next.configVersion} WHERE id=${a.context.spaceId}`;
  for(const job of jobs) {
    assert.deepEqual(job.data.context,a.context);
    const replay=await scopeJobData(job.name,job.data,sql,true);
    assert.deepEqual('context' in replay ? replay.context : undefined,a.context);
    await assert.rejects(scopeJobData(job.name,{articleId:a.articleId},sql,true),/legacy/);
    await assert.rejects(scopeJobData(job.name,{...job.data,context:b.context},sql,true),/does not own/);
  }
  await publishArticle(a.articleId);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=ANY(${[QUEUES.notifySelected,QUEUES.prepareMedia]}::text[]) AND data->>'articleId'=${a.articleId}`).length,2,'an unchanged publication does not enqueue another push or media job');
});

test("report jobs for the same date have separate identities, fixed channel versions and no automatic correction replay", async () => {
  await cutoverSpaceIdentity(sql);
  const a=await fixture(), b=await fixture();
  const date='2024-02-02';
  for(const own of [a,b]) {
    await sql`INSERT INTO publications(space_id,article_id,title,summary,source_id,category,channel,url,discovered_at,timeline_at,sort_at,eligible,selected,visible_after,visibility,score)
      VALUES(${own.context.spaceId},${own.articleId},'同日期独立报告候选','报告摘要',${own.source},'ai-models','news',${own.url},
        '2024-02-01T12:00:00Z','2024-02-01T12:00:00Z','2024-02-01T12:00:00Z',true,true,'2024-02-01T12:00:00Z','public',100)`;
  }
  await Promise.all([a,b].map(own=>composeDaily(date,undefined,own.context)));
  const reports=await sql<{id:number;space_id:string}[]>`SELECT id,space_id FROM reports WHERE kind='daily' AND key=${date} AND space_id=ANY(${[a.context.spaceId,b.context.spaceId]}::text[])`;
  assert.equal(reports.length,2);
  const jobs=await sql<{singleton_key:string;data:JobData['notify.report']}[]>`
    SELECT singleton_key,data FROM pgboss.job WHERE name=${QUEUES.notifyReport} AND data->>'reportId'=ANY(${reports.map(r=>String(r.id))}::text[])`;
  assert.equal(jobs.length,2);
  assert.equal(new Set(jobs.map(j=>j.singleton_key)).size,2);
  const changed=structuredClone(defaultSpaceConfig());changed.siteName='报告任务之后的新名称';
  const next=await storeSpaceConfig(a.context.spaceId,changed);
  await sql`UPDATE spaces SET active_config_version=${next.configVersion} WHERE id=${a.context.spaceId}`;
  for(const own of [a,b]) {
    const report=reports.find(r=>r.space_id===own.context.spaceId)!;
    const job=jobs.find(j=>j.data.reportId===report.id)!;
    assert.deepEqual(job.data.context,own.context);
    assert.deepEqual((await scopeJobData(QUEUES.notifyReport,job.data,sql,true)).context,own.context);
    await assert.rejects(scopeJobData(QUEUES.notifyReport,{reportId:report.id},sql,true),/legacy/);
    await assert.rejects(scopeJobData(QUEUES.notifyReport,{...job.data,context:own===a?b.context:a.context},sql,true),/does not own/);
  }
  await composeDaily(date,undefined,a.context);
  await composeDaily(date,'明确更正不重新发送',next);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.notifyReport} AND data->>'reportId'=ANY(${reports.map(r=>String(r.id))}::text[])`).length,2);
  const aReport=reports.find(r=>r.space_id===a.context.spaceId)!;
  assert.deepEqual((await scopeJobData(QUEUES.notifyReport,jobs.find(j=>j.data.reportId===aReport.id)!.data,sql,true)).context,a.context,'saved notification context remains pinned after report regeneration');
});

test("notification queue insertion rolls back with its business transaction and legacy media remains default-only", async () => {
  const {articleId,context}=await fixture();
  await assert.rejects(sql.begin(async tx=>{
    await enqueue(QUEUES.notifySelected,{articleId,context},{singletonKey:`rollback:${articleId}`},tx);
    throw new Error('business transaction interrupted');
  }),/business transaction interrupted/);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.notifySelected} AND data->>'articleId'=${articleId}`).length,0);
  const source=`legacy-media-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${source},'Legacy media','rss','T1')`;
  const {articleId:legacy}=await upsertMaterial({sourceId:source,url:`https://example.invalid/${tag()}`,title:'默认频道',bodyText:'正文',bodyStatus:'ok',publishedAt:new Date(),via:'fetch'});
  const defaultContext=await resolveSpaceContext('default');
  for(const name of [QUEUES.notifySelected,QUEUES.prepareMedia] as const) {
    const replay=await scopeJobData(name,{articleId:legacy},sql,true);
    assert.deepEqual('context' in replay ? replay.context : undefined,defaultContext);
  }
  const shared={url:'https://example.invalid/animation.gif',mode:'card'};
  assert.deepEqual(await scopeJobData(QUEUES.prepareMedia,shared,sql,true),shared,'an already authorized asset conversion has no content-channel identity');
});
