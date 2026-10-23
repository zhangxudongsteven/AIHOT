import { AsyncLocalStorage } from "node:async_hooks";
import type { PublicSpace } from "@aihot/contracts/site";
import { DEFAULT_SPACE_ID, configForContext, resolveSpaceContext, type SpaceConfig } from "../spaces/context.ts";

export type { PublicSpace } from "@aihot/contracts/site";
const reads = new AsyncLocalStorage<{ space: PublicSpace; config: SpaceConfig; legacy: boolean }>();

/** Only an explicitly resolved URL selects a channel; background work and old URLs stay default. */
export const publicationSpace = (): PublicSpace | null => reads.getStore()?.legacy ? null : reads.getStore()?.space ?? null;
export const publicationSpaceId = (): string => publicationSpace()?.id ?? DEFAULT_SPACE_ID;
export const publicationConfig = (): SpaceConfig | null => reads.getStore()?.config ?? null;
/** URLs and configuration also separate caches for the explicit default route and its legacy alias. */
export const publicationCacheKey = (): string => {
  const current = reads.getStore();
  return current ? JSON.stringify([current.legacy, current.space.id, current.space.slug, current.space.configVersion]) : "legacy:default";
};

export async function withPublicationSpace<T>(space: PublicSpace, read: () => T | Promise<T>, opts: { legacy?: boolean } = {}): Promise<T> {
  if (opts.legacy && space.id !== DEFAULT_SPACE_ID) throw new Error("Only the default channel has legacy public URLs");
  const context = await resolveSpaceContext(space.id, space.configVersion);
  return reads.run({ space: Object.freeze({ ...space }), config: configForContext(context), legacy: opts.legacy === true }, read);
}

export function publicationPath(path: string): string {
  const space = publicationSpace();
  if (!space || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/channels/") || path.startsWith("/api/") || path.startsWith("/admin")) return path;
  // Brand assets, contact codes and module-owned paths remain shared across channels.
  if (path !== "/" && !/^\/(?:all|about|agent|changelog|feedback|starred|more|privacy|terms|hot|topics?|items|story|daily|weekly|monthly|feed(?:\.xml)?|sitemaps|sitemap\.xml|llms\.txt|openapi-v1\.json|og)(?:[/?#]|$)/.test(path)) return path;
  return `/channels/${encodeURIComponent(space.slug)}${path === "/" ? "" : path}`;
}

export function publicationApiPath(path: string): string {
  const space = publicationSpace();
  if (!space) return path;
  if (/^\/api\/(?:site|v1)\/spaces\//.test(path) || path.startsWith("/api/mcp/spaces/")) return path;
  if (path === "/api/mcp") return `/api/mcp/spaces/${encodeURIComponent(space.slug)}`;
  return path.replace(/^\/api\/(site|v1)(?=\/|$)/, `/api/$1/spaces/${encodeURIComponent(space.slug)}`);
}
