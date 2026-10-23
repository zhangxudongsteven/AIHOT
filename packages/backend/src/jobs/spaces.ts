import { sql } from "../db.ts";
import { resolveSpaceContext, type SpaceContext } from "../spaces/context.ts";
import { recordRun } from "./queue.ts";

/** One platform timer fans out explicitly; one channel failure does not starve the remaining channels. */
export async function runInEnabledSpaces<T>(job: string, run: (context: SpaceContext) => Promise<T>): Promise<Array<{ spaceId: string; result: T }>> {
  const rows = await sql<{ id: string; active_config_version: string }[]>`
    SELECT id, active_config_version FROM spaces WHERE enabled AND active_config_version IS NOT NULL ORDER BY id`;
  const results: Array<{ spaceId: string; result: T }> = [];
  const failures: Error[] = [];
  for (const row of rows) {
    try {
      const result = await recordRun(`${job}:${row.id}`, async () => run(await resolveSpaceContext(row.id, row.active_config_version)));
      results.push({ spaceId: row.id, result });
    } catch (cause) { failures.push(new Error(`Space job failed: ${job}/${row.id}`, { cause })); }
  }
  if (failures.length) throw new AggregateError(failures, `${job}: ${failures.length} space(s) failed; see per-space job runs`);
  return results;
}
