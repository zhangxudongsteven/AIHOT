// A paused external source must not accept new reports or look healthy after a rejected push.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { IngestError, ingestItems } from "@aihot/backend/ingest/items";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { tag } from "./setup.ts";
import { defaultSpaceConfig, storeSpaceConfig } from "@aihot/backend/spaces/context";
import { cutoverSpaceIdentity } from "../scripts/space-cutover.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

test("a paused external source rejects pushed items without recording a successful fetch", async () => {
  const sourceId = `test-paused-ingest-${tag()}`;
  const lastOkAt = new Date("2026-09-01T00:00:00Z");
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, health, last_ok_at)
    VALUES (${sourceId}, 'Paused external source', 'external', '{}'::jsonb, 'T2', 'editorial', false, 'paused', ${lastOkAt})`;

  await assert.rejects(
    ingestItems({ sourceId, items: [{ title: "New report", url: `https://example.org/${sourceId}` }] }),
    (error: unknown) => error instanceof IngestError && error.status === 409,
  );

  const [source] = await sql<{ last_ok_at: Date }[]>`SELECT last_ok_at FROM sources WHERE id = ${sourceId}`;
  const [articles] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM articles WHERE source_id = ${sourceId}`;
  assert.equal(source!.last_ok_at.toISOString(), lastOkAt.toISOString());
  assert.equal(articles!.count, 0);

  await sql`UPDATE sources SET enabled = true WHERE id = ${sourceId}`;
  assert.deepEqual(await ingestItems({ sourceId, items: [{ title: "New report", url: `https://example.org/${sourceId}` }] }), { ok: true, created: 1 });
});

test("an externally reported calendar day stays date-only through storage", async () => {
  const sourceId = `test-date-ingest-${tag()}`;
  await ingestItems({ sourceId, items: [{ title: "Calendar day", url: `https://example.org/${sourceId}`, publishedAt: "2026-10-13" }] });
  const [row] = await sql`SELECT publication_time, published_at_claim FROM articles WHERE source_id=${sourceId}`;
  assert.equal(row!.publication_time, "2026-10-13");
  assert.equal(row!.published_at_claim.toISOString(), "2026-10-13T00:00:00.000Z");
});

test("ingest requires the source's space before touching its health or accepting items", async () => {
  await cutoverSpaceIdentity(sql);
  const spaceId = `ingest-space-${tag()}`;
  await sql`INSERT INTO spaces (id, slug) VALUES (${spaceId}, ${spaceId})`;
  const context = await storeSpaceConfig(spaceId, defaultSpaceConfig());
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${spaceId}`;
  const sourceId = `source-${spaceId}`;
  const item = { title: "Independent report", url: `https://example.org/${spaceId}` };
  await ingestItems({ sourceId, items: [item] }, context);
  const [before] = await sql`SELECT last_ok_at FROM sources WHERE id = ${sourceId}`;
  await assert.rejects(ingestItems({ sourceId, items: [{ ...item, title: "Forged default-space edit" }] }),
    (error: unknown) => error instanceof IngestError && error.status === 409);
  const [after] = await sql`SELECT last_ok_at FROM sources WHERE id = ${sourceId}`;
  assert.equal(after!.last_ok_at.getTime(), before!.last_ok_at.getTime());
  assert.equal((await ingestItems({ sourceId, items: [item] }, context)).created, 0);
  const defaultSource = `default-${tag()}`;
  assert.equal((await ingestItems({ sourceId: defaultSource, items: [item] })).created, 1);
  const articles = await sql`SELECT space_id, title FROM articles WHERE url = ${item.url} ORDER BY space_id`;
  assert.deepEqual(articles.map((r) => r.space_id).sort(), ["default", spaceId].sort());
  assert.ok(articles.every((r) => r.title === item.title));
});
