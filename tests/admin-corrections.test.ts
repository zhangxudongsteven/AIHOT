import { createHmac } from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { createSource, updateSource, sourceDetail, listSources, fetchNow, planSourceIntake } from "@aihot/backend/admin/sources";
import { overrideFields, rerun, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { buildApp } from "../apps/api/src/app.ts";
import { defaultSpaceConfig, resolveSpaceAdminContext, resolveSpaceContext, storeSpaceConfig } from "@aihot/backend/spaces/context";

const T = tag();
const sourceId = `admin-${T}`;
await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${sourceId}, 'Admin review', 'rss', 'T1')`;
const app = await buildApp();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function article() {
  return (await upsertMaterial({ sourceId, url: `https://example.com/${tag()}`, title: "审查材料", bodyText: "正文", bodyStatus: "ok", via: "fetch", publishedAt: new Date() })).articleId;
}

async function adminHeaders() {
  const token = `admin-session-${tag()}`;
  const [user] = await sql`INSERT INTO admin_users (display_name) VALUES ('Review') RETURNING id`;
  const claims = { appId: "test-session-app", unionId: "test-session-user", email: null };
  process.env.FEISHU_LOGIN_APP_ID = claims.appId;
  process.env.FEISHU_LOGIN_APP_SECRET = "test-app-secret";
  config.adminUnionIds = [claims.unionId];
  const binding = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(["admin-session-v1", "feishu", claims])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, auth_method, auth_binding, auth_claims) VALUES (${sha256(token)}, ${user!.id}, 'review-csrf', now() + interval '1 hour', 'feishu', ${binding}, ${sql.json(claims)})`;
  return { cookie: `aihot_admin=${token}`, "x-csrf-token": "review-csrf", "idempotency-key": `invalid-${tag()}` };
}

test("concurrent source intake creates one source for the same feed", async () => {
  const blocker = await sql.reserve();
  await blocker`BEGIN`;
  await blocker`LOCK TABLE sources IN SHARE MODE`;
  const pending = Promise.all(Array.from({ length: 4 }, (_, i) => createSource({
    id: `intake-${T}-${i}`, name: "Same feed", kind: "rss", config: { feedUrl: `https://example.com/feed-${T}` },
  }, "test")));
  try {
    // Hold inserts until all four requests have reached a lock: reproduce simultaneous clicks,
    // independently of how quickly the database happens to execute their duplicate checks.
    for (let i = 0; ; i++) {
      const [waiting] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (waiting!.n === 4) break;
      assert.ok(i < 200, "all concurrent requests reached the database");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await blocker`ROLLBACK`;
    blocker.release();
  }
  const results = await pending;
  assert.equal(results.filter((r) => r.created).length, 1);
  const created = results.find((r) => r.created)!;
  assert.ok(created.created);
  for (const result of results) if (!result.created) assert.equal(result.duplicate.id, created.source.id);
});

test("source intake and legacy admin operations stay scoped even for the same feed", async () => {
  const spaceId = `admin-space-${tag()}`;
  await sql`INSERT INTO spaces (id, slug) VALUES (${spaceId}, ${spaceId})`;
  const context = await storeSpaceConfig(spaceId, defaultSpaceConfig());
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${spaceId}`;
  const feed = { name: "Shared feed", kind: "rss", config: { feedUrl: `https://example.com/shared-${tag()}` } };
  const own = await createSource({ ...feed, id: `source-${spaceId}` }, "test", context);
  const legacy = await createSource({ ...feed, id: `source-default-${tag()}` }, "test");
  assert.ok(own.created && legacy.created, "another space's feed is not a duplicate");
  const duplicate = await createSource({ ...feed, id: `duplicate-${tag()}` }, "test", context);
  assert.ok(!duplicate.created && duplicate.duplicate.id === own.source.id);
  assert.equal(await sourceDetail(own.source.id), null);
  assert.equal(await fetchNow(own.source.id, "test"), null);
  assert.equal(await updateSource(own.source.id, { patch: { enabled: false }, version: new Date(own.source.updated_at).toISOString() }, "test"), null);
  const scoped = await listSources({}, context);
  assert.deepEqual(scoped.rows.map((row) => row.id), [own.source.id]);
  assert.equal((await sourceDetail(own.source.id, context))?.source.enabled, true);
});

test("channel source routes prepare a disabled channel, enforce its entity vocabulary and isolate legacy addresses", async () => {
  let reads = 0;
  const server = http.createServer((_req, res) => {
    reads++;
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end('<rss version="2.0"><channel><title>Security</title><item><title>Security bulletin</title><link>https://example.org/bulletin</link></item></channel></rss>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const feedUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/feed`;
  const previousPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    const headers = await adminHeaders();
    const spaceId = `admin-source-${tag()}`;
    await sql`INSERT INTO spaces (id, slug, enabled) VALUES (${spaceId}, ${spaceId}, false)`;
    const snapshot = structuredClone(defaultSpaceConfig());
    snapshot.entities = { vendor: { name: "Security vendor", displayTag: null, aliases: [] } };
    snapshot.entityOrder = ["vendor"];
    const context = await storeSpaceConfig(spaceId, snapshot);
    await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${spaceId}`;
    assert.deepEqual(await resolveSpaceAdminContext(spaceId), context);
    await assert.rejects(resolveSpaceContext(spaceId), /disabled/);
    const prefix = `/api/admin/spaces/${spaceId}/sources`;
    const draft = { id: `security-source-${tag()}`, name: "Security feed", kind: "rss", config: { feedUrl }, owner_entity_id: "vendor", tags: ["官方"], enabled: false };
    const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, headers, payload });
    assert.equal((await app.inject({ method: "GET", url: prefix })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: prefix, headers: { cookie: headers.cookie }, payload: draft })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/spaces/missing/sources", headers })).statusCode, 404);
    assert.equal((await post(prefix, { ...draft, owner_entity_id: "openai" })).statusCode, 400);
    const created = await post(prefix, draft);
    assert.equal(created.statusCode, 200, created.body);
    const source = created.json().source;
    assert.equal(source.space_id, spaceId);
    assert.equal(source.owner_entity_id, "vendor");
    assert.equal(source.enabled, false);
    assert.equal((await app.inject({ method: "GET", url: prefix, headers })).json().rows[0].id, draft.id);
    for (const url of [`/api/admin/sources/${draft.id}`, `${prefix}/${sourceId}`]) {
      assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 404);
      assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { version: source.updated_at, patch: { name: "Wrong channel" } } })).statusCode, 404);
    }
    const edited = await app.inject({ method: "PATCH", url: `${prefix}/${draft.id}`, headers, payload: { version: source.updated_at, patch: { name: "Reviewed feed" } } });
    assert.equal(edited.statusCode, 200, edited.body);
    for (const url of [`${prefix}/preview`, `${prefix}/${draft.id}/preview`, `${prefix}/${draft.id}/fetch`]) assert.equal((await post(url, draft)).statusCode, 409);
    assert.equal(reads, 0, "preparing a disabled channel never fetched its candidate");
    await sql`UPDATE spaces SET enabled = true WHERE id = ${spaceId}`;
    assert.equal((await post(`${prefix}/preview`, { ...draft, owner_entity_id: "openai" })).statusCode, 400);
    assert.equal(reads, 0, "invalid channel ownership is rejected before fetching");
    for (const url of [`/api/admin/sources/${draft.id}/preview`, `/api/admin/sources/${draft.id}/fetch`, `${prefix}/${sourceId}/preview`, `${prefix}/${sourceId}/fetch`]) assert.equal((await post(url, {})).statusCode, 404);
    for (const url of [`${prefix}/preview`, `${prefix}/${draft.id}/preview`]) {
      const preview = await post(url, draft);
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(preview.json().count, 1);
    }
    assert.equal(reads, 2);
    assert.equal((await sql`SELECT 1 FROM articles WHERE source_id = ${draft.id}`).length, 0, "preview never stores articles");
    const fetching = await post(`${prefix}/${draft.id}/fetch`, {});
    assert.equal(fetching.statusCode, 200, fetching.body);
    const [job] = await sql`SELECT data FROM pgboss.job WHERE id = ${fetching.json().jobId}`;
    assert.deepEqual(job!.data.context, context);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject = ${`source:${draft.id}`} AND action = 'source.create'`).length, 1);
    await upsertMaterial({ sourceId: draft.id, title: "Stored bulletin", url: `https://example.org/${tag()}`, via: "fetch" }, sql, context);
    await sql`UPDATE spaces SET enabled = false WHERE id = ${spaceId}`;
    const version = (await sourceDetail(draft.id, context))!.source.updated_at;
    const rejected = await app.inject({ method: "PATCH", url: `${prefix}/${draft.id}`, headers, payload: { version, patch: { name: "Would leave stale publications" } } });
    assert.equal(rejected.statusCode, 409);
    assert.equal((await sourceDetail(draft.id, context))!.source.name, "Reviewed feed");
    const interval = await app.inject({ method: "PATCH", url: `${prefix}/${draft.id}`, headers, payload: { version, patch: { interval_minutes: 60 } } });
    assert.equal(interval.statusCode, 200, interval.body);
  } finally {
    config.allowPrivateNetworkFetch = previousPrivate;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("candidate source plans validate the entire file and preserve existing operator settings without writes", async () => {
  const spaceId = `intake-plan-${tag()}`;
  await sql`INSERT INTO spaces (id, slug, enabled) VALUES (${spaceId}, ${spaceId}, false)`;
  const context = await storeSpaceConfig(spaceId, defaultSpaceConfig());
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${spaceId}`;
  const existing = { id: `plan-source-${tag()}`, name: "Operator name", kind: "rss", config: { feedUrl: `https://example.org/${tag()}` }, enabled: false };
  await createSource(existing, "test", context);
  const next = { ...existing, id: `plan-new-${tag()}`, config: { feedUrl: `https://example.org/${tag()}` } };
  const { plan } = await planSourceIntake({ sources: [{ ...existing, name: "Candidate name", config: { feedUrl: `https://example.org/candidate-${tag()}` } }, next, { ...existing, id: `plan-dup-${tag()}` }] }, context);
  assert.deepEqual(plan.map(row => row.action), ["preserve", "create", "duplicate"]);
  assert.equal((await sourceDetail(existing.id, context))!.source.name, "Operator name");
  assert.equal(await sourceDetail(next.id, context), null);
  await assert.rejects(planSourceIntake({ sources: [next, next] }, context), /ID 重复/);
  await assert.rejects(planSourceIntake({ sources: [next, { ...next, id: `plan-address-${tag()}` }] }, context), /地址重复/);
  await assert.rejects(planSourceIntake({ sources: [{ ...next, id: sourceId }] }, context), { code: "conflict" });
  await assert.rejects(planSourceIntake({ sources: [next, { ...next, id: `plan-owner-${tag()}`, owner_entity_id: "missing-entity" }] }, context), /未配置机构/);
  assert.equal(await sourceDetail(next.id, context), null);
  const directory = await mkdtemp(path.join(os.tmpdir(), "channel-source-intake-"));
  try {
    const file = path.join(directory, "sources.json");
    await writeFile(file, JSON.stringify({ sources: [next] }));
    const run = (action: string) => {
      const result = spawnSync(process.execPath, ["scripts/space-sources.ts", action, "--space", spaceId, "--file", file, ...(action === "apply" ? ["--actor", "source-cli-test"] : [])], { encoding: "utf8", env: process.env });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(run("plan").sources[0].action, "create");
    assert.equal(await sourceDetail(next.id, context), null);
    assert.equal(run("apply").sources[0].action, "created");
    assert.equal(run("apply").sources[0].action, "preserve");
    assert.equal((await sourceDetail(next.id, context))!.source.enabled, false);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE actor = 'source-cli-test' AND subject = ${`source:${next.id}`}`)[0]!.n, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a source transaction rolled back at commit leaves no successful audit entry", async () => {
  await sql.unsafe(`CREATE FUNCTION refuse_admin_source_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name = 'refuse-admin-commit' THEN RAISE EXCEPTION 'refused at commit'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE CONSTRAINT TRIGGER refuse_admin_source_commit AFTER UPDATE ON sources
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_admin_source_commit()`);
  try {
    const [before] = await sql`SELECT updated_at FROM sources WHERE id = ${sourceId}`;
    await assert.rejects(updateSource(sourceId, { patch: { name: "refuse-admin-commit" }, version: (before!.updated_at as Date).toISOString() }, "test-rollback"), /refused at commit/);
    const rows = await sql`SELECT 1 FROM audit_log WHERE actor = 'test-rollback'`;
    assert.equal(rows.length, 0);
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_source_commit ON sources; DROP FUNCTION refuse_admin_source_commit()");
  }
});

test("content corrections, public projection and audit either commit together or remain retryable", async () => {
  const id = await article();
  await publishArticle(id);
  await sql.unsafe(`CREATE FUNCTION refuse_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'test-refuse-audit' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER refuse_admin_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_admin_audit()");
  try {
    for (const write of [
      () => overrideFields(id, { fields: { title: "更正标题" }, version: 0, reason: "校正" }, "test-refuse-audit"),
      () => setVisibility(id, { visibility: "withdrawn", version: 0, reason: "校正" }, "test-refuse-audit"),
    ]) {
      await assert.rejects(write(), /audit unavailable/);
      assert.equal((await sql`SELECT 1 FROM editorial_overrides WHERE article_id = ${id}`).length, 0);
      const [p] = await sql`SELECT title, visibility FROM publications WHERE article_id = ${id}`;
      assert.equal(p!.title, "审查材料");
      assert.equal(p!.visibility, "public");
    }
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_audit ON audit_log; DROP FUNCTION refuse_admin_audit()");
  }
  await overrideFields(id, { fields: { title: "更正标题" }, version: 0, reason: "校正" }, "test");
  await assert.rejects(setVisibility(id, { visibility: "withdrawn", version: 0, reason: "过期页面" }, "test"), { code: "conflict" });
  const [p] = await sql`SELECT title, visibility FROM publications WHERE article_id = ${id}`;
  assert.equal(p!.title, "更正标题");
  assert.equal(p!.visibility, "public");
});

test("repeating a completed command returns its job without resetting newer processing or a manual detach", async () => {
  await getBoss();
  for (const step of ["analyze", "extract", "group"] as const) {
    const id = await article();
    const key = `request-${step}-${T}`;
    const first = await rerun(id, step, key, "test");
    assert.ok(first?.jobId);
    await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE id = ${first.jobId}`;
    await sql`UPDATE articles SET processing_state = 'analyzed', revision = revision + 1 WHERE id = ${id}`;
    await sql`INSERT INTO grouping_overrides (article_id, reason, actor) VALUES (${id}, 'later manual detach', 'test')`;
    const again = await rerun(id, step, key, "test");
    assert.deepEqual(again, first);
    const [state] = await sql`SELECT processing_state FROM articles WHERE id = ${id}`;
    assert.equal(state!.processing_state, "analyzed");
    assert.equal((await sql`SELECT 1 FROM grouping_overrides WHERE article_id = ${id}`).length, 1);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE request_id = ${key}`).length, 1);
  }
});

test("a rejected SEO correction leaves both the decision and public indexing unchanged", async () => {
  const id = await article();
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, summary_zh, selected)
            VALUES (${id}, 1, 'rule', 'pass', '可收录的正文摘要', false)`;
  await publishArticle(id);
  const [before] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  await sql.unsafe(`CREATE FUNCTION refuse_admin_seo_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'test-refuse-seo' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER refuse_admin_seo_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_admin_seo_audit()");
  try {
    await assert.rejects(setSeoIndexed(id, { indexed: true, reason: "人工收录" }, "test-refuse-seo"), /audit unavailable/);
    const [after] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
    assert.deepEqual(after, before);
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_seo_audit ON audit_log; DROP FUNCTION refuse_admin_seo_audit()");
  }
  await setSeoIndexed(id, { indexed: true, reason: "人工收录" }, "test");
  const [indexed] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  assert.ok(indexed!.seo_indexed_at);
  assert.equal(indexed!.seo_excluded_at, null);
  assert.equal(indexed!.indexable, true);
  await setSeoIndexed(id, { indexed: false, reason: "取消收录" }, "test");
  const [excluded] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  assert.equal(excluded!.seo_indexed_at, null);
  assert.ok(excluded!.seo_excluded_at);
  assert.equal(excluded!.indexable, false);
});

test("bad admin input is a client error and never starts processing", async () => {
  const headers = await adminHeaders();
  const source = await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "bad" } });
  assert.equal(source.statusCode, 400);
  const id = await article();
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${id}`;
  const response = await app.inject({ method: "POST", url: `/api/admin/content/${id}/rerun`, headers, payload: { step: "typo" } });
  assert.equal(response.statusCode, 400);
  const [state] = await sql`SELECT processing_state FROM articles WHERE id = ${id}`;
  assert.equal(state!.processing_state, "analyzed");
});
