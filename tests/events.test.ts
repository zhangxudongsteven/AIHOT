// Event grouping invariants: an editor's decision made while the model is deciding stands; a
// revision keeps its membership without asking the model; an explicit regroup drops the automatic
// membership at once and decides again; a story's root is its earliest fact that still holds reports;
// two stories a report ties together merge only when both models see one story in their roots.
import { embeddingsStub, gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { detachFromFact, requestRegroup, moveToFact } from "@aihot/backend/events/corrections";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { consolidate, linkRelatedStories } from "@aihot/backend/events/consolidate";
import { groupArticle, recordSignal } from "@aihot/backend/events/group";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { candidateViews, recallFacts, relatedPosts } from "@aihot/backend/events/recall";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { defaultSpaceConfig, storeSpaceConfig, resolveSpaceContext, type SpaceContext } from "@aihot/backend/spaces/context";
import { cutoverSpaceIdentity } from "../scripts/space-cutover.ts";
import { composeStoryDigest } from "@aihot/backend/events/digest";
import { computeHotRanking, heatRows, heatSeries, snapshotHeat, storedHotRanking } from "@aihot/backend/events/hot";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const SOURCE = `test-events-${T}`;
const FACT_TITLE = `测试事件${T}发布新模型`;

// The model calls the first candidate the same occurrence (and, asked about a pair, agrees), but
// only once the test lets it answer; the same stub serves the judge and the review model.
let hold = gate();
let asked = gate();
type Rel = "SAME_OCCURRENCE" | "SAME_STORY" | "UNRELATED" | "ROUNDUP";
let relation: Rel = "SAME_OCCURRENCE";
/** What the pair prompt answers when it differs from the batch answer. */
let pairRelation: Rel | null = null;
/** Answer every candidate of a batch prompt, not only the first. */
let answerAll = false;
const provider = await stub(async (_hit, req) => {
  asked.open();
  await hold.promise;
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages[1]!.content;
  if (user.includes("事件当前标题：")) return { id: "stub-digest", choices: [{ message: { content: JSON.stringify({ title: "", digest: "测试频道独立事件综述，只引用本频道资料。" }) } }], usage: { total_tokens: 20 } };
  const pair = user.includes("报道 A");
  const ids = [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => m[1]!);
  const answer = pair
    ? { a: "发布", b: "发布", relation: pairRelation ?? relation, difference: "", confidence: 0.95 }
    : { query: "发布新模型", decisions: ids.map((id, index) => ({ id, relation: answerAll || index === 0 ? relation : "UNRELATED", confidence: 0.95, note: "" })), selection: { addsValue: true, reason: "fixture news" } };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
for (const name of ["DEEPSEEK", "XIAOMI_MIMO"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "test-key";
}
const embeddings = await embeddingsStub();

let storyId: number;
let factId: number;

/**
 * A text that shares no character with any other report of the run: the embeddings stub compares
 * character pairs, and sixteen random capitals shared enough pairs with an earlier test's report now
 * and then to be recalled. CJK Extension A, which no fixed text here uses, each character drawn once.
 */
const drawn = new Set<number>();
function randomText() {
  const chars: number[] = [];
  while (chars.length < 16) {
    const c = 0x3400 + Math.floor(Math.random() * 0x19c0);
    if (drawn.has(c)) continue;
    drawn.add(c);
    chars.push(c);
  }
  return String.fromCharCode(...chars);
}

async function report(suffix: string, title = FACT_TITLE, summary = "摘要", publishedAt = new Date()) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/events-${T}-${suffix}`, title: `Model launch ${T} ${suffix}`, bodyText: "A new model.", bodyStatus: "ok", via: "fetch", publishedAt,
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${title}, ${summary}, 80, false, ${sql.json({ fact: { title, subject: "测试", action: "发布", object: "模型" } })})`;
  await publishArticle(articleId);
  return articleId;
}

async function setScope(articleId: string, scope: "single" | "composite", fact: Record<string, unknown> | null = null) {
  await sql`UPDATE analyses SET output = output || ${sql.json({ scope, ...(fact ? { fact } : {}) } as never)} WHERE article_id = ${articleId}`;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test events', 'rss', 'T1', 'editorial', '2100-01-01')`;
  // An existing fact with one report: the candidate every later report meets.
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${FACT_TITLE}, now(), now()) RETURNING id`;
  storyId = story!.id;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}`}, ${storyId}, ${FACT_TITLE}) RETURNING id`;
  factId = fact!.id;
  const first = await report("first");
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${first}, 'report')`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${storyId}, ${first}, ${`source:${SOURCE}`}, ${SOURCE}, 'editorial', now())`;
});
after(async () => {
  await provider.close();
  await embeddings.close();
  await stopBoss();
  await closeDb();
});

test("explicitly insufficient original material cannot found an event or retain an automatic fact", async () => {
  const id = await report("title-only");
  await sql`UPDATE articles SET body_text = NULL, excerpt = NULL WHERE id = ${id}`;
  await sql`UPDATE analyses SET output = ${sql.json({ scope: "unknown", fact: null })} WHERE article_id = ${id}`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${id}, 'report')`;
  await publishArticle(id);
  const hits = provider.hits();
  assert.equal((await groupArticle(id)).verdict, "standalone");
  assert.equal(provider.hits(), hits, "known missing material needs no paid identity judgement");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${id}`).length, 0);
  const [publication] = await sql`SELECT fact_id, story_id FROM publications WHERE article_id = ${id}`;
  assert.deepEqual({ ...publication }, { fact_id: null, story_id: null });
});

test("a detach made while the model is deciding the report's fact stands", async () => {
  const id = await report("race");
  const grouping = groupArticle(id);
  await Promise.race([asked.promise, grouping.then(() => assert.fail("grouping ended without asking the model"))]);
  await detachFromFact(id, "wrong fact", "test");
  hold.open();
  const result = await grouping;

  assert.equal(result.verdict, "manual");
  const memberships = await sql`SELECT fact_id FROM fact_articles WHERE article_id = ${id}`;
  assert.equal(memberships.length, 0, "the report is not attached again");
  const signals = await sql`SELECT story_id FROM story_signals WHERE article_id = ${id}`;
  assert.equal(signals.length, 0, "no heat evidence is written back to the story");
  const [publication] = await sql<{ fact_id: number | null; story_id: number | null }[]>`SELECT fact_id, story_id FROM publications WHERE article_id = ${id}`;
  assert.deepEqual({ ...publication }, { fact_id: null, story_id: null }, "it is shown on its own");
});

test("a report joins the fact the model names, and a revision keeps that membership without asking again", async () => {
  hold = gate();
  hold.open();
  const id = await report("second");
  const first = await groupArticle(id);
  assert.equal(first.verdict, "same-fact");
  assert.equal(first.factId, factId);
  const hits = provider.hits();

  // A revision sends the report through grouping again: nothing to decide, nothing to pay.
  const again = await groupArticle(id);
  assert.equal(again.verdict, "kept");
  assert.equal(again.factId, factId);
  assert.equal(provider.hits(), hits, "the model is not asked about a report that already has its fact");
  const memberships = await sql<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${id}`;
  assert.deepEqual(memberships.map((m) => Number(m.fact_id)), [factId]);
  const [publication] = await sql<{ fact_id: number | null; story_id: number | null }[]>`SELECT fact_id, story_id FROM publications WHERE article_id = ${id}`;
  assert.deepEqual({ fact_id: Number(publication!.fact_id), story_id: Number(publication!.story_id) }, { fact_id: factId, story_id: storyId });
});

test("an explicit regroup drops the automatic membership and decides again", async () => {
  hold = gate();
  hold.open();
  const id = await report("third");
  assert.equal((await groupArticle(id)).verdict, "same-fact");

  await requestRegroup(id, `third-${T}`);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${id}`).length, 0, "until it is decided again it is evidence for no fact");
  // The same candidates and text reuse the paid verdict (receipts); the decision is still made again.
  const regrouped = await groupArticle(id);
  assert.equal(regrouped.verdict, "same-fact");
  assert.equal(regrouped.factId, factId);
  const decisions = await sql<{ verdict: string }[]>`SELECT verdict FROM grouping_decisions WHERE article_id = ${id} ORDER BY id`;
  assert.deepEqual(decisions.map((d) => d.verdict), ["same-fact", "same-fact"], "an explicit regroup decides again");
  const memberships = await sql<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${id}`;
  assert.equal(memberships.length, 1, "the report has exactly one membership after the regroup");
  const signals = await sql<{ story_id: number }[]>`SELECT story_id FROM story_signals WHERE article_id = ${id}`;
  assert.deepEqual(signals.map((s) => Number(s.story_id)), [storyId]);
});

test("a development attaches to the story's earliest fact that still holds reports", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  // A story whose first fact was emptied (a regroup, a detach, or a merge carried it over).
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${text}, now(), now()) RETURNING id`;
  await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${`fe-${T}`}, ${story!.id}, 'emptied')`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fr-${T}`}, ${story!.id}, ${text}) RETURNING id`;
  const first = await report("root", text, text);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${first}, 'report')`;

  relation = "SAME_STORY";
  try {
    const development = await report("development", text, text);
    const result = await groupArticle(development);
    assert.equal(result.verdict, "new-fact-in-story");
    assert.equal(result.storyId, Number(story!.id));
  } finally {
    relation = "SAME_OCCURRENCE";
  }
});


/** A story whose only fact holds one report with the given text, published at `publishedAt`. */
async function storyWithRoot(text: string, suffix: string, publishedAt = new Date()) {
  const [story] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${text}, now(), now()) RETURNING id, public_id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fs-${suffix}-${T}`}, ${story!.id}, ${text}) RETURNING id`;
  const article = await report(suffix, text, text, publishedAt);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${article}, 'report')`;
  return { storyId: Number(story!.id), publicId: String(story!.public_id), factId: Number(fact!.id), articleId: article };
}

// Failure cases before changing the writer: a merge during judgement can strand either a signal or
// a newly created fact; a signal-only detach can leave evidence because it has no fact membership.
for (const relationToRoot of ["SAME_OCCURRENCE", "SAME_STORY"] as const) {
  test(`a ${relationToRoot} decision made before a merge is retried without writing into the retired story`, async () => {
    const text = randomText();
    const from = await storyWithRoot(text, `merge-race-${relationToRoot}`);
    const into = await storyWithRoot(randomText(), `merge-target-${relationToRoot}`);
    const id = await report(`merge-query-${relationToRoot}`, text, text);
    relation = relationToRoot;
    hold = gate(); asked = gate();
    const pending = groupArticle(id);
    await Promise.race([asked.promise, pending.then(() => assert.fail("expected a model decision"))]);
    try {
      await mergeStoryInto(from.storyId, into.storyId, "editor merge during grouping", "test-editor");
    } finally { hold.open(); }
    try {
      await assert.rejects(pending, /changed.*retry/i);
      assert.equal((await sql`SELECT 1 FROM facts WHERE story_id = ${from.storyId}`).length, 0);
      assert.equal((await sql`SELECT 1 FROM story_signals WHERE story_id = ${from.storyId}`).length, 0);
      const retried = await groupArticle(id);
      assert.equal(retried.storyId, into.storyId);
      assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${id} AND story_id = ${into.storyId}`).length, 1);
    } finally { relation = "SAME_OCCURRENCE"; }
  });
}

test("detaching a discussion post removes its signal even though it has no fact membership", async () => {
  const root = await storyWithRoot(randomText(), "signal-detach-root");
  await sql`UPDATE articles SET identity_key = 'x:999000111' WHERE id = ${root.articleId}`;
  const source = `${SOURCE}-discussion`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${source},'Discussion','x_search','T2','hot_signal')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: "https://x.com/example/status/999000112", title: "Reaction",
    publishedAt: new Date(), bodyText: "Reaction", bodyStatus: "ok", via: "fetch",
    xPost: { tweetId: "999000112", handle: "example", authorName: "Example", text: "Reaction", replyTo: "999000111" } });
  assert.equal((await groupArticle(articleId, { signalOnly: true })).storyId, root.storyId);
  await detachFromFact(articleId, "unrelated reaction", "test-editor");
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${articleId}`).length, 0);
  assert.equal((await groupArticle(articleId, { signalOnly: true })).verdict, "manual");
});

test("a manual detach during a discussion judgement wins just as it does for an editorial report", async () => {
  // The post shares most of a story's wording: recalled, but not close enough to attach without a judgement.
  const text = randomText() + randomText();
  await storyWithRoot(text, "signal-race-root");
  const reaction = text.slice(0, 26) + randomText().slice(0, 6);
  const source = `${SOURCE}-discussion-race`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${source},'Discussion race','rss','T2','hot_signal')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`, title: reaction,
    publishedAt: new Date(), bodyText: reaction, bodyStatus: "ok", via: "fetch" });
  hold = gate(); asked = gate();
  const pending = groupArticle(articleId, { signalOnly: true });
  await Promise.race([asked.promise, pending.then(() => assert.fail("expected a signal judgement"))]);
  try {
    await detachFromFact(articleId, "unrelated reaction", "test-editor");
  } finally { hold.open(); }
  assert.equal((await pending).verdict, "manual");
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${articleId}`).length, 0);
});

// Facts store date-only input at Beijing midnight: a UTC conversion must not shift it a day back,
// and a malformed or impossible model date must neither abort grouping nor silently roll forward.
test("fact dates survive candidate recall without a timezone shift and invalid dates stay unknown", async () => {
  hold = gate(); hold.open();
  for (const date of ["2026-09-30", "2026-13-01", "2026-02-30"]) {
    const text = randomText();
    const id = await report(`fact-date-${date}`, text, text);
    await sql`UPDATE analyses SET output = jsonb_set(output, '{fact,occurredAt}', ${sql.json(date)}) WHERE article_id = ${id}`;
    const grouped = await groupArticle(id);
    const [candidate] = await candidateViews([{ factId: grouped.factId!, storyId: grouped.storyId!, factTitle: text, score: 1 }]);
    assert.equal(candidate!.report.frame!.occurredAt, date === "2026-09-30" ? date : null);
  }
});

test("a composite first, with no candidates, stays standalone and cannot become the later single report's root", async () => {
  hold = gate(); hold.open();
  const text = randomText();
  const composite = await report("composite-first", text, text);
  await setScope(composite, "composite");
  const hits = provider.hits();
  const first = await groupArticle(composite);
  assert.deepEqual(first, { verdict: "roundup" });
  assert.equal(provider.hits(), hits, "without candidates no identity call is needed");
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${composite}`).length, 0);

  const single = await report("single-after-composite", text, text);
  await setScope(single, "single");
  const second = await groupArticle(single);
  assert.equal(second.verdict, "new-story");
  assert.equal(provider.hits(), hits, "the composite is not recalled as a fact");
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${composite}`).length, 0);
});

test("a composite arriving after independent products only mentions them even when the model calls both the same occurrence", async () => {
  hold = gate(); hold.open();
  const text = randomText();
  const one = await storyWithRoot(`${text}甲`, "composite-product-a");
  const two = await storyWithRoot(`${text}乙`, "composite-product-b");
  const id = await report("composite-last", text, text);
  await setScope(id, "composite");
  answerAll = true;
  try {
    const hits = provider.hits();
    assert.deepEqual(await groupArticle(id), { verdict: "roundup" });
    assert.equal(provider.hits() - hits, 1, "one batch call, no pair review or consolidation");
    const memberships = await sql<{ fact_id: number; role: string }[]>`SELECT fact_id, role FROM fact_articles WHERE article_id = ${id} ORDER BY fact_id`;
    assert.deepEqual(memberships.map((r) => [Number(r.fact_id), r.role]), [[one.factId, "mention"], [two.factId, "mention"]]);
    assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${id}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM stories WHERE id IN (${one.storyId}, ${two.storyId}) AND merged_into IS NOT NULL`).length, 0);
    const [p] = await sql`SELECT fact_id, story_id FROM publications WHERE article_id = ${id}`;
    assert.deepEqual({ ...p }, { fact_id: null, story_id: null });
  } finally { answerAll = false; }
});

test("a newly identified composite loses automatic membership and cannot serve as an old root or redirect bridge", async () => {
  hold = gate(); hold.open();
  const text = randomText();
  const old = await storyWithRoot(text, "old-composite-root");
  await setScope(old.articleId, "composite");
  const actual = await storyWithRoot(text, "actual-product-root");
  const hits = provider.hits();
  assert.deepEqual(await consolidate([old.storyId, actual.storyId]), []);
  assert.equal(provider.hits(), hits, "known composite is not root evidence even before repair");
  const result = await groupArticle(old.articleId);
  assert.equal(result.verdict, "roundup", "a normal grouping pass does not keep a newly identified composite");
  const memberships = await sql<{ fact_id: number; role: string }[]>`SELECT fact_id, role FROM fact_articles WHERE article_id = ${old.articleId}`;
  assert.deepEqual(memberships.map((r) => [Number(r.fact_id), r.role]), [[actual.factId, "mention"]]);
  const [story] = await sql`SELECT merged_into FROM stories WHERE id = ${old.storyId}`;
  assert.equal(story!.merged_into, null, "removing a composite does not redirect its empty story into one mentioned product");
});

test("composite classification never deletes an editor's explicit membership", async () => {
  const kept = await storyWithRoot(randomText(), "manual-composite");
  await sql`UPDATE fact_articles SET manual = true WHERE article_id = ${kept.articleId}`;
  await setScope(kept.articleId, "composite");
  const hits = provider.hits();
  await requestRegroup(kept.articleId, `manual-composite-${T}`);
  assert.deepEqual(await groupArticle(kept.articleId), { verdict: "manual", factId: kept.factId });
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${kept.articleId} AND manual`).length, 1);
});

test("ROUNDUP answers describe a pair, not the single query's identity; grounded conditions reach its new fact", async () => {
  hold = gate(); hold.open();
  const text = randomText();
  await storyWithRoot(text, "roundup-pair-candidate");
  const id = await report("single-roundup-pair", text, text);
  await setScope(id, "single", { title: text, subject: "测试", action: "发布", object: "模型", evidence: "A new model.", conditions: [{ text: "仅预览用户", quote: "Preview users only." }] });
  relation = "ROUNDUP";
  try {
    const result = await groupArticle(id);
    assert.equal(result.verdict, "new-story", "candidate roundup relation cannot reclassify the query");
    const [fact] = await sql`SELECT conditions FROM facts WHERE id = ${result.factId!}`;
    assert.equal(fact!.conditions, "仅预览用户");
    const [membership] = await sql`SELECT role, evidence FROM fact_articles WHERE article_id = ${id}`;
    assert.equal(membership!.role, "primary", "T1 comes from tier even when old source.first_party is false");
    assert.equal(membership!.evidence, "A new model.\nPreview users only.");
  } finally { relation = "SAME_OCCURRENCE"; }
});

test("a story's root is the fact reported first, not the one with the lowest number", async () => {
  hold = gate();
  hold.open();
  const early = randomText(), late = randomText();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${early}, now(), now()) RETURNING id`;
  // Created first (lower id), reported later: a fact carried over from a merged or imported story.
  const [later] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`ft-late-${T}`}, ${story!.id}, ${late}) RETURNING id`;
  const [first] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`ft-early-${T}`}, ${story!.id}, ${early}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${later!.id}, ${await report("late-fact", late, late)}, 'report')`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${first!.id}, ${await report("early-fact", early, early, new Date(Date.now() - 2 * 3600_000))}, 'report')`;

  // A development of the fact reported first joins the story through it.
  relation = "SAME_STORY";
  try {
    const result = await groupArticle(await report("follow-up", early, early));
    assert.equal(result.verdict, "new-fact-in-story");
    assert.equal(result.storyId, Number(story!.id));
  } finally {
    relation = "SAME_OCCURRENCE";
  }
});

test("two stories a report ties together merge when both models see one story in their roots", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  // Published a minute apart: which story is older does not depend on the VM's clock never stepping back.
  const older = await storyWithRoot(`${text}甲`, "older", new Date(Date.now() - 120_000));
  const newer = await storyWithRoot(`${text}乙`, "newer", new Date(Date.now() - 60_000));
  relation = "SAME_STORY";
  answerAll = true;
  try {
    const result = await groupArticle(await report("bridge", text, text));
    assert.equal(result.verdict, "new-fact-in-story");
    assert.deepEqual(result.consolidated?.map((c) => [c.from, c.into, c.merge]), [[newer.storyId, older.storyId, true]]);
    assert.equal(result.storyId, older.storyId, "the report ends up in the surviving story");
    const [merged] = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id = ${newer.storyId}`;
    assert.equal(Number(merged!.merged_into), older.storyId);
    const [alias] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_aliases WHERE public_id = ${newer.publicId}`;
    assert.equal(Number(alias!.story_id), older.storyId, "the merged story's public id keeps answering");
  } finally {
    relation = "SAME_OCCURRENCE";
    answerAll = false;
  }
});

test("editor-confirmed identities skip automatic comparison and merging, while explicit editor merges work", async () => {
  const one = await storyWithRoot(randomText(), "manual-one");
  const two = await storyWithRoot(randomText(), "manual-two");
  await sql`UPDATE stories SET origin = 'manual' WHERE id = ${one.storyId}`;
  const hits = provider.hits();
  assert.deepEqual(await consolidate([one.storyId, two.storyId]), []);
  assert.equal(provider.hits(), hits, "no paid comparison can undo an editor-confirmed identity");
  assert.equal(await mergeStoryInto(one.storyId, two.storyId, "automatic", "grouping"), null);
  assert.equal(await mergeStoryInto(two.storyId, one.storyId, "automatic", "grouping"), null);
  assert.ok(await mergeStoryInto(two.storyId, one.storyId, "editor explicitly confirmed", "test-editor"));
  const [merged] = await sql`SELECT merged_into FROM stories WHERE id = ${two.storyId}`;
  assert.equal(Number(merged!.merged_into), one.storyId);
});

test("an editor identity correction during comparison prevents merging and is not reported as a successful merge", async () => {
  const one = await storyWithRoot(randomText(), "manual-race-one");
  const two = await storyWithRoot(randomText(), "manual-race-two");
  hold = gate(); asked = gate();
  const pending = consolidate([one.storyId, two.storyId]);
  await Promise.race([asked.promise, pending.then(() => assert.fail("comparison ended without asking"))]);
  await sql`UPDATE stories SET origin = 'manual' WHERE id = ${one.storyId}`;
  hold.open();
  const result = await pending;
  assert.equal(result.length, 1);
  assert.equal(result[0]!.merge, false);
  const rows = await sql`SELECT merged_into FROM stories WHERE id IN (${one.storyId}, ${two.storyId})`;
  assert.deepEqual(rows.map((row) => row.merged_into), [null, null]);
});

test("two stories stay apart when their roots are different events, whatever the report ties them with", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  const one = await storyWithRoot(`${text}甲`, "one", new Date(Date.now() - 120_000));
  const two = await storyWithRoot(`${text}乙`, "two", new Date(Date.now() - 60_000));
  relation = "SAME_STORY";
  pairRelation = "UNRELATED";
  answerAll = true;
  try {
    const result = await groupArticle(await report("comparison", text, text));
    assert.deepEqual(result.consolidated?.map((c) => [c.from, c.into, c.merge, c.second]), [[two.storyId, one.storyId, false, null]]);
    const rows = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id IN (${one.storyId}, ${two.storyId})`;
    assert.deepEqual(rows.map((r) => r.merged_into), [null, null]);
  } finally {
    relation = "SAME_OCCURRENCE";
    pairRelation = null;
    answerAll = false;
  }
});

test("a story whose reports all moved away keeps its address: it redirects to where the last one went", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  const old = await storyWithRoot(text, "moving");
  // A second report of the old story, about something no other report mentions.
  const other = randomText();
  const staying = await report("staying", other, other);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${old.factId}, ${staying}, 'report')`;
  // With the decision that put it there, as grouping records one with every membership it writes.
  await sql`INSERT INTO grouping_decisions (article_id, fact_id, story_id, verdict) VALUES (${staying}, ${old.factId}, ${old.storyId}, 'same-fact')`;
  const target = await storyWithRoot(text, "target");

  // The first report moves to the story it belongs to; the old story still has a report and stays.
  await requestRegroup(old.articleId, `moving-${T}`);
  const moved = await groupArticle(old.articleId);
  assert.equal(moved.verdict, "same-fact");
  assert.equal(moved.storyId, target.storyId);
  assert.equal(moved.redirected, undefined);

  // The last one leaves too: the old story redirects to where it went.
  await requestRegroup(staying, `staying-${T}`);
  const last = await groupArticle(staying);
  assert.equal(last.verdict, "new-story");
  assert.deepEqual(last.redirected, [old.storyId]);
  const [alias] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_aliases WHERE public_id = ${old.publicId}`;
  assert.equal(Number(alias!.story_id), last.storyId, "the old public id answers with the story its last report went to");
});

test("stories that reports keep tying together without merging list each other as related", async () => {
  hold = gate();
  hold.open();
  const text = randomText();
  const one = await storyWithRoot(`${text}甲`, "related-one");
  const two = await storyWithRoot(`${text}乙`, "related-two");
  const links = async () =>
    (await sql<{ story_id: number; other_id: number; relation: string }[]>`
      SELECT story_id, other_id, relation FROM story_links WHERE story_id IN (${one.storyId}, ${two.storyId}) ORDER BY story_id`)
      .map((l) => [Number(l.story_id), Number(l.other_id), l.relation]);
  // Each report is a development of both stories; their roots are different events, so they stay apart.
  relation = "SAME_STORY";
  pairRelation = "UNRELATED";
  answerAll = true;
  try {
    await groupArticle(await report("tie-one", text, text));
    await linkRelatedStories();
    assert.deepEqual(await links(), [], "one report is not enough");

    await groupArticle(await report("tie-two", text, text));
    await linkRelatedStories();
    assert.deepEqual(await links(), [[one.storyId, two.storyId, "related"], [two.storyId, one.storyId, "related"]]);
  } finally {
    relation = "SAME_OCCURRENCE";
    pairRelation = null;
    answerAll = false;
  }
});


async function testSpace(suffix: string): Promise<SpaceContext> {
  const id = `events-${T}-${suffix}`;
  await sql`INSERT INTO spaces (id, slug, enabled) VALUES (${id}, ${id}, true)`;
  const context = await storeSpaceConfig(id, defaultSpaceConfig());
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${id}`;
  await sql`INSERT INTO sources (id, space_id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${id}, ${id}, 'Scoped event fixture', 'rss', 'T1', 'editorial', '2100-01-01')`;
  return resolveSpaceContext(id);
}

async function scopedReport(context: SpaceContext, url: string, title: string) {
  const { articleId } = await upsertMaterial({ sourceId: context.spaceId, url, title, bodyText: title, bodyStatus: "ok", via: "fetch", publishedAt: new Date() }, sql, context);
  await sql`INSERT INTO analyses (space_id, config_version, article_id, input_revision, processing_generation, origin, relevance, category, title_zh, summary_zh, score, selected, output)
    VALUES (${context.spaceId}, ${context.configVersion}, ${articleId}, 1, 0, 'rule', 'pass', 'ai-models', ${title}, ${title}, 80, false,
      ${sql.json({ scope: "single", fact: { title, subject: "fixture", action: "release", object: title } })})`;
  await publishArticle(articleId);
  return articleId;
}

test("same URL and identical reports retain independent facts, recall and paid grouping in two spaces", async () => {
  hold.open();
  relation = "SAME_OCCURRENCE";
  pairRelation = null;
  answerAll = false;
  await cutoverSpaceIdentity(sql);
  const a = await testSpace("a");
  const b = await testSpace("b");
  const title = randomText();
  const url = `https://example.invalid/${T}/same-page`;
  const aid = await scopedReport(a, url, title);
  const bid = await scopedReport(b, url, title);
  assert.notEqual(aid, bid);
  const firstA = await groupArticle(aid, { context: a });
  const firstB = await groupArticle(bid, { context: b });
  assert.equal(firstA.verdict, "new-story");
  assert.equal(firstB.verdict, "new-story");
  assert.notEqual(firstA.factId, firstB.factId);
  assert.notEqual(firstA.storyId, firstB.storyId);
  const at = new Date();
  const scopedHeat = await heatRows(at, [], undefined, { context: a });
  assert.ok(scopedHeat.some(row => row.story_id === firstA.storyId));
  assert.equal(scopedHeat.some(row => row.story_id === firstB.storyId), false);
  await snapshotHeat(at, { context: a });
  assert.deepEqual(await heatSeries(firstB.storyId!, at, 7, { context: a }), []);
  const publicRanking = await storedHotRanking();
  const ranking = await computeHotRanking(at, { context: a });
  assert.equal((await storedHotRanking(sql, { context: a }))?.id, ranking.id);
  assert.deepEqual(await storedHotRanking(), publicRanking, "an internal ranking never replaces the default ranking");
  assert.equal((await composeStoryDigest(firstA.storyId!, { context: a })).updated, true);
  assert.deepEqual(await composeStoryDigest(firstB.storyId!, { context: a }), { updated: false });
  const [digest] = await sql`SELECT space_id, article_ids FROM story_digests WHERE story_id = ${firstA.storyId!}`;
  assert.equal(digest!.space_id, a.spaceId);
  assert.deepEqual(digest!.article_ids, [aid]);
  assert.deepEqual(await groupArticle(bid), { verdict: "skipped" }, "the old adapter cannot operate another space's article");
  const recalledA = await recallFacts(aid, title, 0, 100, [], { context: a });
  assert.equal(recalledA.some(c => c.factId === firstB.factId), false);
  assert.deepEqual(await candidateViews([{ factId: firstB.factId!, storyId: firstB.storyId!, factTitle: title, score: 1 }], { context: a }), []);
  const matched = await relatedPosts({ id: "query", url, x_post: null }, { context: a });
  assert.equal(matched.sameUrl?.fact_id, firstA.factId);
  await sql`UPDATE articles SET processing_config_version = NULL WHERE id = ${bid}`;
  await assert.rejects(groupArticle(bid, { context: b }), /Grouping context changed/);
  await sql`UPDATE articles SET processing_config_version = ${b.configVersion} WHERE id = ${bid}`;
  const next = await scopedReport(b, `${url}-second`, title);
  const before = provider.hits();
  const grouped = await groupArticle(next, { context: b });
  assert.equal(grouped.factId, firstB.factId);
  assert.ok(provider.hits() > before, "the real grouping path called the local model stub");
  const receipts = await sql`SELECT space_id, config_version FROM receipts WHERE purpose = 'group_article' AND subject = ${`article:${next}`}`;
  assert.ok(receipts.length > 0);
  assert.ok(receipts.every(row => row.space_id === b.spaceId && row.config_version === b.configVersion));
  const paid = provider.hits();
  assert.equal((await groupArticle(next, { context: b })).verdict, "kept");
  assert.equal(provider.hits(), paid, "repeating a completed decision does not pay again");
  await assert.rejects(recallFacts("query", title, 0, 10, [{ article_id: bid, fact_id: firstB.factId!, story_id: firstB.storyId!, fact_title: title }], { context: a }), /outside space/);
  const [target] = await sql`SELECT public_id FROM facts WHERE id = ${firstB.factId!}`;
  await assert.rejects(moveToFact(aid, target!.public_id, "cross-space", "test", { context: a }), /目标事实不存在/);
  assert.equal(await mergeStoryInto(firstA.storyId!, firstB.storyId!, "cross-space", "test", { context: a }), null);
  await assert.rejects(sql.begin(tx => recordSignal(tx, firstB.storyId!, aid, { id: a.spaceId, signal_group_id: null }, "editorial", new Date(), { context: a })), /outside space/);
  await assert.rejects(sql`INSERT INTO fact_articles (space_id, fact_id, article_id, role) VALUES (${a.spaceId}, ${firstB.factId!}, ${aid}, 'mention')`, (error: unknown) => (error as { code?: string }).code === "23503");

  // Historical JSON does not have a foreign key: a forged candidate must never create a cross-space link.
  const anotherA = await scopedReport(a, `${url}-another`, title);
  await groupArticle(anotherA, { context: a });
  for (const articleId of [aid, anotherA]) {
    await sql`INSERT INTO grouping_decisions (space_id, article_id, fact_id, story_id, verdict, candidates)
      VALUES (${a.spaceId}, ${articleId}, ${firstA.factId!}, ${firstA.storyId!}, 'new-fact-in-story',
        ${sql.json([{ id: firstB.factId!, score: 1, relation: "SAME_STORY", confidence: 1 }])})`;
  }
  await linkRelatedStories({ context: a });
  assert.equal((await sql`SELECT 1 FROM story_links WHERE story_id = ${firstA.storyId!} AND other_id = ${firstB.storyId!}`).length, 0);
});

test("a delayed grouping response cannot overwrite a later processing generation", async () => {
  const id = await report("generation-race");
  hold = gate();
  asked = gate();
  const pending = groupArticle(id);
  await Promise.race([asked.promise, pending.then(() => assert.fail("expected a model decision"))]);
  await sql`UPDATE articles SET processing_generation = processing_generation + 1, selection_adds_value = NULL WHERE id = ${id}`;
  hold.open();
  await assert.rejects(pending, /Grouping input changed/);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${id}`).length, 0);
  const [current] = await sql`SELECT processing_generation, selection_adds_value, grouping_status FROM articles WHERE id = ${id}`;
  assert.equal(current!.processing_generation, 1);
  assert.equal(current!.selection_adds_value, null);
  assert.equal(current!.grouping_status, "pending");
});

test("an explicit regroup invalidates an in-flight decision while reusing its unchanged paid answer", async () => {
  const id = await report("regroup-generation-race", `${FACT_TITLE} 新的归组请求`);
  hold = gate();
  asked = gate();
  const pending = groupArticle(id);
  await Promise.race([asked.promise, pending.then(() => assert.fail("expected a model decision"))]);
  assert.ok(await requestRegroup(id, `regroup-generation-${T}`));
  assert.equal(await requestRegroup(id, `regroup-generation-${T}`), null, "a duplicate request keeps the already queued generation");
  hold.open();
  await assert.rejects(pending, /Grouping input changed/);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${id}`).length, 0);
  const [article] = await sql`SELECT processing_generation, grouping_generation FROM articles WHERE id = ${id}`;
  assert.equal(article!.processing_generation, 0, "the valid analysis is still current");
  assert.equal(article!.grouping_generation, 1);
  const hits = provider.hits();
  assert.equal((await groupArticle(id)).verdict, "same-fact");
  assert.equal(provider.hits(), hits, "an unchanged prompt and candidate set reuse the prior receipt");
});


test("group-only retries retain the article's original configuration after the active version changes", async () => {
  const original = await resolveSpaceContext("default");
  const id = await report("historic-group-config", `${FACT_TITLE} 历史配置`);
  hold.open();
  await groupArticle(id);
  const changed = await storeSpaceConfig("default", { ...defaultSpaceConfig(), siteName: "A newer fixture configuration" });
  await sql`UPDATE spaces SET active_config_version = ${changed.configVersion} WHERE id = 'default'`;
  try {
    await assert.rejects(requestRegroup(id, `${T}-wrong-config`, sql, { context: changed }), /full reanalysis/);
    const jobId = await requestRegroup(id, `${T}-original-config`);
    assert.ok(jobId);
    const [queued] = await sql`SELECT data FROM pgboss.job WHERE id = ${jobId!}`;
    assert.deepEqual(queued!.data.context, original);
    assert.equal((await groupArticle(id, { context: original })).verdict, "same-fact");
  } finally {
    await sql`UPDATE spaces SET active_config_version = ${original.configVersion} WHERE id = 'default'`;
  }
});
