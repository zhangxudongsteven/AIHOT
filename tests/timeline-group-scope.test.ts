// Failure cases: a composite or mention folding into a fact; stale fact membership still folding;
// a future/withdrawn/unselected report affecting the anchor; filters choosing an anchor outside their
// own set; a later report moving a fact; equal-time standalone cards changing cursor order.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { loadStoryFollowups } from "@aihot/backend/publication/followups";
import { loadStoryDetail } from "@aihot/backend/publication/stories";

after(closeDb);

test("timeline grouping preserves evidence scope and filter-local anchors", async () => {
  const prefix = `timeline-scope-${tag()}`;
  const at = new Date("2026-01-01T00:00:00Z");
  const now = new Date(+at + 100_000);
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${prefix}, ${prefix}, 'rss', 'T1')`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${prefix}, ${prefix}) RETURNING id`;
  const add = async (suffix: string, seconds: number, options: { role?: string; scope?: string; channel?: string; visibility?: string; selected?: boolean; future?: boolean; missing?: boolean; standalone?: boolean } = {}) => {
    const id = `${prefix}-${suffix}`;
    const time = new Date(+at + seconds * 1000);
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES (${id}, ${prefix}, ${id}, ${`https://example.org/${id}`}, ${id}, ${time}, ${time})`;
    const [analysis] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id, input_revision, origin, output)
      VALUES (${id}, 1, 'rule', ${sql.json(options.scope ? { scope: options.scope } : {})}) RETURNING id`;
    await sql`INSERT INTO publications (article_id, source_id, analysis_id, title, url, discovered_at, timeline_at, sort_at, visible_after,
      selected, eligible, visibility, channel, tags, fact_id)
      VALUES (${id}, ${prefix}, ${analysis!.id}, ${id}, ${`https://example.org/${id}`}, ${time}, ${time}, ${time}, ${options.future ? new Date(+now + 1) : time},
        ${options.selected ?? true}, true, ${options.visibility ?? "public"}, ${options.channel ?? "news"}, ${[prefix]}, ${options.standalone ? null : fact!.id})`;
    if (!options.missing && !options.standalone) await sql`INSERT INTO fact_articles (fact_id, article_id, role)
      VALUES (${fact!.id}, ${id}, ${options.role ?? "report"})`;
    return id;
  };
  await add("old-report", 0);
  await add("x-report", 10, { channel: "x" });
  const standalone = [
    await add("composite", 20, { scope: "composite" }),
    await add("mention", 30, { role: "mention" }),
    await add("removed", 40, { missing: true }),
    await add("standalone-a", 50, { standalone: true }),
    await add("standalone-z", 50, { standalone: true }),
  ];
  await add("future", -50, { future: true });
  await add("withdrawn", -40, { visibility: "withdrawn" });
  await add("unselected", -30, { selected: false });
  const filters = { channel: "all" as const, category: null, tag: prefix, now };
  const full = await loadTimeline(filters);
  assert.deepEqual(full.cards.map(card => card.key), [...standalone.reverse().map(id => `a${id}`), `f${fact!.id}`]);
  assert.equal(full.cards.at(-1)!.anchorAt, at.toISOString());
  assert.deepEqual(new Set(full.cards.at(-1)!.group!.memberIds), new Set([`${prefix}-old-report`, `${prefix}-x-report`]));
  const filtered = await loadTimeline({ ...filters, channel: "x" });
  assert.deepEqual(filtered.cards.map(card => [card.key, card.anchorAt]), [[`f${fact!.id}`, new Date(+at + 10_000).toISOString()]]);
  const news = await loadTimeline({ ...filters, channel: "news" });
  assert.deepEqual(news.cards.find(card => card.key === `f${fact!.id}`)!.group!.memberIds, [`${prefix}-old-report`]);
  const paged = [];
  let cursor: string | null = null;
  do {
    const page = await loadTimeline({ ...filters, cursor, limit: 2 });
    paged.push(...page.cards);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(JSON.stringify(paged), JSON.stringify(full.cards));
});

test("public timelines retain the original date precision without borrowing the representative's time", async () => {
  const prefix = `timeline-dates-${tag()}`;
  const now = new Date("2026-01-06T12:00:00Z");
  const publicId = randomUUID();
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${prefix}, ${prefix}, 'rss', 'T2'),
    (${prefix + "-official"}, 'Official dates', 'rss', 'T1')`;
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title) VALUES (${publicId}, ${prefix}) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title, story_id)
    VALUES (${prefix}, ${prefix}, ${story!.id}) RETURNING id`;
  const add = async (suffix: string, published: string, precision: string | null, options: { official?: boolean; timeline?: string; ownFact?: boolean; selected?: boolean } = {}) => {
    const id = `${prefix}-${suffix}`;
    const source = options.official ? `${prefix}-official` : prefix;
    const timeline = new Date(options.timeline ?? published);
    const [own] = options.ownFact ? await sql<{ id: number }[]>`INSERT INTO facts (public_id, title, story_id)
      VALUES (${id}, ${id}, ${story!.id}) RETURNING id` : [fact!];
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at, publication_time)
      VALUES (${id}, ${source}, ${id}, ${`https://example.org/${id}`}, ${id}, ${timeline}, ${timeline}, ${new Date(published)}, ${precision})`;
    await sql`INSERT INTO publications (article_id, source_id, title, summary, url, discovered_at, timeline_at, published_at, sort_at, visible_after,
      selected, eligible, channel, tags, fact_id, story_id)
      VALUES (${id}, ${source}, ${id}, '日期精度摘要', ${`https://example.org/${id}`}, ${timeline}, ${timeline}, ${new Date(published)}, ${timeline}, ${timeline},
        ${options.selected ?? true}, true, 'news', ${[prefix]}, ${own!.id}, ${story!.id})`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${own!.id}, ${id}, 'report')`;
    return id;
  };
  const original = await add("date", "2026-01-01T00:00:00.000Z", "2026-01-01", { selected: false });
  const representative = await add("representative", "2026-01-02T03:15:00.000Z", "2026-01-02T03:15:00.000Z", { official: true });
  await sql`UPDATE publications SET sort_at = '2026-01-01T00:00:00Z' WHERE article_id = ${representative}`;
  const collected = await add("collected", "2026-01-03T00:00:00.000Z", "2026-01-03", { timeline: "2026-01-03T04:23:00.000Z", ownFact: true });
  const exact = await add("midnight", "2026-01-04T00:00:00.000Z", "2026-01-04T00:00:00.000Z", { ownFact: true });
  const date = await add("latest-date", "2026-01-05T00:00:00.000Z", "2026-01-05", { ownFact: true });
  const timeline = await loadTimeline({ channel: "all", category: null, tag: prefix, now });
  const group = timeline.cards.find((c) => c.item.id === representative)!;
  assert.equal(group.anchorAt, "2026-01-01T00:00:00.000Z");
  assert.equal(group.anchorTime, "2026-01-01", "the unselected original anchor supplies precision, rather than the later representative");
  assert.equal(timeline.cards.find((c) => c.item.id === exact)!.anchorTime, "2026-01-04T00:00:00.000Z", "an accurate midnight remains an accurate time");
  assert.equal(timeline.cards.find((c) => c.item.id === collected)!.anchorTime, "2026-01-03T04:23:00.000Z", "a real collection time keeps its clock");
  const reports = await loadGroupReports({ factPublicId: prefix, channel: "all", category: null, tag: prefix }, now);
  assert.equal(reports!.reports.find((r) => r.id === original)!.timelineTime, "2026-01-01");
  assert.equal(reports!.reports.find((r) => r.id === representative)!.timelineTime, "2026-01-02T03:15:00.000Z");
  const followups = await loadStoryFollowups(publicId, now);
  assert.equal(followups!.items.find((f) => f.representative.id === date)!.representative.timelineTime, "2026-01-05");
  assert.equal(followups!.items.find((f) => f.representative.id === collected)!.representative.timelineTime, "2026-01-03T04:23:00.000Z");
  const detail = await loadStoryDetail(story!.id, now);
  assert.equal(detail!.firstReportTime, "2026-01-01");
  assert.equal(detail!.latestTime, "2026-01-05");
  assert.equal(detail!.timeline.find((r) => r.id === date)!.publicationTime, "2026-01-05");
  assert.equal(detail!.timeline.find((r) => r.id === exact)!.publicationTime, "2026-01-04T00:00:00.000Z");
  assert.equal(detail!.developments.find((d) => d.representative.id === representative)!.firstReportTime, "2026-01-01");
});
