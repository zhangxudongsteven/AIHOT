import { EDITION_TIMES, REPORTS } from "@aihot/site";
import { PLAIN_TERMS, RELEASE } from "@aihot/industry/taxonomy";
import { configForContext, DEFAULT_SPACE_ID, resolveSpaceContext, type SpaceContext } from "../spaces/context.ts";

export const reportContext = (context?: SpaceContext) => resolveSpaceContext(context?.spaceId ?? DEFAULT_SPACE_ID, context?.configVersion);

/** Old snapshots retain their identity; only the original channel inherits the original wording. */
export function reportConfig(context?: SpaceContext) {
  const configured = context ? configForContext(context).reports : undefined;
  if (configured) return configured;
  const original = !context || context.spaceId === DEFAULT_SPACE_ID;
  return {
    editionTimes: EDITION_TIMES,
    quiet: original ? REPORTS.quiet : { title: "本期暂无新动态", paragraph: "{start} 至 {end}，暂无符合本频道规则的新动态。" },
    plainTerms: original ? [...PLAIN_TERMS] : [],
    release: original ? RELEASE : null,
  };
}
