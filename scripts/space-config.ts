// Versioned editorial configuration. Export is offline; applying/activating/enabling are explicit
// operator actions against DATABASE_URL. New spaces remain disabled until the separate enable command.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { DEFAULT_SPACE_ID, defaultSpaceConfig, parseSpaceConfig, spaceConfigVersion, storeSpaceConfig } from "../packages/backend/src/spaces/context.ts";

const usage = [
  "space-config.ts export-default --out <new.json>",
  "space-config.ts apply --space <id> --slug <slug> --file <config.json> [--activate]",
  "space-config.ts enable --space <id>",
  "space-config.ts disable --space <id>",
].join("\n");

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    out: { type: "string" }, space: { type: "string" }, slug: { type: "string" }, file: { type: "string" }, activate: { type: "boolean", default: false },
  } });
  if (positionals.length !== 1) throw new Error(usage);
  const action = positionals[0];
  if (action === "export-default") {
    if (!values.out || values.space || values.slug || values.file || values.activate) throw new Error(usage);
    const file = path.resolve(values.out);
    await writeFile(file, JSON.stringify(defaultSpaceConfig(), null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ action, file }));
    return;
  }
  const id = values.space;
  if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || values.out) throw new Error(usage);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for a configuration write");
  if (action === "apply") {
    const slug = values.slug;
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !values.file) throw new Error(usage);
    const config = parseSpaceConfig(JSON.parse(await readFile(values.file, "utf8")));
    const result = await sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${"space-config:" + id}))`;
      const [existing] = await tx<{ slug: string }[]>`SELECT slug FROM spaces WHERE id = ${id} FOR UPDATE`;
      if (existing && existing.slug !== slug) throw new Error("The existing space slug is stable; apply does not rename it");
      if (!existing) await tx`INSERT INTO spaces (id, slug, enabled) VALUES (${id}, ${slug}, false)`;
      const context = await storeSpaceConfig(id, config, tx);
      if (values.activate) await tx`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${id}`;
      const [state] = await tx<{ enabled: boolean; active_config_version: string | null }[]>`SELECT enabled, active_config_version FROM spaces WHERE id = ${id}`;
      return { ...context, ...state };
    });
    console.log(JSON.stringify({ action, ...result }));
    return;
  }
  if (action === "enable" || action === "disable") {
    if (values.slug || values.file || values.activate) throw new Error(usage);
    await sql.begin(async tx => {
      const [space] = await tx<{ active_config_version: string | null }[]>`SELECT active_config_version FROM spaces WHERE id = ${id} FOR UPDATE`;
      if (!space) throw new Error(`Unknown space: ${id}`);
      if (action === "enable") {
        if (!space.active_config_version) throw new Error("Activate a configuration version before enabling this space");
        if (id !== DEFAULT_SPACE_ID) {
          const [cutover] = await tx`SELECT 1 FROM pg_index i
            WHERE i.indexrelid = to_regclass('public.articles_space_identity_idx') AND i.indisvalid AND i.indisunique
              AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.articles'::regclass AND conname = 'articles_identity_key_key')
              AND EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('public.reports_space_kind_key_uidx') AND indisvalid AND indisunique)
              AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.reports'::regclass AND conname = 'reports_kind_key_key')
              AND EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('public.quote_translations_space_tweet_idx') AND indisvalid AND indisunique)
              AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.quote_translations'::regclass AND conname = 'quote_translations_pkey')`;
          if (!cutover) throw new Error("Complete the reviewed space identity cutover before enabling a non-default space");
        }
        const [version] = await tx<{ config: unknown }[]>`SELECT config FROM space_configs WHERE space_id = ${id} AND config_version = ${space.active_config_version}`;
        if (!version) throw new Error("Active configuration is missing");
        if (spaceConfigVersion(parseSpaceConfig(version.config)) !== space.active_config_version) throw new Error("Active configuration integrity mismatch");
      }
      await tx`UPDATE spaces SET enabled = ${action === "enable"} WHERE id = ${id}`;
    });
    console.log(JSON.stringify({ action, spaceId: id, enabled: action === "enable" }));
    return;
  }
  throw new Error(usage);
}

try { await main(); }
catch (error) {
  // Do not print PostgreSQL connection strings, raw configuration or provider credentials on failure.
  console.error(error instanceof Error ? error.message : "Space configuration command failed");
  process.exitCode = 1;
} finally { await closeDb(); }
