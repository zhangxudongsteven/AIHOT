// Which models the admin may choose for a step: only a step that needs images refuses a text model.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { CAPABILITIES, capabilityAcceptsModel, invalidateModelCache, modelFor, modelSources } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";
import { configForContext, ensureDefaultSpace, resolveSpaceContext, storeSpaceConfig } from "@aihot/backend/spaces/context";

after(closeDb);

test("every step takes a model that reads images; only a step that needs images refuses a text model", async () => {
  const understand = CAPABILITIES.understand;
  assert.equal(capabilityAcceptsModel(understand, MODELS["glm-5.3-flash"]!), true);
  assert.equal(capabilityAcceptsModel(understand, MODELS["qwen3-vl-flash"]!), true);
  assert.equal(capabilityAcceptsModel(understand, MODELS["deepseek-flash"]!), true);
  assert.equal(capabilityAcceptsModel(CAPABILITIES.score, MODELS["qwen3-vl-flash"]!), true);
  assert.equal(capabilityAcceptsModel({ ...understand, vision: true }, MODELS["deepseek-flash"]!), false);

  await switchModel("understand", "qwen3-vl-flash", "vision routing test", "test");
  assert.equal(await modelFor("understand"), "qwen3-vl-flash");
  await switchModel("understand", "deepseek-flash", "text routing test", "test");
  assert.equal(await modelFor("understand"), "deepseek-flash");

  const overview = await modelsOverview(1);
  assert.equal(overview.capabilities.find((capability) => capability.key === "understand")?.vision, false);
});

test("the upgrade snapshots valid admin choices from its own transaction instead of the process cache", async () => {
  const scoreEnv = process.env.SCORE_MODEL;
  const digestEnv = process.env.DIGEST_MODEL;
  const rollback = new Error("rollback upgrade fixture");
  try {
    invalidateModelCache();
    await modelSources(); // Deliberately cache the committed settings before the migration's writes.
    process.env.SCORE_MODEL = "qwen3-vl-flash";
    process.env.DIGEST_MODEL = "missing-fixture-model";
    await assert.rejects(sql.begin(async tx => {
      await tx`UPDATE spaces SET active_config_version=NULL WHERE id='default'`;
      for (const [capability, model] of [["score", "deepseek-flash"], ["digest", "missing-fixture-model"]]) {
        await tx`INSERT INTO settings(key,value) VALUES(${`models.${capability}`},${tx.json({ model })})
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
      }
      await ensureDefaultSpace(tx);
      const initial = await resolveSpaceContext("default", undefined, tx);
      assert.equal(await modelFor("score", initial), "deepseek-flash", "the valid admin setting wins over the environment and stale process cache");
      assert.equal(await modelFor("digest", initial), CAPABILITIES.digest.default, "invalid admin and environment models fall back to the code default");
      await tx`UPDATE settings SET value=${tx.json({ model: "qwen3-vl-flash" })} WHERE key='models.score'`;
      await ensureDefaultSpace(tx);
      assert.equal((await resolveSpaceContext("default", undefined, tx)).configVersion, initial.configVersion, "rerunning migration does not change an active snapshot");
      throw rollback;
    }), error => error === rollback);
  } finally {
    if (scoreEnv === undefined) delete process.env.SCORE_MODEL; else process.env.SCORE_MODEL = scoreEnv;
    if (digestEnv === undefined) delete process.env.DIGEST_MODEL; else process.env.DIGEST_MODEL = digestEnv;
    invalidateModelCache();
  }
});

test("an admin switch activates a new default version while existing work and other spaces keep their model", async () => {
  const original = await resolveSpaceContext("default");
  const beforeModel = await modelFor("score", original);
  const otherId = `model-other-${tag()}`;
  await sql`INSERT INTO spaces(id,slug,enabled) VALUES(${otherId},${otherId},true)`;
  const other = await storeSpaceConfig(otherId, configForContext(original));
  await sql`UPDATE spaces SET active_config_version=${other.configVersion} WHERE id=${otherId}`;
  const chosen = beforeModel === "qwen3-vl-flash" ? "deepseek-flash" : "qwen3-vl-flash";
  const result = await switchModel("score", chosen, "versioned model switch", "model-version-test");
  const current = await resolveSpaceContext("default");
  assert.notEqual(current.configVersion, original.configVersion);
  assert.equal(result.after.model, chosen);
  assert.equal(await modelFor("score", current), chosen);
  assert.equal(await modelFor("score", await resolveSpaceContext("default", original.configVersion)), beforeModel);
  assert.equal((await resolveSpaceContext(otherId)).configVersion, other.configVersion);
  assert.equal(await modelFor("score", other), beforeModel);
  const [audit] = await sql`SELECT before,after FROM audit_log WHERE actor='model-version-test' ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.before.configVersion, original.configVersion);
  assert.equal(audit!.after.configVersion, current.configVersion);

  const restored = await switchModel("score", null, "restore environment model", "test");
  assert.equal(await modelFor("score", await resolveSpaceContext("default")), restored.after.model);
  for (const capability of ["report", "translate"]) {
    const before = await resolveSpaceContext("default");
    const oldModel = await modelFor(capability, before);
    const nextModel = oldModel === chosen ? beforeModel : chosen;
    await switchModel(capability, nextModel, "versioned report and translation step", "test");
    const after = await resolveSpaceContext("default");
    assert.notEqual(after.configVersion, before.configVersion);
    assert.equal(await modelFor(capability, after), nextModel);
    assert.equal(await modelFor(capability, before), oldModel);
    assert.equal((await resolveSpaceContext(otherId)).configVersion, other.configVersion);
  }
});

test("the overview reads custom snapshot models and a failed audit rolls back a model switch", async () => {
  const original = await resolveSpaceContext("default");
  const custom = structuredClone(configForContext(original));
  custom.models.score = "snapshot-only";
  custom.modelSpecs["snapshot-only"] = { service: "fixture", model: "fixture-score", baseUrlEnv: "FIXTURE_BASE_URL", apiKeyEnv: "FIXTURE_API_KEY", jsonMode: true };
  const current = await storeSpaceConfig("default", custom);
  await sql`UPDATE spaces SET active_config_version=${current.configVersion} WHERE id='default'`;
  const overview = await modelsOverview(1);
  assert.deepEqual(overview.capabilities.find(c => c.key === "score")!.current, { model: "snapshot-only", source: "config" });
  const [setting] = await sql`SELECT value FROM settings WHERE key='models.score'`;
  await sql.unsafe(`CREATE FUNCTION fail_model_switch_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'reject-model-switch' THEN RAISE EXCEPTION 'injected switch audit failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER fail_model_switch_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_model_switch_audit()");
  try {
    await assert.rejects(switchModel("score", "deepseek-flash", "rollback switch", "reject-model-switch"), /injected switch audit failure/);
  } finally {
    await sql.unsafe("DROP TRIGGER fail_model_switch_audit ON audit_log");
    await sql.unsafe("DROP FUNCTION fail_model_switch_audit()");
  }
  assert.equal((await resolveSpaceContext("default")).configVersion, current.configVersion);
  assert.deepEqual((await sql`SELECT value FROM settings WHERE key='models.score'`)[0], setting);
  assert.equal(await modelFor("score", current), "snapshot-only");
});
