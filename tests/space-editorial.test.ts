import { gate, pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { promptText } from "@aihot/backend/editorial/prompts";
import { paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { chatJson } from "@aihot/backend/providers/llm";
import { configForContext, defaultSpaceConfig, resolveSpaceContext, storeSpaceConfig, type SpaceContext } from "@aihot/backend/spaces/context";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cutoverSpaceIdentity } from "../scripts/space-cutover.ts";

const T = tag();
const started = gate();
const release = gate();
let held = false;
const modelRequests: string[] = [];
const provider = await stub(async (_hit, req) => {
  const input = JSON.parse(req.body);
  const text = JSON.stringify(input.messages);
  const answer = (value: unknown) => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
  if (text.includes("IDENTICAL_REQUEST")) { modelRequests.push(input.model); return answer({ ok: true }); }
  const system = String(input.messages[0]?.content ?? "");
  const step = ["prefilter", "score", "structure", "understand"].find(step => system.includes(`STEP_${step.toUpperCase()}`));
  if (step === "prefilter") {
    if (text.includes("HOLD_OLD") && !held) { held = true; started.open(); await release.promise; }
    return answer({ label: text.includes("SPACE_BLOCK") ? "BLOCK" : "PASS", reason: "fixture" });
  }
  if (step === "score") return answer({ attentionScore: 100 });
  if (step === "structure") return answer({ category: "vulnerability", tags: ["漏洞", "模型发布"], subjects: ["acme", "anthropic"], scope: "single", fact: null });
  if (step === "understand") return answer({ itemType: "security_notice", authorRole: "principal", tags: [], editorialJudgment: "安全修复", titleZh: "Acme 发布修复", summaryZh: "Acme 修复一个漏洞。用户应根据官方公告检查版本。" });
  throw new Error(`Unexpected fixture step ${step}`);
});
pointModels(provider.url);
after(async () => { release.open(); await provider.close(); await closeDb(); });

async function space(suffix: string, blocked = false): Promise<SpaceContext> {
  const id = `editorial-${suffix}-${T}`;
  await sql`INSERT INTO spaces (id, slug, enabled) VALUES (${id}, ${id}, true)`;
  const config = structuredClone(defaultSpaceConfig());
  config.categories = [{ key: "vulnerability", label: "漏洞", guide: "官方修复", section: "漏洞", tagColor: "red" }];
  config.categoryTags = ["漏洞"];
  config.topicTags = [];
  config.entityTags = ["Acme"];
  config.entityOrder = ["acme"];
  config.entities = { acme: { name: "Acme", displayTag: "Acme", aliases: ["Acme"] } };
  config.itemTypes = ["security_notice"];
  config.identityLexicon = [{ id: "acme", name: "Acme", patterns: [{ source: "acme", flags: "i" }] }];
  config.publisherDomains = [];
  config.identityContextAliases = [];
  for (const [name, step] of Object.entries({ prefilter: "prefilter", "selection-score": "score", structure: "structure", understand: "understand" })) config.prompts[name] += `\nSTEP_${step.toUpperCase()}`;
  config.prompts.prefilter += `\n${blocked ? "SPACE_BLOCK" : "SPACE_PASS"}`;
  const context = await storeSpaceConfig(id, config);
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${id}`;
  return resolveSpaceContext(id);
}

async function article(context: SpaceContext, marker: string): Promise<string> {
  const id = `space-article-${marker}-${tag()}`;
  const source = `source-${id}`;
  await sql`INSERT INTO sources (id, name, kind, tier, space_id) VALUES (${source}, 'Acme', 'rss', 'T1', ${context.spaceId})`;
  await sql`INSERT INTO articles (id, source_id, space_id, identity_key, url, title, body_text, body_status, processing_config_version, discovered_at, timeline_at)
    VALUES (${id}, ${source}, ${context.spaceId}, ${id}, ${`https://example.invalid/${id}`}, ${`Acme ${marker}`}, ${`Acme ${marker} published an official security correction.`}, 'ok', ${context.configVersion}, now(), now())`;
  return id;
}

test("explicit configurations isolate prefilter, runtime taxonomy and receipt ownership", async () => {
  const pass = await space("pass");
  const block = await space("block", true);
  const a = await article(pass, "PASS");
  const b = await article(block, "BLOCK");
  const [accepted, rejected] = await Promise.all([analyzeArticle(a, { context: pass }), analyzeArticle(b, { context: block })]);
  assert.equal(accepted?.output?.selected, true);
  assert.equal(accepted?.output?.category, "vulnerability");
  assert.deepEqual(accepted?.output?.subjects, ["acme"]);
  assert.deepEqual(accepted?.output?.tags, ["漏洞", "Acme"]);
  assert.equal(rejected?.output?.relevance, "block");
  assert.equal(await analyzeArticle(a, { context: block }), null);
  assert.equal(await analyzeArticle(a), null, "legacy lookup is limited to the default space");
  const receipts = await sql<{ space_id: string; config_version: string; attempt_space: string }[]>`
    SELECT r.space_id, r.config_version, a.space_id AS attempt_space FROM receipts r JOIN receipt_attempts a ON a.receipt_id = r.id WHERE r.id IN ${sql(accepted!.receiptIds)}`;
  assert.ok(receipts.length > 0);
  assert.ok(receipts.every(r => r.space_id === pass.spaceId && r.attempt_space === pass.spaceId && r.config_version === pass.configVersion));
  await sql`UPDATE articles SET processing_config_version = NULL WHERE id = ${a}`;
  await assert.rejects(analyzeArticle(a, { context: pass }), /no pinned processing configuration/);
});

test("identical requests reuse within a space and never reuse another space's receipt", async () => {
  const a = await space("receipts-a");
  const b = await space("receipts-b");
  const call = (context: SpaceContext) => chatJson({ context, model: "deepseek-flash", purpose: "fixture", subject: "same", promptVersion: "same", system: "JSON", user: "IDENTICAL_REQUEST", schema: z.object({ ok: z.boolean() }) });
  const first = await call(a);
  const retry = await call(a);
  const other = await call(b);
  assert.equal(first.receiptId, retry.receiptId);
  assert.equal(retry.reused, true);
  assert.notEqual(first.receiptId, other.receiptId);
  const next = structuredClone(configForContext(a));
  next.modelSpecs["deepseek-flash"]!.model = "fixture-model-v2";
  const newVersion = await storeSpaceConfig(a.spaceId, next);
  const fresh = await call(newVersion);
  assert.notEqual(fresh.receiptId, first.receiptId);
  assert.equal(modelRequests.at(-1), "fixture-model-v2", "the provider receives the model specification saved in this version");
  assert.equal((await call(a)).receiptId, first.receiptId, "changing a newer version cannot replace the historical model call");
});

test("historical configuration is immutable, and missing, disabled or mismatched contexts fail", async () => {
  const context = await space("versions");
  const original = promptText("prefilter", {}, context);
  const next = structuredClone(configForContext(context));
  next.prompts.prefilter += "\nVERSION_TWO";
  const versionTwo = await storeSpaceConfig(context.spaceId, next);
  await sql`UPDATE spaces SET active_config_version = ${versionTwo.configVersion} WHERE id = ${context.spaceId}`;
  assert.equal((await resolveSpaceContext(context.spaceId)).configVersion, versionTwo.configVersion);
  assert.equal(promptText("prefilter", {}, await resolveSpaceContext(context.spaceId, context.configVersion)), original);
  assert.throws(() => { configForContext(context).selection.understandFloor = 99; }, TypeError);
  await assert.rejects(resolveSpaceContext(context.spaceId, "missing"), /Unknown configuration/);
  await assert.rejects(resolveSpaceContext("missing", context.configVersion), /Unknown space/);
  const other = await space("versions-other", true);
  await assert.rejects(resolveSpaceContext(other.spaceId, versionTwo.configVersion), /Unknown configuration/);
  await sql`UPDATE spaces SET enabled = false WHERE id = ${context.spaceId}`;
  await assert.rejects(resolveSpaceContext(context.spaceId, context.configVersion), /disabled/);
});

test("an old execution preserves its analysis but cannot overwrite the newer generation", async () => {
  const context = await space("stale");
  const id = await article(context, "HOLD_OLD");
  const running = analyzeArticle(id, { context, generation: 0, inputRevision: 1 });
  await started.promise;
  await sql`UPDATE articles SET processing_generation = 1, processing_state = 'new' WHERE id = ${id}`;
  release.open();
  const result = await running;
  assert.equal(result?.stale, true);
  const [current] = await sql<{ processing_state: string; processing_generation: number }[]>`SELECT processing_state, processing_generation FROM articles WHERE id = ${id}`;
  assert.deepEqual(current, { processing_state: "new", processing_generation: 1 });
  const [analysis] = await sql<{ space_id: string; config_version: string; processing_generation: number }[]>`SELECT space_id, config_version, processing_generation FROM analyses WHERE id = ${result!.analysisId!}`;
  assert.deepEqual(analysis, { space_id: context.spaceId, config_version: context.configVersion, processing_generation: 0 });
});


test("the default upgrade claims exact legacy receipts without repeating received or unknown requests", async () => {
  const context = await resolveSpaceContext("default");
  const request = { service: "test-legacy", purpose: "legacy_bridge", subject: `fixture:${T}`, identity: { fixture: T, kind: "received" } };
  let calls = 0;
  const legacy = await paidRequest(request, async () => { calls++; return { response: { ok: true } }; });
  const resumed = await paidRequest({ ...request, context }, async () => { calls++; return { response: { ok: false } }; });
  assert.equal(resumed.receiptId, legacy.receiptId);
  assert.equal(resumed.reused, true);
  assert.equal(calls, 1);
  const unknown = { ...request, identity: { fixture: T, kind: "unknown" } };
  await assert.rejects(paidRequest(unknown, async () => { calls++; throw new Error("lost answer"); }), ReceiptUnknownError);
  await assert.rejects(paidRequest({ ...unknown, context }, async () => { calls++; return { response: {} }; }), ReceiptUnknownError);
  assert.equal(calls, 2, "an unknown legacy outcome is not sent a second time during adoption");
  const other = await space("no-legacy-claim");
  const separate = await paidRequest({ ...request, context: other }, async () => { calls++; return { response: {} }; });
  assert.notEqual(separate.receiptId, legacy.receiptId);
  assert.equal(calls, 3);
});


test("the configuration CLI stages versions separately from activation and enabling", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "space-config-"));
  const file = path.join(directory, "config.json");
  const id = `cli-${T}`;
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/space-config.ts", import.meta.url)), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  try {
    cli("export-default", "--out", file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const staged = cli("apply", "--space", id, "--slug", id, "--file", file);
    assert.equal(staged.enabled, false);
    assert.equal(staged.active_config_version, null);
    assert.throws(() => cli("enable", "--space", id), /Activate a configuration/);
    const active = cli("apply", "--space", id, "--slug", id, "--file", file, "--activate");
    assert.equal(active.enabled, false);
    assert.equal(active.active_config_version, staged.configVersion);
    assert.throws(() => cli("enable", "--space", id), /identity cutover/);
    await cutoverSpaceIdentity(sql);
    cli("enable", "--space", id);
    assert.equal((await resolveSpaceContext(id)).configVersion, staged.configVersion);
    const unsafe = JSON.parse(await readFile(file, "utf8"));
    unsafe.modelSpecs.default.extra = { api_key: "fixture-secret" };
    await writeFile(file, JSON.stringify(unsafe));
    assert.throws(() => cli("apply", "--space", id, "--slug", id, "--file", file), /Credentials do not belong/);
    assert.equal((await resolveSpaceContext(id)).configVersion, staged.configVersion);
    cli("disable", "--space", id);
    await assert.rejects(resolveSpaceContext(id), /disabled/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
