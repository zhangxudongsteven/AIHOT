import { sql } from "../db.ts";
import { withPublicationSpace } from "../publication/context.ts";
import { DEFAULT_SPACE_ID, configForContext, parseSpaceConfig, resolveSpaceContext, spaceConfigVersion, type SpaceContext } from "../spaces/context.ts";

/** Old callers are an explicit default-channel bridge; object IDs never choose a channel. */
export function notificationContext(context?: SpaceContext): Promise<SpaceContext> {
  return resolveSpaceContext(context?.spaceId ?? DEFAULT_SPACE_ID, context?.configVersion);
}

/** Cards use the same scoped public links and sanitized reads as the website. */
export async function withNotificationSpace<T>(context: SpaceContext, read: () => T | Promise<T>): Promise<T> {
  const [space] = await sql<{ slug: string }[]>`SELECT slug FROM spaces WHERE id = ${context.spaceId}`;
  if (!space) throw new Error(`Unknown space: ${context.spaceId}`);
  return withPublicationSpace({ id: context.spaceId, slug: space.slug, name: configForContext(context).siteName, configVersion: context.configVersion }, read,
    { legacy: context.spaceId === DEFAULT_SPACE_ID });
}

/** Non-sending reconciliation is still possible after a channel is suspended. */
export async function notificationIdentity(context?: { spaceId: string; configVersion?: string }): Promise<SpaceContext> {
  const spaceId = context?.spaceId ?? DEFAULT_SPACE_ID;
  if (!spaceId.trim() || (context?.configVersion !== undefined && !context.configVersion.trim())) throw new Error("A space and its configuration version must be explicit");
  const [stored] = await sql<{ config_version: string; config: unknown }[]>`
    SELECT c.config_version, c.config FROM spaces s JOIN space_configs c ON c.space_id = s.id
      AND c.config_version = coalesce(${context?.configVersion ?? null}::text, s.active_config_version) WHERE s.id = ${spaceId}`;
  if (!stored || spaceConfigVersion(parseSpaceConfig(stored.config)) !== stored.config_version) throw new Error(`Unknown or invalid configuration for space ${spaceId}`);
  return Object.freeze({ spaceId, configVersion: stored.config_version });
}
