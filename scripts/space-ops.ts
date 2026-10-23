// Channel operations use the same audited functions as the admin API. Files contain credential
// reference names only; secret values belong in the integrations secret store.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { configureContentTarget, listTargets } from "../packages/backend/src/admin/settings.ts";
import { getSpaceBudgets, setSpaceBudget } from "../packages/backend/src/spaces/quotas.ts";

const usage = "space-ops.ts show --space <id> | target --space <id> --file <target.json> --actor <name> | budget --space <id> --service <service> --file <budget.json> --actor <name>";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    space: { type: "string" }, service: { type: "string" }, file: { type: "string" }, actor: { type: "string" },
  } });
  const [action] = positionals;
  if (positionals.length !== 1 || !values.space || !process.env.DATABASE_URL) throw new Error(usage);
  const [space] = await sql`SELECT id, slug, enabled, active_config_version FROM spaces WHERE id = ${values.space}`;
  if (!space) throw new Error("Unknown space");
  if (action === "show") {
    if (values.file || values.service || values.actor) throw new Error(usage);
    console.log(JSON.stringify({ space, targets: await listTargets(values.space), budgets: await getSpaceBudgets(values.space) }, null, 2));
  } else {
    if (!values.file || !values.actor?.trim()) throw new Error(usage);
    const input = JSON.parse(await readFile(values.file, "utf8"));
    if (action === "target" && !values.service) console.log(JSON.stringify(await configureContentTarget(values.space, input, values.actor)));
    else if (action === "budget" && values.service) console.log(JSON.stringify(await setSpaceBudget(values.space, values.service, input, values.actor)));
    else throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Channel operation failed");
  process.exitCode = 1;
} finally { await closeDb(); }
