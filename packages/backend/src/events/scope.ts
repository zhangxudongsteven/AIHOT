import { sql, type Db } from "../db.ts";
import { resolveSpaceContext, type SpaceContext } from "../spaces/context.ts";

export interface EventOptions { context?: SpaceContext }

/** Legacy event entry points are bound to the default space, never to all spaces. */
export function eventContext(options: EventOptions = {}, db: Db = sql): Promise<SpaceContext> {
  return resolveSpaceContext(options.context?.spaceId ?? "default", options.context?.configVersion, db);
}

/** JSON/array references cannot be protected by a composite foreign key. Check them before writing. */
export async function assertEventReferences(db: Db, spaceId: string, references: { articles?: string[]; facts?: number[]; stories?: number[] }) {
  for (const [table, ids] of [["articles", references.articles], ["facts", references.facts], ["stories", references.stories]] as const) {
    if (!ids?.length) continue;
    const unique = [...new Set<string | number>(ids)];
    const rows = await db`SELECT id FROM ${db(table)} WHERE space_id = ${spaceId} AND id IN ${db(unique)}`;
    if (rows.length !== unique.length) throw new Error(`Event reference outside space ${spaceId}: ${table}`);
  }
}
