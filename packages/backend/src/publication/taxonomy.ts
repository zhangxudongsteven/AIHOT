// A public channel publishes the vocabulary of its active configuration. The legacy default keeps
// the site's API category merges; other channels expose their configured category keys unchanged.
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { toPublicApiCategory, feedCategoryLabel, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { publicationConfig, publicationSpaceId } from "./context.ts";

export function publicationCategories() {
  return publicationConfig()?.categories ?? CATEGORIES;
}

export function publicationCategoryKeys(): string[] {
  return publicationCategories().map(c => c.key);
}

export function publicationPublicCategoryKeys(): string[] {
  return [...new Set(publicationCategoryKeys().map(key => publicationApiCategory(key)!))];
}

export function publicationApiCategory(key: string | null): PublicApiCategoryKey | null {
  const keys = publicationCategoryKeys();
  if (!key || !keys.includes(key)) return null;
  const merged = publicationSpaceId() === "default" ? toPublicApiCategory(key) : null;
  return (merged && keys.includes(merged) ? merged : key) as PublicApiCategoryKey;
}

export function publicationCategoryLabel(key: string): string | null {
  return publicationCategories().find(c => c.key === key)?.label ?? null;
}

export function publicationFeedCategoryLabel(key: string): string {
  const category = publicationCategories().find(c => c.key === key);
  const original = CATEGORIES.find(c => c.key === key);
  if (publicationSpaceId() === "default" && original && category?.label === original.label) return feedCategoryLabel(key as PublicApiCategoryKey);
  return (category && "feedLabel" in category ? category.feedLabel : null) ?? category?.label ?? key;
}
