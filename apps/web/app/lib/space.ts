import { useCallback } from "react";
import { useLocation, useRouteLoaderData } from "react-router";
import { CATEGORY_KEYS, CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import type { SiteMeta } from "@aihot/contracts/site";
import { spacePath, spaceSlug } from "./space-path";
const CATEGORIES = CATEGORY_KEYS.map(key => ({ key, label: CATEGORY_LABELS[key], section: key, tagColor: "" }));
export function useSpace() {
  const meta = useRouteLoaderData("root") as SiteMeta | undefined;
  const slug = spaceSlug(useLocation().pathname);
  const isDefault = !slug || meta?.space?.id === "default";
  return { slug, space: meta?.space, categories: meta?.categories ?? CATEGORIES, isDefault, reportSettings: meta?.reportSettings, path: (path: string) => spacePath(path, slug) };
}

/** Async reads keep the channel of the component that started them, even during browser back. */
export function useSpaceFetch() {
  const { slug } = useSpace();
  return useCallback((path: string, init?: RequestInit) => fetch(spacePath(path, slug), init), [slug]);
}
