// A publisher can rename a JSON entry's URL while keeping its own stable ID. Collection must revise
// the first material, preserve historical duplicate rows, and never reuse another source's ID.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { defaultSpaceConfig, storeSpaceConfig } from "@aihot/backend/spaces/context";
import { cutoverSpaceIdentity } from "../scripts/space-cutover.ts";

const T = tag();
const published = new Date().toISOString();
let version = 1;
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify([{ id: "stable-entry", title: `Research version ${version}`, slug: `article-v${version}`, published }]));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

test("stable external IDs revise the first material after URL changes without merging sources or deleting legacy duplicates", async () => {
  const ids = ["one", "two"].map(name => `test-external-${name}-${T}`);
  for (const id of ids) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
      VALUES (${id}, ${id}, 'json_list', ${sql.json({ url: base, titlePaths: ["title"], externalIdPath: "id", urlTemplate: `https://example.org/${id}/{slug}`, publishedAtPath: "published" })},
      'T2', 'hot_signal', ${sql.json({ initializedAt: published })}, '2100-01-01')`;
  }
  assert.equal((await collectSource(ids[0]!, { force: true })).created, 1);
  const [first] = await sql<{ id: string; identity_key: string }[]>`SELECT id, identity_key FROM articles WHERE source_id = ${ids[0]!}`;
  // Found a minute ago: the legacy duplicate found next stays the later discovery even when the VM's clock steps back.
  await sql`UPDATE articles SET discovered_at = discovered_at - interval '1 minute' WHERE id = ${first!.id}`;
  await upsertMaterial({ sourceId: ids[0]!, url: `https://example.org/${ids[0]}/legacy-duplicate`, title: "Legacy duplicate", publishedAt: new Date(published), raw: { externalId: "stable-entry" }, via: "import" });
  version = 2;
  const run = await collectSource(ids[0]!, { force: true });
  assert.equal(run.created, 0);
  assert.equal(run.revised, 1);
  const rows = await sql<{ id: string; identity_key: string; title: string }[]>`SELECT id, identity_key, title FROM articles WHERE source_id = ${ids[0]!} ORDER BY discovered_at, id`;
  assert.equal(rows.length, 2, "the existing duplicate remains historical data");
  assert.deepEqual(rows[0], { ...first!, title: "Research version 2" });
  assert.equal((await collectSource(ids[1]!, { force: true })).created, 1, "the same upstream ID in another source is distinct");
  version = 3;
  assert.equal((await collectSource(ids[0]!, { force: true })).created, 0);
  assert.equal((await sql`SELECT id FROM articles WHERE source_id = ${ids[0]!}`).length, 2);
});

test("the same listing in two spaces keeps separate articles, cursors and fetch runs", async () => {
  await cutoverSpaceIdentity(sql);
  const sources = [];
  for (const name of ["a", "b"]) {
    const spaceId = `listing-${name}-${T}`;
    await sql`INSERT INTO spaces (id, slug) VALUES (${spaceId}, ${spaceId})`;
    const context = await storeSpaceConfig(spaceId, defaultSpaceConfig());
    await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${spaceId}`;
    const id = `source-${spaceId}`;
    await sql`INSERT INTO sources (id, space_id, name, kind, config, tier, participation_mode, cursor)
      VALUES (${id}, ${spaceId}, ${id}, 'json_list', ${sql.json({ url: base, titlePaths: ["title"], externalIdPath: "id", urlTemplate: "https://example.org/shared/{slug}", publishedAtPath: "published" })},
        'T2', 'hot_signal', ${sql.json({ initializedAt: published })})`;
    sources.push({ id, context });
  }
  version = 10;
  for (const source of sources) {
    assert.equal((await collectSource(source.id, { force: true, context: source.context })).created, 1);
    assert.equal((await collectSource(source.id, { force: true, context: source.context })).created, 0);
  }
  const [a, b] = sources;
  version = 11;
  assert.equal((await collectSource(a!.id, { force: true, context: a!.context })).revised, 1);
  const articles = await sql`SELECT id, space_id, revision FROM articles WHERE source_id IN ${sql(sources.map((s) => s.id))} ORDER BY space_id`;
  assert.equal(new Set(articles.map((r) => r.id)).size, 2);
  assert.deepEqual(articles.map((r) => [r.space_id, r.revision]), [[a!.context.spaceId, 2], [b!.context.spaceId, 1]]);
  assert.equal((await collectSource(b!.id, { force: true })).status, "skipped", "legacy collection cannot resolve another space's source");
  const runs = await sql`SELECT DISTINCT space_id, source_id FROM fetch_runs WHERE source_id IN ${sql(sources.map((s) => s.id))} ORDER BY space_id`;
  assert.deepEqual(runs.map((r) => [r.space_id, r.source_id]), sources.map((s) => [s.context.spaceId, s.id]));
});
