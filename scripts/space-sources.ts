// Source candidate intake is explicit and additive. Planning never fetches external content.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createSource, listSources, planSourceIntake } from "../packages/backend/src/admin/sources.ts";
import { closeDb } from "../packages/backend/src/db.ts";
import { resolveSpaceAdminContext } from "../packages/backend/src/spaces/context.ts";

const usage = "space-sources.ts list --space <id> [--page <n>] | plan --space <id> --file <sources.json> | apply --space <id> --file <sources.json> --actor <operator>";
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    space: { type: "string" }, file: { type: "string" }, actor: { type: "string" }, page: { type: "string" },
  } });
  const action = positionals[0];
  if (positionals.length !== 1 || !values.space || !/^[a-zA-Z0-9_-]{1,80}$/.test(values.space) || !process.env.DATABASE_URL) throw new Error(usage);
  const context = await resolveSpaceAdminContext(values.space);
  if (action === "list") {
    if (values.file || values.actor || values.page && !/^[1-9]\d*$/.test(values.page)) throw new Error(usage);
    console.log(JSON.stringify({ context, ...await listSources({ page: Number(values.page ?? 1) }, context) }));
    return;
  }
  if ((action !== "plan" && action !== "apply") || !values.file || values.page || action === "apply" && !values.actor?.trim() || action === "plan" && values.actor) throw new Error(usage);
  const { plan } = await planSourceIntake(JSON.parse(await readFile(values.file, "utf8")), context);
  const results = [];
  for (const entry of plan) {
    if (action === "apply" && entry.action === "create") {
      const result = await createSource(entry.source, values.actor!, context);
      results.push({ id: entry.id, action: result.created ? "created" : "duplicate", ...(!result.created ? { duplicateId: result.duplicate.id } : {}) });
    } else results.push({ id: entry.id, action: entry.action, ...("duplicateId" in entry ? { duplicateId: entry.duplicateId } : {}) });
  }
  console.log(JSON.stringify({ action, context, sources: results }));
}
try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "Source intake command failed");
  process.exitCode = 1;
} finally { await closeDb(); }
