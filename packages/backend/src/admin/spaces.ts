import type { AdminSpace, AdminSpaces, AdminSpaceSettings, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { config } from "../config.ts";
import { getSpaceBudgets } from "../spaces/quotas.ts";
import { contentPushGroups, listBudgets, listSpaceTargets } from "./settings.ts";

async function readSpaces(spaceId?: string): Promise<AdminSpace[]> {
  return sql<AdminSpace[]>`SELECT s.id, s.slug, s.enabled, s.active_config_version,
      coalesce(nullif(c.config->>'siteName', ''), s.slug) AS name,
      (SELECT count(*)::int FROM sources src WHERE src.space_id = s.id AND src.enabled AND src.health = 'failing') AS "failedSources"
    FROM spaces s LEFT JOIN space_configs c ON c.space_id = s.id AND c.config_version = s.active_config_version
    WHERE (${spaceId ?? null}::text IS NULL OR s.id = ${spaceId ?? null})
    ORDER BY (s.id = 'default') DESC, s.slug`;
}

/** Management includes disabled channels; the public directory intentionally does not. */
export async function listAdminSpaces(): Promise<AdminSpaces> {
  return { spaces: (await readSpaces()).map(({ active_config_version: _version, ...space }) => space) };
}

export async function adminSpace(spaceId: string): Promise<AdminSpace | null> {
  return (await readSpaces(spaceId))[0] ?? null;
}

export async function spaceSettings(spaceId: string): Promise<BeforeJson<AdminSpaceSettings> | null> {
  const space = await adminSpace(spaceId);
  if (!space) return null;
  const [targets, budgets, platformBudgets] = await Promise.all([listSpaceTargets(spaceId), getSpaceBudgets(spaceId), listBudgets()]);
  return { space, targets, budgets, platformBudgets, pushGroups: contentPushGroups(spaceId),
    gates: { collectEnabled: process.env.COLLECT_ENABLED === "true", modelCallsEnabled: config.modelCallsEnabled, contentPushEnabled: config.feishuContentPushEnabled },
  };
}
