import { sql, type Db } from "../db.ts";
import { defaultSpaceConfig, parseSpaceConfig, spaceConfigVersion, type SpaceConfig, type SpaceContext } from "./config.ts";

export { type SpaceConfig, type SpaceContext, defaultSpaceConfig, parseSpaceConfig, spaceConfigVersion } from "./config.ts";
export const DEFAULT_SPACE_ID = "default";
const versions = new Map<string, SpaceConfig>();
const keyOf = (context: SpaceContext) => JSON.stringify([context.spaceId, context.configVersion]);

/** Only the resolver populates this cache. A task cannot turn an arbitrary prompt path into configuration. */
export function configForContext(context: SpaceContext): SpaceConfig {
  const config = versions.get(keyOf(context));
  if (!config) throw new Error(`Space context has not been resolved: ${context.spaceId}/${context.configVersion}`);
  return config;
}

export async function resolveSpaceContext(spaceId: string, configVersion?: string, db: Db = sql): Promise<SpaceContext> {
  if (!spaceId?.trim() || (configVersion !== undefined && !configVersion.trim())) throw new Error("A space and its configuration version must be explicit");
  const [space] = await db<{ enabled: boolean; active_config_version: string | null }[]>`SELECT enabled, active_config_version FROM spaces WHERE id = ${spaceId}`;
  if (!space) throw new Error(`Unknown space: ${spaceId}`);
  if (!space.enabled) throw new Error(`Space is disabled: ${spaceId}`);
  const version = configVersion ?? space.active_config_version;
  if (!version) throw new Error(`Space has no active configuration: ${spaceId}`);
  const context = Object.freeze({ spaceId, configVersion: version });
  const [stored] = await db<{ config: unknown }[]>`SELECT config FROM space_configs WHERE space_id = ${spaceId} AND config_version = ${version}`;
  if (!stored) throw new Error(`Unknown configuration for space ${spaceId}: ${version}`);
  const config = parseSpaceConfig(stored.config);
  if (spaceConfigVersion(config) !== version) throw new Error(`Configuration integrity mismatch: ${spaceId}/${version}`);
  versions.set(keyOf(context), config);
  return context;
}

/** An explicit operator action adds an immutable version; old queued work can continue reading it. */
export async function storeSpaceConfig(spaceId: string, value: unknown, db: Db = sql): Promise<SpaceContext> {
  const config = parseSpaceConfig(value);
  const context = Object.freeze({ spaceId, configVersion: spaceConfigVersion(config) });
  await db`INSERT INTO space_configs (space_id, config_version, config) VALUES (${spaceId}, ${context.configVersion}, ${db.json(config as never)}) ON CONFLICT (space_id, config_version) DO NOTHING`;
  const [stored] = await db<{ config: unknown }[]>`SELECT config FROM space_configs WHERE space_id = ${spaceId} AND config_version = ${context.configVersion}`;
  if (!stored || spaceConfigVersion(parseSpaceConfig(stored.config)) !== context.configVersion) throw new Error(`Configuration integrity mismatch: ${spaceId}/${context.configVersion}`);
  versions.set(keyOf(context), config);
  return context;
}

/** The upgrade bridge creates only the existing default industry; it never activates another channel. */
export async function ensureDefaultSpace(db: Db = sql): Promise<void> {
  await db`INSERT INTO spaces (id, slug, enabled) VALUES (${DEFAULT_SPACE_ID}, 'default', true) ON CONFLICT (id) DO NOTHING`;
  const [space] = await db<{ active_config_version: string | null }[]>`SELECT active_config_version FROM spaces WHERE id = ${DEFAULT_SPACE_ID}`;
  if (space?.active_config_version) return;
  // Migration may run against a different database or within a transaction. Read that installation's
  // effective choices directly; a process cache must not replace its existing admin selections.
  const { modelSources } = await import("../editorial/models.ts");
  const models = Object.fromEntries(Object.entries(await modelSources(db)).map(([key, choice]) => [key, choice.model]));
  const context = await storeSpaceConfig(DEFAULT_SPACE_ID, defaultSpaceConfig(models), db);
  await db`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${DEFAULT_SPACE_ID} AND active_config_version IS NULL`;
}
