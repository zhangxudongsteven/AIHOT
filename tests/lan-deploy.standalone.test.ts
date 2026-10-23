import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const repository = path.resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(path.join(tmpdir(), "lan-deploy-"));
after(() => rmSync(temporary, { recursive: true, force: true }));

type Invocation = { stage: string; args: string[]; envFile?: string; inherited: Record<string, boolean> };
const fakeDocker = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let stage;
let envFile;
if (args[0] === "info") stage = "info";
else if (args[0] === "compose" && args[1] === "version") stage = "version";
else {
  const i = args.indexOf("--env-file");
  if (i >= 0) envFile = args[i + 1];
  const command = args.find(value => ["config", "build", "run", "stop", "up", "exec", "ps", "logs"].includes(value));
  stage = command;
  if (command === "up" && args.includes("--help")) stage = "wait-support";
  if (command === "run") {
    const input = fs.readFileSync(0);
    if (args.includes("pg_restore")) {
      stage = "backup-check";
      if (!input.toString().startsWith("PGDMP")) process.exit(93);
    } else if (args.includes("tar")) stage = "data-backup";
    else if (args.includes("node")) stage = input.includes(Buffer.from("--format=custom")) ? "db-backup" : "preflight";
    else stage = "migrate";
  }
  if (command === "exec" && args.includes("scripts/smoke.ts")) stage = "smoke";
}
if (!stage) throw new Error("Unexpected Docker command: " + JSON.stringify(args));
const inherited = {};
for (const key of ["DATABASE_URL", "PGPASSWORD", "SITE_URL", "PORT", "DATABASE_POOL_MAX", "ADMIN_PASSWORD", "SESSION_SECRET", "IMG_PROXY_SIGN_SECRET", "AIHOT_RELEASE", "LOG_LEVEL", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES"]) {
  if (process.env[key] !== undefined) inherited[key] = true;
}
fs.appendFileSync(process.env.LAN_TEST_TRACE, JSON.stringify({ stage, args, envFile, inherited }) + "\\n");
if (stage === process.env.LAN_TEST_FAIL_STAGE) {
  console.error("Simulated " + stage + " failure");
  process.exit(42);
}
if (stage === "wait-support") console.log("--wait --wait-timeout seconds");
if (stage === "version") console.log("Docker Compose version v2.39.0");
if (stage === "db-backup") process.stdout.write("PGDMP local test fixture");
if (stage === "data-backup") process.stdout.write(fs.readFileSync(process.env.LAN_TEST_ARCHIVE));
`;

function fixture() {
  const root = mkdtempSync(path.join(temporary, "case-"));
  for (const directory of ["scripts", "deploy", "bin", "files"]) mkdirSync(path.join(root, directory));
  copyFileSync(path.join(repository, "scripts/deploy-lan.sh"), path.join(root, "scripts/deploy-lan.sh"));
  copyFileSync(path.join(repository, "compose.lan.yml"), path.join(root, "compose.lan.yml"));
  writeFileSync(path.join(root, "bin/docker"), fakeDocker, { mode: 0o755 });
  writeFileSync(path.join(root, "files/preserved.txt"), "persistent application data\n");
  const archive = path.join(root, "fixture.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", path.join(root, "files"), "."]);
  const envFile = path.join(temporary, `${path.basename(root)}.env`);
  const secret = "fixture-password-never-print-7823";
  writeFileSync(envFile, [
    "DATABASE_URL=postgres://myhot@172.16.0.17:5432/myhot",
    `PGPASSWORD=${secret}`,
    "SITE_URL=http://172.16.0.17:3000",
    "PORT=3000",
    "ADMIN_PASSWORD=fixture-admin-password-7823",
    "SESSION_SECRET=fixture-session-secret-7823",
    "IMG_PROXY_SIGN_SECRET=fixture-image-secret-7823",
    "COLLECT_ENABLED=false",
    "MODEL_CALLS_ENABLED=false",
    "FEISHU_INTERNAL_ENABLED=false",
    "FEISHU_CONTENT_PUSH_ENABLED=false",
    "INDEXNOW_SUBMIT_ENABLED=false",
    "",
  ].join("\n"), { mode: 0o600 });
  const trace = path.join(root, "trace.jsonl");
  const run = (mode: string, overrides: NodeJS.ProcessEnv = {}, selectedEnvFile: string | null = envFile) => {
    const args = [path.join(root, "scripts/deploy-lan.sh"), ...(selectedEnvFile ? ["--env-file", selectedEnvFile] : []), mode];
    const result = spawnSync("bash", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, LAN_TEST_TRACE: trace, LAN_TEST_ARCHIVE: archive, ...overrides },
    });
    assert.ifError(result.error);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "deployment output must not contain the database password");
    const calls: Invocation[] = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    return { ...result, calls, stages: calls.map((call) => call.stage) };
  };
  return { root, envFile, run };
}

const mutationStages = ["build", "preflight", "stop", "db-backup", "backup-check", "data-backup", "migrate", "up", "smoke"];

test("missing or publicly readable environment files and unknown modes fail before Docker", () => {
  for (const invalid of ["missing", "readable", "mode"]) {
    const { envFile, run } = fixture();
    if (invalid === "missing") rmSync(envFile);
    if (invalid === "readable") chmodSync(envFile, 0o644);
    const result = run(invalid === "mode" ? "unrecognized" : "deploy");
    assert.notEqual(result.status, 0, invalid);
    assert.deepEqual(result.calls, [], invalid);
  }
});

test("check selects the explicit environment and ignores stale shell connection and Compose settings", () => {
  const { envFile, run } = fixture();
  const stale = Object.fromEntries(["DATABASE_URL", "PGPASSWORD", "SITE_URL", "PORT", "DATABASE_POOL_MAX", "ADMIN_PASSWORD", "SESSION_SECRET", "IMG_PROXY_SIGN_SECRET", "AIHOT_RELEASE", "LOG_LEVEL", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES"].map((key) => [key, "stale-shell-value"]));
  const result = run("check", stale);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some((call) => call.stage === "config"));
  for (const call of result.calls.filter((entry) => entry.envFile)) {
    assert.equal(call.envFile, realpathSync(envFile));
    assert.deepEqual(call.inherited, {});
  }
  assert.deepEqual(result.stages.filter((stage) => mutationStages.includes(stage)), []);
});

test("private configuration cannot enter the build context through a custom path or symlink", () => {
  for (const kind of ["inside", "file-symlink", "directory-symlink"]) {
    const { root, envFile, run } = fixture();
    const inside = path.join(root, "deploy/private.env");
    copyFileSync(envFile, inside);
    let selected = inside;
    if (kind === "file-symlink") {
      selected = path.join(temporary, `${path.basename(root)}-link.env`);
      symlinkSync(inside, selected);
    }
    if (kind === "directory-symlink") {
      const link = path.join(temporary, `${path.basename(root)}-link`);
      symlinkSync(path.join(root, "deploy"), link, "dir");
      selected = path.join(link, "private.env");
    }
    const result = run("deploy", {}, selected);
    assert.notEqual(result.status, 0, kind);
    assert.deepEqual(result.calls, [], kind);
  }
});

test("the default LAN environment and private data-directory configuration remain usable", () => {
  for (const selected of [".env.lan", ".data/server.env"]) {
    const { root, envFile, run } = fixture();
    const target = path.join(root, selected);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(envFile, target);
    const result = run("check", {}, selected === ".env.lan" ? null : target);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.some((call) => call.stage === "config" && call.envFile === realpathSync(target)));
    assert.deepEqual(result.stages.filter((stage) => mutationStages.includes(stage)), []);
  }
});

test("build and database preflight failure leave the old services running", () => {
  for (const stage of ["build", "preflight"]) {
    const result = fixture().run("deploy", { LAN_TEST_FAIL_STAGE: stage });
    assert.notEqual(result.status, 0, stage);
    assert.ok(result.stages.includes(stage));
    assert.ok(!result.stages.includes("stop"));
    assert.ok(!result.stages.includes("migrate"));
    assert.ok(!result.stages.includes("up"));
  }
});

test("backup creation, backup verification and migration failures prevent starting a new application", () => {
  for (const stage of ["db-backup", "backup-check", "data-backup", "migrate"]) {
    const result = fixture().run("deploy", { LAN_TEST_FAIL_STAGE: stage });
    assert.notEqual(result.status, 0, stage);
    assert.ok(result.stages.includes("stop"));
    assert.ok(result.stages.includes(stage));
    assert.ok(!result.stages.includes("up"));
    assert.ok(!result.stages.includes("smoke"));
    if (stage !== "migrate") assert.ok(!result.stages.includes("migrate"));
  }
});

test("deployment builds first, stops writers, verifies backups, migrates, starts and checks the site", () => {
  const { root, run } = fixture();
  const result = run("deploy");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(result.stages.filter((stage) => mutationStages.includes(stage)), mutationStages);
  assert.ok(result.stages.includes("ps"));
  const invocationText = result.calls.flatMap((call) => call.args);
  assert.ok(!invocationText.some((arg) => /seed\.ts|^down$|^--volumes$|^volume$|^db$/.test(arg)), "this deployment must neither seed data nor manage a database container or delete volumes");
  const files = readdirSync(root, { recursive: true }).map(String);
  assert.ok(!files.some((name) => name.endsWith(".partial")), "successful deployment must finish its backup files");
  const backups = files.filter((name) => name.endsWith("/database.dump") || name.endsWith("/data.tar.gz"));
  assert.equal(backups.length, 2);
  for (const name of backups) {
    const details = statSync(path.join(root, name));
    assert.ok(details.size > 0);
    assert.equal(details.mode & 0o077, 0, "backups must stay private");
  }
  assert.equal(readFileSync(path.join(root, "files/preserved.txt"), "utf8"), "persistent application data\n");
});

test("a readiness or smoke failure is reported without automatically restoring an older application", () => {
  for (const stage of ["up", "smoke"]) {
    const result = fixture().run("deploy", { LAN_TEST_FAIL_STAGE: stage });
    assert.notEqual(result.status, 0, stage);
    assert.equal(result.stages.filter((value) => value === "up").length, 1);
    assert.equal(result.stages.filter((value) => value === "stop").length, 1);
    assert.ok(!result.calls.flatMap((call) => call.args).includes("down"));
    if (stage === "up") assert.ok(!result.stages.includes("smoke"));
  }
});
