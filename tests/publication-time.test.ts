// An item whose original carries no reliable date keeps its public page, and no exit presents when it was
// collected as when it was published. Failure cases: the Markdown export labels the collection time
// "发布时间"; RSS gives the collection time as pubDate; a dated item loses its publication time.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import type { ItemAvailability, ItemSummary, PoolResponse, TimelineResponse } from "@aihot/contracts/site";
import { buildApp } from "../apps/api/src/app.ts";
import { contentChain } from "@aihot/backend/admin/content";

const T = tag();
const SOURCE = `pubtime-${T}`;
const discovered = new Date(Date.now() - 3600_000);
const published = new Date(Date.now() - 5 * 3600_000);
const day = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const midnight = `${day}T00:00:00.000Z`;
const precise = `${day}T13:47:32.000Z`;
const fixtures = {
  dated: { at: published, precision: null },
  undated: { at: null, precision: null },
  dateOnly: { at: new Date(midnight), precision: day },
  precise: { at: new Date(precise), precision: precise },
  midnight: { at: new Date(midnight), precision: midnight },
};
const ids = Object.fromEntries(Object.keys(fixtures).map(kind => [kind, `${T}-${kind}`])) as Record<keyof typeof fixtures, string>;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Publication time fixture', 'rss', 'T1')`;
  for (const [kind, id] of Object.entries(ids) as Array<[keyof typeof fixtures, string]>) {
    const { at, precision } = fixtures[kind];
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at, publication_time)
      VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.org/${id}`}, ${`${T} ${kind}`}, ${discovered}, ${discovered}, ${at}, ${precision})`;
    await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, published_at, sort_at,
        eligible, selected, visible_after, visibility, tags, summary)
      VALUES (${id}, ${`${T} ${kind}`}, ${SOURCE}, 'news', ${`https://example.org/${id}`}, ${discovered}, ${discovered}, ${at}, ${discovered},
        true, true, ${discovered}, 'public', ${[T]}, 'fixture summary')`;
  }
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, url);
  return res.body;
};

test("the Markdown export names the collection time as such when the publication time is unknown", async () => {
  const undated = await get(`/items/${ids.undated}/markdown`);
  assert.ok(undated.includes(`- 收录时间：${discovered.toISOString()}`));
  assert.ok(!undated.includes("发布时间"));
  assert.ok((await get(`/items/${ids.dated}/markdown`)).includes(`- 发布时间：${published.toISOString()}`));
});

test("article Markdown preserves day precision while retaining real and unknown-precision timestamps", async () => {
  const publishedLine = async (id: string) => (await get(`/items/${id}/markdown`)).split("\n").find((line) => line.startsWith("- 发布时间："));
  assert.equal(await publishedLine(ids.dateOnly), `- 发布时间：${day}`);
  assert.equal(await publishedLine(ids.midnight), `- 发布时间：${midnight}`);
  assert.equal(await publishedLine(ids.precise), `- 发布时间：${precise}`);
  assert.equal(await publishedLine(ids.dated), `- 发布时间：${published.toISOString()}`);
});

test("admin content diagnostics carry the original precision rather than guessing from midnight", async () => {
  for (const [kind, fixture] of Object.entries(fixtures) as Array<[keyof typeof fixtures, typeof fixtures[keyof typeof fixtures]]>) {
    const chain = await contentChain(ids[kind]);
    assert.equal(chain!.article.publication_time, fixture.precision, kind);
  }
});

test("RSS gives no pubDate for an item without a known publication time", async () => {
  const feed = await get("/feed/all.xml");
  const entry = (id: string) => feed.split("<item>").find((block) => block.includes(`>${id}</guid>`));
  assert.ok(entry(ids.undated) && !entry(ids.undated)!.includes("<pubDate>"));
  assert.ok(entry(ids.dated)!.includes(`<pubDate>${published.toUTCString()}</pubDate>`));
  assert.ok(entry(ids.dateOnly)!.includes(`<pubDate>${new Date(midnight).toUTCString()}</pubDate>`));
});

test("site detail, pool and selected cards carry the source's date precision without guessing from UTC midnight", async () => {
  const pool: PoolResponse = JSON.parse(await get(`/api/site/pool?tag=${T}`));
  const timeline: TimelineResponse = JSON.parse(await get(`/api/site/timeline?tag=${T}`));
  for (const [kind, fixture] of Object.entries(fixtures) as Array<[keyof typeof fixtures, typeof fixtures[keyof typeof fixtures]]>) {
    const id = ids[kind];
    const detail: ItemSummary = JSON.parse(await get(`/api/site/items/${id}`));
    const pooled = pool.items.find(item => item.id === id);
    const card = timeline.cards.find(card => card.item.id === id)?.item;
    assert.ok(pooled && card, `${kind} remains visible in both site lists`);
    for (const item of [detail, pooled, card]) {
      assert.equal(item.publicationTime, fixture.precision, kind);
      assert.equal(item.publishedAt, fixture.at?.toISOString() ?? null, kind);
    }
  }
  const v1 = JSON.parse(await get("/api/v1/items?mode=all"));
  const dated = v1.items.find((item: { id: string }) => item.id === ids.dateOnly);
  assert.ok(dated);
  assert.equal(dated.publishedAt, midnight, "the stable public API retains its publication instant");
  assert.equal(Object.hasOwn(dated, "publicationTime"), false, "the first-party display field does not alter v1");
});

test("saved articles recover current publication precision only while their pages remain public", async () => {
  const withdrawn = `${T}-withdrawn`;
  const missing = `${T}-missing`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at,published_at,publication_time)
    VALUES (${withdrawn},${SOURCE},${withdrawn},${`https://example.org/${withdrawn}`},'Withdrawn time',${discovered},${discovered},${new Date(midnight)},${day})`;
  await sql`INSERT INTO publications (article_id,title,source_id,channel,url,discovered_at,timeline_at,published_at,sort_at,visibility)
    VALUES (${withdrawn},'Withdrawn time',${SOURCE},'news',${`https://example.org/${withdrawn}`},${discovered},${discovered},${new Date(midnight)},${discovered},'withdrawn')`;
  const availability: Record<string, ItemAvailability> = JSON.parse(await get(`/api/site/items/availability?ids=${[...Object.values(ids), withdrawn, missing].join(",")}`));
  for (const [kind, fixture] of Object.entries(fixtures) as Array<[keyof typeof fixtures, typeof fixtures[keyof typeof fixtures]]>) {
    const item = availability[ids[kind]]!;
    assert.equal(item.status, "public", kind);
    assert.equal(item.publishedAt, fixture.at?.toISOString() ?? null, kind);
    assert.equal(item.publicationTime, fixture.precision, kind);
  }
  assert.deepEqual(availability[withdrawn], { status: "unavailable" });
  assert.deepEqual(availability[missing], { status: "unavailable" });
});
