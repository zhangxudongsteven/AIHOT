// A database-contract experiment, deliberately independent of production config, migrations and jobs.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postgres from "postgres";

type Db = postgres.TransactionSql;
type Context = { spaceId: string; configVersion: number };
type Config = { rule_version: string; model_id: string; required_keyword: string };
type Article = { id: string; title: string; input_revision: number };
type Result = { id: string; request_id: string; decision: string; selected: boolean; rule_version: string; model_id: string };
const schemaSql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const security = { spaceId: "security", configVersion: 1 };
const hardware = { spaceId: "hardware", configVersion: 1 };

function localTestUrl(value: string | undefined): URL {
  if (!value) throw new Error("Explicit MULTI_SPACE_DATABASE_URL is required; .env and DATABASE_URL are not read");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || !url.username || url.search || url.hash
    || !/^[A-Za-z0-9_]+_(test|ci)$/.test(decodeURIComponent(url.pathname.slice(1)))) {
    throw new Error("Use an explicit loopback host, port, user and *_test or *_ci database; URL query/fragment overrides are forbidden");
  }
  return url;
}

async function inSchema(check: (db: Db) => Promise<void>): Promise<void> {
  const url = localTestUrl(process.env.MULTI_SPACE_DATABASE_URL);
  const db = postgres({
    host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port),
    database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), ssl: false, max: 1, connect_timeout: 5,
    connection: { application_name: "aihot-dev02-multi-space-proof" }, onnotice: () => {},
  });
  const rollback = new Error("Rollback the experiment, including its schema");
  const schema = `dev02_${randomUUID().replaceAll("-", "")}`;
  try {
    try {
      await db.begin(async (tx) => {
        await tx`CREATE SCHEMA ${tx(schema)}`;
        await tx`SELECT set_config('search_path', ${schema}, true)`;
        await tx.unsafe(schemaSql).simple();
        await tx`INSERT INTO spaces (id) VALUES ('security'), ('hardware')`;
        await tx`INSERT INTO space_configs (space_id, config_version, rule_version, model_id, required_keyword) VALUES
          ('security', 1, 'security-v1', 'local-rule-fixture', 'kernel'),
          ('hardware', 1, 'hardware-v1', 'local-rule-fixture', 'chip')`;
        await check(tx);
        // Even successful tests leave no schema, rows or changes to the existing application schema.
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    assert.equal((await db`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`).length, 0, "test schema was rolled back");
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function configuration(db: Db, ctx: Context): Promise<Config> {
  const [row] = await db<Config[]>`SELECT rule_version, model_id, required_keyword FROM space_configs
    WHERE space_id = ${ctx.spaceId} AND config_version = ${ctx.configVersion}`;
  if (!row) throw new Error("Unknown space or configuration version");
  return row;
}

async function ingest(db: Db, ctx: Context, url: string, title: string): Promise<string> {
  await configuration(db, ctx);
  const [inserted] = await db<{ id: string }[]>`INSERT INTO articles (id, space_id, canonical_url, title)
    VALUES (${randomUUID()}, ${ctx.spaceId}, ${url}, ${title})
    ON CONFLICT (space_id, canonical_url) DO NOTHING RETURNING id`;
  if (inserted) return inserted.id;
  const [existing] = await db<{ id: string }[]>`SELECT id FROM articles
    WHERE space_id = ${ctx.spaceId} AND canonical_url = ${url}`;
  return existing!.id;
}

async function analyze(db: Db, ctx: Context, articleId: string): Promise<Result> {
  const config = await configuration(db, ctx);
  const [article] = await db<Article[]>`SELECT id, title, input_revision FROM articles
    WHERE space_id = ${ctx.spaceId} AND id = ${articleId}`;
  if (!article) throw new Error("Article does not belong to this space");
  const requestId = createHash("sha256").update(JSON.stringify([
    ctx.spaceId, article.id, article.input_revision, ctx.configVersion,
    config.rule_version, config.model_id, article.title,
  ])).digest("hex");
  // This deterministic fixture makes opposing decisions from stored per-space policy. It is not an LLM.
  const selected = article.title.toLowerCase().includes(config.required_keyword.toLowerCase());
  const [inserted] = await db<Result[]>`INSERT INTO processing_results
    (id, space_id, article_id, input_revision, config_version, rule_version, model_id, request_id, decision, selected)
    VALUES (${randomUUID()}, ${ctx.spaceId}, ${article.id}, ${article.input_revision}, ${ctx.configVersion},
      ${config.rule_version}, ${config.model_id}, ${requestId}, ${selected ? "PASS" : "BLOCK"}, ${selected})
    ON CONFLICT (space_id, request_id) DO NOTHING RETURNING *`;
  if (inserted) return inserted;
  const [existing] = await db<Result[]>`SELECT * FROM processing_results
    WHERE space_id = ${ctx.spaceId} AND request_id = ${requestId}`;
  return existing!;
}

async function dailyReport(db: Db, ctx: Context, date: string): Promise<string> {
  await configuration(db, ctx);
  const id = randomUUID();
  await db`INSERT INTO reports (id, space_id, config_version, report_date)
    VALUES (${id}, ${ctx.spaceId}, ${ctx.configVersion}, ${date})`;
  await db`INSERT INTO report_items (space_id, report_id, article_id)
    SELECT a.space_id, ${id}, a.id FROM articles a JOIN processing_results p
      ON p.space_id = a.space_id AND p.article_id = a.id AND p.input_revision = a.input_revision
    WHERE a.space_id = ${ctx.spaceId} AND p.config_version = ${ctx.configVersion} AND p.selected`;
  return id;
}

async function queueReport(db: Db, ctx: Context, reportId: string): Promise<void> {
  await configuration(db, ctx);
  const [report] = await db`SELECT 1 FROM reports WHERE space_id = ${ctx.spaceId}
    AND config_version = ${ctx.configVersion} AND id = ${reportId}`;
  if (!report) throw new Error("Report does not belong to this space and configuration");
  const targets = await db<{ id: string }[]>`SELECT id FROM notify_targets WHERE space_id = ${ctx.spaceId}`;
  for (const target of targets) {
    await db`INSERT INTO deliveries (id, space_id, report_id, target_id, status)
      VALUES (${randomUUID()}, ${ctx.spaceId}, ${reportId}, ${target.id}, 'pending')
      ON CONFLICT (space_id, report_id, target_id) DO NOTHING`;
  }
}

async function rejectedByDatabase(db: Db, code: string, action: (savepoint: Db) => Promise<unknown>) {
  await assert.rejects(db.savepoint(action), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === code);
}

test("connection guard refuses missing, remote, non-test and URL override destinations", () => {
  assert.equal(localTestUrl("postgres://developer@127.0.0.1:55432/dev02_test").port, "55432");
  for (const value of [undefined, "postgres://developer@db.example:5432/dev02_test",
    "postgres://developer@127.0.0.1:55432/production", "postgres://developer@127.0.0.1/dev02_test",
    "postgres://developer@127.0.0.1:55432/dev02_test?host=db.example"]) {
    assert.throws(() => localTestUrl(value));
  }
});

test("the same URL deduplicates within a space and has independent decisions across spaces", async () => {
  await inSchema(async (db) => {
    const url = "https://example.invalid/kernel-bulletin";
    const first = await ingest(db, security, url, "Critical kernel bulletin");
    assert.equal(await ingest(db, security, url, "Critical kernel bulletin"), first);
    const second = await ingest(db, hardware, url, "Critical kernel bulletin");
    assert.notEqual(first, second);
    const selected = await analyze(db, security, first);
    const blocked = await analyze(db, hardware, second);
    assert.equal(selected.selected, true);
    assert.equal(blocked.decision, "BLOCK");
    assert.equal(blocked.selected, false);
    assert.notEqual(selected.request_id, blocked.request_id);
    assert.equal((await analyze(db, security, first)).id, selected.id);
    assert.equal((await db`SELECT id FROM articles`).length, 2);
    assert.equal((await db`SELECT id FROM processing_results`).length, 2);
    await assert.rejects(analyze(db, security, second), /does not belong/);
  });
});

test("configuration versions and input revisions produce new scoped requests without rewriting history", async () => {
  await inSchema(async (db) => {
    const id = await ingest(db, security, "https://example.invalid/revised", "Kernel patch");
    const first = await analyze(db, security, id);
    await db`INSERT INTO space_configs (space_id, config_version, rule_version, model_id, required_keyword)
      VALUES ('security', 2, 'security-v2', 'local-rule-fixture-v2', 'policy')`;
    const v2 = { ...security, configVersion: 2 };
    const changedConfig = await analyze(db, v2, id);
    assert.equal(first.selected, true);
    assert.equal(changedConfig.selected, false);
    assert.equal(changedConfig.rule_version, "security-v2");
    assert.equal(changedConfig.model_id, "local-rule-fixture-v2");
    assert.notEqual(changedConfig.request_id, first.request_id);
    await db`UPDATE articles SET title = 'Kernel policy update', input_revision = 2
      WHERE space_id = 'security' AND id = ${id}`;
    const changedInput = await analyze(db, v2, id);
    assert.equal(changedInput.selected, true);
    assert.notEqual(changedInput.request_id, changedConfig.request_id);
    const history = await db`SELECT input_revision, config_version, selected FROM processing_results
      WHERE space_id = 'security' AND article_id = ${id} ORDER BY input_revision, config_version`;
    assert.deepEqual(history.map((r) => [r.input_revision, r.config_version, r.selected]), [[1, 1, true], [1, 2, false], [2, 2, true]]);
  });
});

test("composite foreign keys reject cross-space content, policy, report and delivery associations", async () => {
  await inSchema(async (db) => {
    const article = await ingest(db, hardware, "https://example.invalid/chip", "Chip launch");
    const report = await dailyReport(db, security, "2026-10-23");
    const otherReport = await dailyReport(db, hardware, "2026-10-23");
    const target = randomUUID();
    await db`INSERT INTO notify_targets (id, space_id, sink_label) VALUES (${target}, 'hardware', 'hardware-local-sink')`;
    await rejectedByDatabase(db, "23503", (tx) => tx`INSERT INTO processing_results
      (id, space_id, article_id, input_revision, config_version, rule_version, model_id, request_id, decision, selected)
      VALUES (${randomUUID()}, 'security', ${article}, 1, 1, 'security-v1', 'local-rule-fixture', 'wrong-article', 'PASS', true)`);
    await rejectedByDatabase(db, "23503", (tx) => tx`INSERT INTO processing_results
      (id, space_id, article_id, input_revision, config_version, rule_version, model_id, request_id, decision, selected)
      VALUES (${randomUUID()}, 'hardware', ${article}, 1, 1, 'security-v1', 'local-rule-fixture', 'wrong-policy', 'PASS', true)`);
    await rejectedByDatabase(db, "23503", (tx) => tx`INSERT INTO report_items (space_id, report_id, article_id)
      VALUES ('security', ${report}, ${article})`);
    await rejectedByDatabase(db, "23503", (tx) => tx`INSERT INTO report_items (space_id, report_id, article_id)
      VALUES ('hardware', ${report}, ${article})`);
    await rejectedByDatabase(db, "23503", (tx) => tx`INSERT INTO deliveries (id, space_id, report_id, target_id, status)
      VALUES (${randomUUID()}, 'security', ${report}, ${target}, 'pending')`);
    await rejectedByDatabase(db, "23503", (tx) => tx`INSERT INTO deliveries (id, space_id, report_id, target_id, status)
      VALUES (${randomUUID()}, 'security', ${otherReport}, ${target}, 'pending')`);
  });
});

test("the same date yields two scoped reports and independent, deduplicated notification routes", async () => {
  await inSchema(async (db) => {
    for (const ctx of [security, hardware]) {
      const id = await ingest(db, ctx, "https://example.invalid/shared", "Kernel and chip update");
      await analyze(db, ctx, id);
      await db`INSERT INTO notify_targets (id, space_id, sink_label)
        VALUES (${randomUUID()}, ${ctx.spaceId}, ${`${ctx.spaceId}-local-sink`})`;
      const report = await dailyReport(db, ctx, "2026-10-23");
      await queueReport(db, ctx, report);
      await queueReport(db, ctx, report);
      await rejectedByDatabase(db, "23505", (tx) => dailyReport(tx, ctx, "2026-10-23"));
      const other = ctx.spaceId === security.spaceId ? hardware : security;
      await assert.rejects(queueReport(db, other, report), /does not belong/);
    }
    const routes = await db`SELECT d.space_id, t.sink_label, r.report_date::text AS date, a.space_id AS article_space
      FROM deliveries d JOIN notify_targets t ON (t.space_id, t.id) = (d.space_id, d.target_id)
      JOIN reports r ON (r.space_id, r.id) = (d.space_id, d.report_id)
      JOIN report_items ri ON (ri.space_id, ri.report_id) = (r.space_id, r.id)
      JOIN articles a ON (a.space_id, a.id) = (ri.space_id, ri.article_id) ORDER BY d.space_id`;
    assert.deepEqual(routes.map((r) => [r.space_id, r.sink_label, r.date, r.article_space]), [
      ["hardware", "hardware-local-sink", "2026-10-23", "hardware"],
      ["security", "security-local-sink", "2026-10-23", "security"],
    ]);
    assert.equal((await db`SELECT id FROM deliveries`).length, 2);
  });
});

test("unknown spaces and configuration versions fail instead of falling back to a global context", async () => {
  await inSchema(async (db) => {
    for (const ctx of [{ spaceId: "missing", configVersion: 1 }, { ...security, configVersion: 99 }]) {
      await assert.rejects(ingest(db, ctx, "https://example.invalid/unknown", "Kernel"), /Unknown space/);
      await assert.rejects(dailyReport(db, ctx, "2026-10-23"), /Unknown space/);
      await assert.rejects(queueReport(db, ctx, randomUUID()), /Unknown space/);
    }
    await rejectedByDatabase(db, "23503", (tx) => tx`INSERT INTO articles (id, space_id, canonical_url, title)
      VALUES (${randomUUID()}, 'missing', 'https://example.invalid/unknown', 'Kernel')`);
    assert.equal((await db`SELECT id FROM articles`).length, 0);
    assert.equal((await db`SELECT id FROM reports`).length, 0);
    assert.equal((await db`SELECT id FROM deliveries`).length, 0);
  });
});
