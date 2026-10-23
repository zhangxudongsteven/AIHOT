// Every editorial prompt lives in the industry pack as a Markdown file (industry/prompts/*.md), so a new
// industry changes its taste by editing text, not code. Two template forms, nothing else:
//   {{name}}     a value the calling step passes (plus siteName, from site/site.ts)
//   {{> file}}   another prompt file, inserted as it is (shared rules)
// A missing value or file is an error, never a silent blank. Versions are content hashes, so a receipt
// and the admin's model page always say which wording produced a result. A wording that is not a file
// of the pack yet (a candidate under evaluation) renders by the same two forms.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SITE } from "@aihot/site";
import { REPO_ROOT } from "../config.ts";
import { configForContext, type SpaceContext } from "../spaces/context.ts";

const DIR = path.join(REPO_ROOT, "industry/prompts");
const TOKEN = /\{\{(>\s*)?([A-Za-z][\w.-]*)\s*\}\}/g;

const files = new Map<string, string>();

function raw(name: string, context?: SpaceContext): string {
  if (context) {
    const text = configForContext(context).prompts[name];
    if (text === undefined) throw new Error(`Missing prompt ${name} for space ${context.spaceId}`);
    return text;
  }
  let text = files.get(name);
  if (text === undefined) {
    text = readFileSync(path.join(DIR, `${name}.md`), "utf8");
    files.set(name, text);
  }
  return text;
}

/** `text` with its includes expanded, and the names of every file it read. */
function expandText(text: string, seen: string[], context?: SpaceContext): { text: string; used: string[] } {
  const used: string[] = [];
  const expanded = text.replace(TOKEN, (token, include: string | undefined, key: string) => {
    if (!include) return token;
    const inner = expand(key, seen, context);
    used.push(...inner.used);
    return inner.text;
  });
  return { text: expanded, used };
}

/** The file with its includes expanded, and the names of every file it read. */
function expand(name: string, seen: string[] = [], context?: SpaceContext): { text: string; used: string[] } {
  if (seen.includes(name)) throw new Error(`prompt include cycle: ${[...seen, name].join(" → ")}`);
  const inner = expandText(raw(name, context), [...seen, name], context);
  return { text: inner.text, used: [name, ...inner.used] };
}

function fill(name: string, text: string, values: Record<string, string>, context?: SpaceContext): string {
  const all: Record<string, string> = { siteName: context ? configForContext(context).siteName : SITE.name, ...values };
  return text.replace(TOKEN, (_token, _include, key: string) => {
    const value = all[key];
    if (value === undefined) throw new Error(`prompt ${name}: no value for {{${key}}}`);
    return value;
  });
}

/** A prompt with its values filled in. */
export function promptText(name: string, values: Record<string, string> = {}, context?: SpaceContext): string {
  return fill(name, expand(name, [], context).text, values, context);
}

/** Wording given as text instead of a pack file, rendered like one; `label` names it in errors. */
export function promptFromText(label: string, text: string, values: Record<string, string> = {}, context?: SpaceContext): string {
  return fill(label, expandText(text, [], context).text, values, context);
}

/** `name@hash` over the files a prompt reads, so any edit shows up as a new version. */
export function promptVersion(...names: string[]): string {
  return promptVersionFor(undefined, ...names);
}

export function promptVersionFor(context: SpaceContext | undefined, ...names: string[]): string {
  const used = [...new Set(names.flatMap((n) => expand(n, [], context).used))].sort();
  const hash = createHash("sha256");
  for (const n of used) hash.update(`${n}\n${raw(n, context)}\n`);
  return `${names.join("+")}@${hash.digest("hex").slice(0, 10)}`;
}
