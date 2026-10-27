import { gate, pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { promptText, promptVersionFor } from "@aihot/backend/editorial/prompts";
import { paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { chatJson } from "@aihot/backend/providers/llm";
import { configForContext, defaultSpaceConfig, parseSpaceConfig, resolveSpaceContext, spaceConfigVersion, storeSpaceConfig, type SpaceContext } from "@aihot/backend/spaces/context";
import { z } from "zod";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cutoverSpaceIdentity } from "../scripts/space-cutover.ts";
import { promisify } from "node:util";
import { normalizeTags } from "@aihot/backend/editorial/vocabulary";
import { securitySpaceConfig } from "../industry/channels/security/config.ts";

const T = tag();
const exec = promisify(execFile);
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

test("selection evaluation uses the chosen channel snapshot for prompts, models, thresholds and receipts", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "space-selection-eval-"));
  const reports: string[] = [];
  const requests: Array<{ model: string; messages: Array<{ content: string }> }> = [];
  const local = await stub((_hit, req) => {
    const input = JSON.parse(req.body);
    requests.push(input);
    const system = String(input.messages[0].content);
    const data = system.includes("EVAL_FILTER")
      ? { label: system.includes("EVAL_BLOCK") ? "BLOCK" : "PASS", reason: "fixture" }
      : { attentionScore: 70 };
    return { choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  });
  t.after(async () => {
    await local.close();
    await Promise.all(reports.map(file => rm(file, { force: true })));
    await rm(directory, { recursive: true, force: true });
  });
  const initial = await space("eval");
  const config = structuredClone(configForContext(initial));
  config.prompts.prefilter = "EVAL_FILTER";
  config.prompts["selection-score"] = "EVAL_SCORE";
  config.selection.thresholds = { T1: 60, T2: 80 };
  config.models.prefilter = "eval-filter";
  config.models.score = "eval-score";
  const spec = { service: "llm", baseUrlEnv: "EVAL_LLM_BASE_URL", apiKeyEnv: "EVAL_LLM_API_KEY", jsonMode: true };
  config.modelSpecs["eval-filter"] = { ...spec, model: "fixture-filter" };
  config.modelSpecs["eval-score"] = { ...spec, model: "fixture-score", scoreCall: { temperature: 0, maxTokens: 512, timeoutMs: 5000 } };
  const historical = await storeSpaceConfig(initial.spaceId, config);
  config.prompts.prefilter += " EVAL_BLOCK";
  const active = await storeSpaceConfig(initial.spaceId, config);
  await sql`UPDATE spaces SET active_config_version = ${active.configVersion} WHERE id = ${active.spaceId}`;
  const gold = path.join(directory, "gold.jsonl");
  await writeFile(gold, ["T1", "T2"].map((tier) => JSON.stringify({
    caseId: `${T}-${tier}`,
    material: { title: "Acme security update", sourceName: "Acme", bodyOriginal: "Acme published an official security correction." },
    sourceFacts: { sourceKind: "rss", sourceTier: tier },
    gold: { decision: tier === "T1" ? "select" : "reject" },
  })).join("\n"));
  const run = async (...extra: string[]) => {
    const result = await exec(process.execPath, [fileURLToPath(new URL("../scripts/eval-selection.ts", import.meta.url)), "--space", initial.spaceId, "--gold", gold, "--n", "2", "--no-import", ...extra], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, MODEL_CALLS_ENABLED: "true", EVAL_LLM_BASE_URL: `${local.url}/v1`, EVAL_LLM_API_KEY: "test-key" },
    });
    const file = /^report: (.+)$/m.exec(result.stdout)?.[1];
    assert.ok(file, result.stdout);
    reports.push(file);
    return JSON.parse(await readFile(file, "utf8"));
  };
  const report = await run("--config-version", historical.configVersion);
  assert.equal(report.meta.spaceId, historical.spaceId);
  assert.equal(report.meta.configVersion, historical.configVersion);
  assert.equal(report.meta.promptVersion, [promptVersionFor(historical, "prefilter"), promptVersionFor(historical, "selection-score")].join("+"));
  assert.deepEqual(Object.keys(report.models), ["eval-score"], "the score model is from this snapshot, even when absent from site presets");
  const results = report.models["eval-score"];
  assert.equal(results.summary.errors, 0);
  assert.equal(results.summary.accuracy, 1);
  assert.equal(results.cases.find((row: { caseId: string }) => row.caseId.endsWith("T1")).decision, "select");
  assert.equal(results.cases.find((row: { caseId: string }) => row.caseId.endsWith("T2")).decision, "reject");
  assert.ok(requests.some(req => req.model === "fixture-filter" && req.messages[0]!.content === "EVAL_FILTER"));
  assert.equal(requests.filter(req => req.model === "fixture-score").length, 2, "shared material is scored twice, with case-specific tier decisions");
  const receipts = await sql<{ space_id: string; config_version: string; attempt_space: string }[]>`
    SELECT r.space_id, r.config_version, a.space_id AS attempt_space FROM receipts r JOIN receipt_attempts a ON a.receipt_id = r.id
    WHERE r.space_id = ${historical.spaceId} AND r.config_version = ${historical.configVersion}`;
  assert.ok(receipts.length >= 3);
  assert.ok(receipts.every(row => row.space_id === historical.spaceId && row.attempt_space === historical.spaceId && row.config_version === historical.configVersion));
  const scoresBefore = requests.filter(req => req.model === "fixture-score").length;
  const current = await run();
  assert.equal(current.meta.configVersion, active.configVersion);
  assert.ok(current.models["eval-score"].cases.every((row: { relevance: string; decision: string }) => row.relevance === "block" && row.decision === "reject"));
  assert.equal(requests.filter(req => req.model === "fixture-score").length, scoresBefore, "the active prefilter blocks before scoring");
});

test("selection evaluation refuses unknown, disabled, invalid or unowned inputs before model calls", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "space-selection-refusal-"));
  const local = await stub(() => { throw new Error("Refused evaluation must not call a provider"); });
  t.after(async () => { await local.close(); await rm(directory, { recursive: true, force: true }); });
  const context = await space("eval-refusal");
  const disabled = await space("eval-disabled");
  await sql`UPDATE spaces SET enabled = false WHERE id = ${disabled.spaceId}`;
  const invalid = await space("eval-invalid");
  await sql`UPDATE space_configs SET config = '{}'::jsonb WHERE space_id = ${invalid.spaceId}`;
  const gold = path.join(directory, "gold.jsonl");
  await writeFile(gold, JSON.stringify({ caseId: T, material: { title: "Acme security update", sourceName: "Acme", bodyOriginal: "Acme corrected a security issue." }, sourceFacts: { sourceKind: "rss" }, gold: { decision: "reject" } }));
  const [benchBefore] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM selectbench_runs`;
  const presetCallsBefore = provider.hits();
  const refused = async (args: string[], pattern: RegExp) => {
    await assert.rejects(exec(process.execPath, [fileURLToPath(new URL("../scripts/eval-selection.ts", import.meta.url)), ...args], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, MODEL_CALLS_ENABLED: "true", LLM_BASE_URL: `${local.url}/v1`, LLM_API_KEY: "test-key" },
    }), (error: unknown) => { assert.match(String((error as { stderr: string }).stderr), pattern); return true; });
  };
  await refused(["--space", context.spaceId, "--no-import"], /explicit --gold/);
  await refused(["--space", context.spaceId, "--gold", gold], /requires --no-import/);
  await refused(["--space", "missing", "--gold", gold, "--no-import"], /Unknown space/);
  await refused(["--space", disabled.spaceId, "--gold", gold, "--no-import"], /disabled/);
  await refused(["--space", invalid.spaceId, "--gold", gold, "--no-import"], /ZodError/);
  await refused(["--space", context.spaceId, "--config-version", "missing", "--gold", gold, "--no-import"], /Unknown configuration/);
  await refused(["--space", context.spaceId, "--gold", gold, "--no-import", "--split", "all", "--models", "missing"], /unknown model/);
  assert.equal(local.hits(), 0);
  assert.equal(provider.hits(), presetCallsBefore, "refusals also make no request through a global preset");
  const [benchAfter] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM selectbench_runs`;
  assert.equal(benchAfter!.n, benchBefore!.n);
});

test("selection evaluation keeps the default AI channel and its SelectBench import when --space is omitted", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "default-selection-eval-"));
  const context = await resolveSpaceContext("default");
  const config = configForContext(context);
  const local = await stub((_hit, req) => {
    const input = JSON.parse(req.body);
    const data = input.messages[0].content === promptText("prefilter", {}, context)
      ? { label: "PASS", reason: "fixture" } : { attentionScore: 100 };
    return { choices: [{ message: { content: JSON.stringify(data) } }] };
  });
  let reportFile: string | undefined;
  t.after(async () => { await local.close(); if (reportFile) await rm(reportFile, { force: true }); await rm(directory, { recursive: true, force: true }); });
  const gold = path.join(directory, "gold.jsonl");
  await writeFile(gold, JSON.stringify({ caseId: `${T}-default`, material: { title: "An AI model release", sourceName: "AI vendor", bodyOriginal: "The vendor released an AI model with an official model card." }, sourceFacts: { sourceKind: "rss", sourceTier: "T2" }, gold: { decision: "select" } }));
  const env: NodeJS.ProcessEnv = { ...process.env, MODEL_CALLS_ENABLED: "true" };
  for (const step of ["prefilter", "score"]) {
    const spec = config.modelSpecs[config.models[step]!]!;
    env[spec.baseUrlEnv] = `${local.url}/v1`;
    env[spec.apiKeyEnv] = "test-key";
  }
  const { stdout } = await exec(process.execPath, [fileURLToPath(new URL("../scripts/eval-selection.ts", import.meta.url)), "--gold", gold, "--split", "all", "--n", "1"], { encoding: "utf8", timeout: 30_000, env });
  reportFile = /^report: (.+)$/m.exec(stdout)?.[1];
  assert.ok(reportFile, stdout);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(report.meta.spaceId, "default");
  assert.equal(report.meta.configVersion, context.configVersion);
  assert.equal(report.models[config.models.score!].cases[0].decision, "select");
  const runId = /^SelectBench run: (.+)$/m.exec(stdout)?.[1];
  assert.ok(runId, stdout);
  const [run] = await sql<{ summary: Record<string, { spaceId: string; configVersion: string }> }[]>`SELECT summary FROM selectbench_runs WHERE id = ${runId}`;
  assert.equal(run!.summary[config.models.score!]!.spaceId, "default");
  assert.equal(run!.summary[config.models.score!]!.configVersion, context.configVersion);
});

test("security vocabulary preserves the project entity alongside its technical topic", async () => {
  const space = `security-vocabulary-${tag()}`;
  await sql`INSERT INTO spaces(id,slug) VALUES(${space},${space})`;
  const context = await storeSpaceConfig(space, securitySpaceConfig(defaultSpaceConfig()));
  assert.deepEqual(normalizeTags(['补丁更新', 'Kubernetes', 'K8s', '云与 Kubernetes'], context), ['补丁更新', 'Kubernetes', '云与 Kubernetes']);
});

test("offline channel candidates preserve AI defaults, disable sources and require a new output directory", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-candidates-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const out = path.join(directory, "candidates");
  const cli = (...args: string[]) => exec(process.execPath, [fileURLToPath(new URL("../scripts/prepare-channel-configs.ts", import.meta.url)), ...args], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, DATABASE_URL: "postgres://127.0.0.1:1/unreachable_test", LLM_API_KEY: "candidate-secret-fixture", LLM_BASE_URL: "https://candidate-provider.invalid/private-fixture" },
  });
  const prepared = JSON.parse((await cli("--out", out)).stdout);
  assert.equal(prepared.status, "candidate");
  assert.equal(prepared.applied, false);
  const files = await Promise.all(["ai.config.json", "security.config.json", "ai.sources.json", "security.sources.json", "manifest.json"].map(async name => {
    const file = path.join(out, name);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    return readFile(file, "utf8");
  }));
  assert.ok(files.every(text => !text.includes("candidate-secret-fixture") && !text.includes("https://candidate-provider.invalid/private-fixture")));
  const ai = parseSpaceConfig(JSON.parse(files[0]!));
  const security = parseSpaceConfig(JSON.parse(files[1]!));
  assert.deepEqual(ai, defaultSpaceConfig());
  assert.equal(security.categories.length, 6);
  assert.equal(security.reports!.editionTimes.daily, "08:00");
  assert.equal(security.reports!.release, null);
  assert.deepEqual(security.selection, ai.selection, "candidate thresholds are preserved and remain uncalibrated");
  for (const text of files.slice(2, 4)) {
    const { sources } = JSON.parse(text);
    assert.ok(sources.length > 0);
    assert.ok(sources.every((source: { enabled: boolean }) => source.enabled === false));
  }
  const manifest = JSON.parse(files[4]!);
  assert.equal(manifest.calibration.security, "pending-human-labels");
  assert.equal(manifest.channels.default.configVersion, spaceConfigVersion(ai));
  assert.equal(manifest.channels.security.configVersion, spaceConfigVersion(security));
  assert.equal(JSON.parse((await cli("--validate", out)).stdout).action, "validate");
  await assert.rejects(cli("--out", out), /Channel candidate command failed/);
  assert.equal(await readFile(path.join(out, "ai.config.json"), "utf8"), files[0], "a second preparation cannot overwrite existing candidates");
});
