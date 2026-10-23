import type { PublicSpace } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { configForContext, DEFAULT_SPACE_ID, resolveSpaceContext } from "../spaces/context.ts";

type Registration = { id: string; slug: string; active_config_version: string };
async function publicRegistration(row: Registration): Promise<PublicSpace> {
  const context = await resolveSpaceContext(row.id, row.active_config_version);
  return { id: row.id, slug: row.slug, name: configForContext(context).siteName, configVersion: context.configVersion };
}

export async function resolveDefaultPublicSpace(): Promise<PublicSpace | null> {
  const [row] = await sql<Registration[]>`
    SELECT id, slug, active_config_version FROM spaces WHERE id = ${DEFAULT_SPACE_ID} AND enabled AND active_config_version IS NOT NULL`;
  return row ? publicRegistration(row) : null;
}

/** Public registration exposes a small whitelist; disabled and incomplete channels have no route. */
export async function resolvePublicSpace(slug: string): Promise<PublicSpace | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  const [row] = await sql<Registration[]>`
    SELECT id, slug, active_config_version FROM spaces WHERE slug = ${slug} AND enabled AND active_config_version IS NOT NULL`;
  return row ? publicRegistration(row) : null;
}

export async function listPublicSpaces(): Promise<PublicSpace[]> {
  const rows = await sql<Registration[]>`SELECT id, slug, active_config_version FROM spaces WHERE enabled AND active_config_version IS NOT NULL ORDER BY (id = 'default') DESC, slug`;
  return Promise.all(rows.map(publicRegistration));
}
