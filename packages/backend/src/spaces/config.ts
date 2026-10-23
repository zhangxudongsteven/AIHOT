import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as taxonomy from "@aihot/industry/taxonomy";
import { SELECTION } from "@aihot/industry/selection";
import { READER_WORDING } from "@aihot/industry/wording";
import { EDITION_TIMES, ITEM_COPY, REPORTS, SITE } from "@aihot/site";
import { DEFAULTS, PRESETS } from "@aihot/site/models";
import { REPO_ROOT } from "../config.ts";
import { stableJson } from "../lib/ids.ts";

export interface SpaceContext {
  readonly spaceId: string;
  readonly configVersion: string;
}

const nonempty = z.string().trim().min(1);
const pattern = z.object({ source: nonempty, flags: z.string() }).strict().superRefine((value, ctx) => {
  try { new RegExp(value.source, value.flags); } catch { ctx.addIssue({ code: "custom", message: "Invalid regular expression" }); }
});
const entity = z.object({ name: nonempty, displayTag: z.string().nullable(), aliases: z.array(z.string()), orgNames: z.array(z.string()).optional(), otherNames: z.array(z.string()).optional() }).strict();
const strings = z.array(nonempty).min(1);

/** A stored version contains its complete editorial inputs, never paths into a mutable pack. */
export const SpaceConfigSchema = z.object({
  siteName: nonempty,
  reasonLabel: nonempty,
  reports: z.object({
    editionTimes: z.object({ daily: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), weekly: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), monthly: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict(),
    quiet: z.object({ title: nonempty, paragraph: nonempty }).strict(),
    plainTerms: z.array(nonempty),
    release: z.object({ category: nonempty, tag: nonempty, unit: nonempty }).strict().nullable(),
  }).strict().optional(),
  prompts: z.record(z.string(), z.string()),
  categories: z.array(z.object({ key: nonempty, label: nonempty, guide: z.string(), section: nonempty, tagColor: nonempty, feedLabel: z.string().optional(), commentary: z.boolean().optional() }).strict()).min(1),
  categoryTags: strings,
  topicTags: z.array(nonempty),
  entityTags: z.array(nonempty),
  tagSynonyms: z.record(z.string(), z.string()),
  entities: z.record(z.string(), entity),
  entityOrder: z.array(nonempty),
  itemTypes: strings,
  identityLexicon: z.array(z.object({ id: nonempty, name: nonempty, patterns: z.array(pattern) }).strict()),
  publisherDomains: z.array(z.object({ entityId: nonempty, domains: z.array(nonempty) }).strict()),
  identityContextAliases: z.array(z.object({ entityId: nonempty, pattern }).strict()),
  readerWording: z.array(z.object({ pattern, fix: nonempty }).strict()),
  selection: z.object({ thresholds: z.record(z.string(), z.number().min(0).max(100)), understandFloor: z.number().min(0).max(100) }).strict(),
  models: z.record(z.string(), nonempty),
  modelSpecs: z.record(z.string(), z.object({
    service: nonempty, model: z.string(), baseUrlEnv: nonempty, apiKeyEnv: nonempty, jsonMode: z.boolean(), vision: z.boolean().optional(),
    extra: z.record(z.string(), z.unknown()).optional(), reasoningTokens: z.number().int().nonnegative().optional(), fallbackFor: z.record(z.string(), nonempty).optional(),
    scoreCall: z.object({ temperature: z.number(), maxTokens: z.number().int().positive(), timeoutMs: z.number().int().positive() }).strict().optional(),
  }).strict()),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.categories.map(c => c.key)).size !== value.categories.length) ctx.addIssue({ code: "custom", message: "Category keys must be unique" });
  if (new Set(value.entityOrder).size !== value.entityOrder.length || value.entityOrder.length !== Object.keys(value.entities).length || value.entityOrder.some(id => !Object.hasOwn(value.entities, id))) ctx.addIssue({ code: "custom", message: "entityOrder must list every entity exactly once" });
  for (const [capability, model] of Object.entries(value.models)) if (!value.modelSpecs[model]) ctx.addIssue({ code: "custom", message: `Unknown model ${model} for ${capability}` });
  for (const name of ["prefilter", "selection-score", "understand", "structure", "mend-wording", "identity-context", "summarize-article", "summarize-article-empty", "summarize-short-post", "summarize-short-post-quoted", "summarize-long-post", "summarize-long-post-quoted"]) {
    if (!value.prompts[name]) ctx.addIssue({ code: "custom", message: `Missing prompt ${name}` });
  }
});
export type SpaceConfig = z.infer<typeof SpaceConfigSchema>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseSpaceConfig(value: unknown): SpaceConfig {
  const inspect = (item: unknown, location: string): void => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:api[-_]?key|secret|password|authorization|access[-_]?token|refresh[-_]?token|private[-_]?key)$/i.test(key)) throw new Error(`Credentials do not belong in a space configuration: ${location}.${key}`);
      inspect(child, `${location}.${key}`);
    }
  };
  inspect(value, "config");
  return freeze(SpaceConfigSchema.parse(value));
}

export function spaceConfigVersion(config: SpaceConfig): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

const serializedPattern = (regex: RegExp) => ({ source: regex.source, flags: regex.flags });

/** Existing installations retain their industry; registration does not import any example sources. */
export function defaultSpaceConfig(models: Record<string, string> = {}): SpaceConfig {
  const directory = path.join(REPO_ROOT, "industry/prompts");
  return parseSpaceConfig({
    siteName: SITE.name, reasonLabel: ITEM_COPY.reasonLabel,
    reports: { editionTimes: EDITION_TIMES, quiet: REPORTS.quiet, plainTerms: [...taxonomy.PLAIN_TERMS], release: taxonomy.RELEASE },
    prompts: Object.fromEntries(readdirSync(directory).filter(name => name.endsWith(".md")).map(name => [name.slice(0, -3), readFileSync(path.join(directory, name), "utf8")])),
    categories: taxonomy.CATEGORIES,
    categoryTags: taxonomy.CATEGORY_TAGS, topicTags: taxonomy.TOPIC_TAGS, entityTags: taxonomy.ENTITY_TAGS,
    tagSynonyms: taxonomy.TAG_SYNONYMS, entities: taxonomy.ENTITIES, entityOrder: Object.keys(taxonomy.ENTITIES), itemTypes: taxonomy.ITEM_TYPES,
    identityLexicon: taxonomy.IDENTITY_LEXICON.map(e => ({ ...e, patterns: e.patterns.map(serializedPattern) })),
    publisherDomains: taxonomy.PUBLISHER_DOMAINS,
    identityContextAliases: taxonomy.IDENTITY_CONTEXT_ALIASES.map(a => ({ ...a, pattern: serializedPattern(a.pattern) })),
    readerWording: READER_WORDING.map(([pattern, fix]) => ({ pattern: serializedPattern(pattern), fix })),
    modelSpecs: {
      default: { service: "llm", model: process.env.LLM_MODEL ?? "", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY", jsonMode: process.env.LLM_JSON_MODE !== "false", vision: process.env.LLM_VISION === "true",
        ...(process.env.LLM_EXTRA_JSON ? { extra: JSON.parse(process.env.LLM_EXTRA_JSON) } : {}),
        ...(process.env.LLM_REASONING_TOKENS ? { reasoningTokens: Number(process.env.LLM_REASONING_TOKENS) } : {}) },
      ...PRESETS,
    },
    selection: SELECTION, models: { ...DEFAULTS, ...Object.fromEntries(Object.entries({
      prefilter: "PREFILTER_MODEL", score: "SCORE_MODEL", understand: "UNDERSTAND_MODEL", summarize: "SUMMARIZE_MODEL", wording: "WORDING_MODEL",
      structure: "STRUCTURE_MODEL", group: "GROUP_MODEL", groupReview: "GROUP_REVIEW_MODEL", digest: "DIGEST_MODEL", report: "REPORT_MODEL", translate: "TRANSLATE_MODEL",
    }).map(([capability, env]) => [capability, models[capability] ?? process.env[env] ?? DEFAULTS[capability] ?? "default"])), ...models },
  });
}
