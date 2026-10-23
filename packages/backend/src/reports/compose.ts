// Daily, weekly and monthly reports. Windows are Beijing calendar based and written into the report;
// missed schedule points are caught up; regeneration creates a revision. What every issue carries is
// decided by rule: a daily from edition.ts without a model; a weekly or monthly is compiled from its
// dailies and a model only writes its overview and introductions, from the brief in the industry pack
// (industry/prompts/report-period*.md).
import { z } from "zod";
import { SITE } from "@aihot/site";
import { promptText, promptVersion, promptVersionFor } from "../editorial/prompts.ts";
import { modelFor } from "../editorial/models.ts";
import { ENTITIES, entityNames } from "../editorial/vocabulary.ts";
import { addDays, beijingAt, beijingDate, beijingTime, isoWeekLabel, isoWeekRange, monthRange } from "@aihot/contracts/time";
import { configForContext, type SpaceContext } from "../spaces/context.ts";
import { reportConfig, reportContext } from "./config.ts";
import { sql } from "../db.ts";
import { logError } from "../lib/log-error.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { emit } from "../modules.ts";
import { arrangeDaily, candidates, dailyEdition, periodEntries, sectionOf, sectionOrder, type Candidate, type EditionEntry } from "./edition.ts";

export const REPORT_VERSION = promptVersion("report-period", "report-period-sections", "report-period-no-sections");

/**
 * The masthead's figures, counted in events: sources over every report its entries cite; releases
 * (`modelsReleased`, its public name) are the entries of the pack's headline launch kind (RELEASE: its
 * category and its tag, so not a ranking or a test) that a maker announced itself, new that day. An
 * industry without such a kind has no release figure.
 */
export function dailyMetrics(main: EditionEntry[], context?: SpaceContext) {
  const release = reportConfig(context).release;
  return {
    totalEvents: main.length,
    sourcesCount: new Set(main.flatMap((e) => [e.entry.sourceId, ...(e.entry.related ?? []).map((r) => r.sourceId)])).size,
    ...(release ? { modelsReleased: main.filter((e) => e.category === release.category && e.tags.includes(release.tag) && !e.previous && e.authority < 3).length } : {}),
    firstPartyEvents: main.filter((e) => e.entry.firstParty).length,
  };
}

type ReportKind = "daily" | "weekly" | "monthly";
type ReportStatus = "published" | "existing" | "stale";
export interface ComposedReport { key: string; entries: number; status: ReportStatus }

/** How many events an issue already published carries; nothing when it does not exist yet. */
async function savedReport(kind: ReportKind, key: string, context: SpaceContext) {
  const [row] = await sql<{ entries: number }[]>`
    SELECT coalesce(CASE WHEN kind = 'daily' THEN (content->'metrics'->>'totalEvents')::int ELSE jsonb_array_length(content->'storyOrder') END, 0) AS entries
    FROM reports WHERE space_id = ${context.spaceId} AND kind = ${kind} AND key = ${key}`;
  return row;
}

/**
 * Without a reason (the scheduled run) only a missing issue is written: one already published stays as
 * it is. With a reason (an explicit regeneration) the issue is replaced and the edition it replaces is
 * kept as a revision. A superseded or disabled channel only completes its paid receipts.
 */
async function saveReport(kind: ReportKind, key: string, start: Date, end: Date, content: Record<string, unknown>, reason: string | undefined, model: string | null, receiptIds: number[], context: SpaceContext): Promise<ReportStatus> {
  return sql.begin(async (tx) => {
    // A model may finish after activation or shutdown of this channel. Serialize the final write
    // against that change; old answers remain accounted for but cannot replace the current edition.
    const [space] = await tx<{ enabled: boolean; active_config_version: string | null }[]>`
      SELECT enabled, active_config_version FROM spaces WHERE id = ${context.spaceId} FOR SHARE`;
    if (!space?.enabled || space.active_config_version !== context.configVersion) {
      for (const id of receiptIds) await completeReceipt(tx, id);
      return "stale";
    }
    const cited = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ("itemId" in value && typeof value.itemId === "string") cited.add(value.itemId);
      for (const child of Object.values(value)) visit(child);
    };
    visit(content);
    const references = [...cited];
    if (references.length) {
      const owned = await tx<{ article_id: string }[]>`SELECT article_id FROM publications WHERE space_id = ${context.spaceId} AND article_id = ANY(${references}::text[])`;
      if (owned.length !== references.length) throw new Error(`Report contains an unknown or foreign article: ${context.spaceId}`);
    }
    const insert = async () => (await tx`INSERT INTO reports (space_id, config_version, kind, key, window_start, window_end, content, generated_at, model, origin)
      VALUES (${context.spaceId}, ${context.configVersion}, ${kind}, ${key}, ${start}, ${end}, ${tx.json(content as never)}, now(), ${model}, 'model') ON CONFLICT (space_id, kind, key) DO NOTHING`).count > 0;
    let written: boolean;
    if (reason === undefined) written = await insert();
    else {
      const [existing] = await tx<{ id: number; revision: number; content: unknown; generated_at: Date; config_version: string | null }[]>`
        SELECT id, revision, content, generated_at, config_version FROM reports WHERE space_id = ${context.spaceId} AND kind = ${kind} AND key = ${key} FOR UPDATE`;
      if (existing) {
        await tx`INSERT INTO report_revisions (report_id, revision, content, generated_at, reason, config_version)
                 VALUES (${existing.id}, ${existing.revision}, ${tx.json(existing.content as never)}, ${existing.generated_at}, ${reason}, ${existing.config_version}) ON CONFLICT DO NOTHING`;
        await tx`UPDATE reports SET content = ${tx.json(content as never)}, window_start = ${start}, window_end = ${end}, generated_at = now(),
                   model = ${model}, config_version = ${context.configVersion}, revision = revision + 1, origin = 'model', updated_at = now() WHERE id = ${existing.id}`;
        written = true;
      } else written = await insert();
    }
    // A new issue changes the latest page, the archive, its neighbours' navigation and the report feeds.
    if (written) {
      await emit("reportsChanged", { reason: `${kind} ${key} published` }, tx);
      // Only newly scheduled editions are pushed; an operator correction does not resend an issue.
      if (reason === undefined) {
        const [report] = await tx<{ id: number }[]>`SELECT id FROM reports WHERE space_id = ${context.spaceId} AND kind = ${kind} AND key = ${key}`;
        await enqueue(QUEUES.notifyReport, { reportId: report!.id, context }, { singletonKey: `report:${report!.id}` }, tx);
      }
    }
    for (const id of receiptIds) await completeReceipt(tx, id);
    return written ? "published" : "existing";
  });
}

/** "10 月 4 日 08:00": one end of a quiet issue's window, as its lead paragraph names it. */
function windowPoint(at: Date): string {
  const day = beijingDate(at);
  return `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日 ${beijingTime(at)}`;
}

/**
 * Daily report for Beijing date D covers the 24 hours up to the site's edition time on D (EDITION_TIMES).
 * Its most important entry leads, in its own words, and the next three are today's highlights. A window
 * the editors judged with nothing new in it still has its issue: no entries, and a lead that says so
 * (REPORTS.quiet).
 */
export async function composeDaily(date: string, reason?: string, context?: SpaceContext): Promise<ComposedReport> {
  context = await reportContext(context);
  const settings = reportConfig(context);
  const previous = await savedReport("daily", date, context);
  if (previous && reason === undefined) return { key: date, entries: previous.entries, status: "existing" };
  const end = beijingAt(date, settings.editionTimes.daily);
  const start = new Date(end.getTime() - 86400000);
  const edition = await dailyEdition(date, start, end, context);
  // Nothing judged in the window is a failure upstream, not a quiet day: the run fails and is caught up later.
  if (edition.entries.length === 0 && edition.stats.judgedReports === 0) throw new Error(`daily ${date}: nothing judged in its window`);
  const issue = arrangeDaily(edition.entries, context);
  const [lead, ...rest] = issue.main;
  const content = {
    date,
    lead: lead
      ? { title: lead.entry.title, leadParagraph: lead.entry.summary }
      : { title: settings.quiet.title, leadParagraph: settings.quiet.paragraph.replace("{start}", windowPoint(start)).replace("{end}", windowPoint(end)) },
    leadItemId: lead?.entry.itemId ?? null,
    highlights: rest.slice(0, 3).map((e) => e.entry.itemId),
    sections: sectionOrder(context)
      .map((label) => ({ label, items: issue.main.filter((e) => sectionOf(e.category, context) === label).map((e) => e.entry) }))
      .filter((s) => s.items.length > 0),
    flashes: issue.flashes.map((e) => e.entry),
    metrics: dailyMetrics(issue.main, context),
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    generator: { version: promptVersionFor(context, "report-period", "report-period-sections", "report-period-no-sections"), configVersion: context.configVersion, ...edition.stats, ...issue.stats },
  };
  const status = await saveReport("daily", date, start, end, content, reason, null, [], context);
  return { key: date, entries: issue.main.length, status };
}

/** A weekly's or monthly's size: the events it carries, chosen and ordered by rule. */
const PERIOD_EVENTS = { weekly: 20, monthly: 30 } as const;
/** A section is introduced once it carries this many events; one or two are read faster than introduced. */
const INTRO_EVENTS = 3;
/** The longest overview and introduction an issue prints; the brief asks for less, writers overshoot. */
const OVERVIEW_CHARS = { weekly: 240, monthly: 340 } as const;
const INTRO_CHARS = 90;
/** The brief's values for each kind: its name, its span and how long its overview should be. */
const BRIEF = {
  weekly: { kindName: "周报", span: "一周", sentences: "三句话", chars: "160" },
  monthly: { kindName: "月报", span: "个月", sentences: "三到四句话", chars: "240" },
} as const;

export const PeriodSchema = z.object({
  overview: z.string().max(1500).catch(""),
  sections: z.record(z.string(), z.string().max(600)).catch({}),
});

/**
 * The writer's brief for a week or month: its events as chosen, ordered and grouped by rule. It writes
 * the overview and the introductions of the sections large enough for one, and decides nothing about
 * what the issue carries.
 */
export function periodPrompt(kind: "weekly" | "monthly", startDate: string, endDateInclusive: string, groups: Array<{ label: string; items: Candidate[] }>, context?: SpaceContext) {
  const list = groups.map((g) => [`【${g.label}】`, ...g.items.map((e) => `- ${e.title}｜${e.summary.slice(0, 140)}`)].join("\n")).join("\n");
  const introduced = groups.filter((g) => g.items.length >= INTRO_EVENTS).map((g) => g.label);
  return {
    system: promptText("report-period", {
      ...BRIEF[kind],
      sections: introduced.length ? promptText("report-period-sections", { columns: introduced.map((l) => `「${l}」`).join("") }, context) : promptText("report-period-no-sections", {}, context),
      sectionsExample: introduced.length ? `{"${introduced[0]}": "..."}` : "{}",
    }, context),
    user: `本期：${startDate} 至 ${endDateInclusive}\n${list}`,
  };
}


/**
 * Whether written text names only what the listed items name: every capitalised or numbered Latin token
 * (Acme, Nova-2.5, X1), every figure of three or more digits or with a decimal point or percent (845,
 * 129.3, 40%) and every company of the vocabulary appears in the items' own words; a company may be named
 * in either language (谷歌 for Google).
 */
export function grounded(text: string, corpus: string, context?: SpaceContext): boolean {
  const pack = context ? configForContext(context) : null;
  const companyNames = Object.values(pack?.entities ?? ENTITIES).map(e => entityNames(e).map(n => n.toLowerCase()));
  const plain = new Set([...reportConfig(context).plainTerms, (pack?.siteName ?? SITE.name).toLowerCase()]);
  const known = corpus.toLowerCase();
  const companies = companyNames.filter((names) => names.some((n) => known.includes(n)));
  const named = (word: string) => plain.has(word) || known.includes(word) || companies.some((names) => names.includes(word));
  const words = (text.match(/[A-Za-z][A-Za-z0-9.+-]*/g) ?? []).map((w) => w.replace(/[.+-]+$/, "")).filter((w) => /[A-Z0-9]/.test(w));
  const figures = (text.match(/\d+(?:\.\d+)?%?/g) ?? []).filter((f) => f.length >= 3 || /[.%]/.test(f));
  const lower = text.toLowerCase();
  const mentioned = companyNames.filter((names) => names.some((n) => /\p{Script=Han}/u.test(n) && lower.includes(n)));
  return words.every((w) => named(w.toLowerCase())) && figures.every((f) => known.includes(f)) && mentioned.every((names) => companies.includes(names));
}

/** The leading whole sentences of a text that fit in `max` characters; null when not even the first does. */
export function fitted(text: string, max: number): string | null {
  let out = "";
  for (const sentence of text.trim().match(/[^。！？]+(?:[。！？]+[」”’）]*|$)/g) ?? []) {
    if ([...out + sentence].length > max) break;
    out += sentence;
  }
  return out.trim() || null;
}

/**
 * A weekly or monthly, compiled from the dailies dated in the period. Its events, their order and their
 * sections are decided by rule: the first event leads and the next three are the highlights. A model
 * only writes the overview and the introductions of sections with three or more events; text naming
 * anything the events do not name is not used, and overlong text keeps the leading sentences that fit.
 * Without a usable overview the issue is saved with none (see periodOverview).
 * An automatic run skips a complete period of quiet dailies without publishing an empty issue.
 */
async function composePeriod(kind: "weekly" | "monthly", key: string, startDate: string, endDateInclusive: string, reason: string | undefined, context: SpaceContext): Promise<ComposedReport | null> {
  const settings = reportConfig(context);
  const previous = await savedReport(kind, key, context);
  if (previous && reason === undefined) return { key, entries: previous.entries, status: "existing" };
  // The dailies' windows run from the edition time the day before the first to that time on the last.
  const start = beijingAt(addDays(startDate, -1), settings.editionTimes.daily);
  const end = beijingAt(endDateInclusive, settings.editionTimes.daily);
  const { entries, issues, hasEntries } = await periodEntries(startDate, endDateInclusive, context);
  const top = entries.slice(0, PERIOD_EVENTS[kind]);
  if (!top.length) {
    if (reason === undefined && !hasEntries && issues > 0) {
      // Before the site's first daily there was nothing to publish; missing later dailies are still a failure.
      const [{ first }] = await sql<{ first: string | null }[]>`SELECT min(key) AS first FROM reports WHERE space_id = ${context.spaceId} AND kind = 'daily'`;
      const firstDate = first && first > startDate ? first : startDate;
      const days = (Date.parse(endDateInclusive) - Date.parse(firstDate)) / 86400000 + 1;
      if (issues === days) return null;
    }
    throw new Error(`${kind} ${key}: no daily entries in the period`);
  }
  const selected = await candidates(start, end, context);
  const groups = sectionOrder(context)
    .map((label) => ({ label, items: top.filter((e) => sectionOf(e.category, context) === label) }))
    .filter((g) => g.items.length > 0);
  const corpus = [`${startDate} ${endDateInclusive}`, ...top.map((e) => `${e.title} ${e.summary}`)].join("\n");
  const model = await modelFor("report", context);
  let written: z.infer<typeof PeriodSchema> = { overview: "", sections: {} };
  let receiptId: number | null = null;
  try {
    const res = await chatJson({
      context, model, purpose: `report_${kind}`, subject: `report:${kind}:${key}`, promptVersion: promptVersionFor(context, "report-period", "report-period-sections", "report-period-no-sections"),
      ...periodPrompt(kind, startDate, endDateInclusive, groups, context), schema: PeriodSchema, temperature: 0.3, maxTokens: 2500,
    });
    written = res.data;
    receiptId = res.receiptId;
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    console.error(JSON.stringify({ level: "warn", msg: "period writer failed; the issue goes out with its plain overview", report: `${kind}:${key}`, error: logError(error) }));
  }
  const usable = (text: string | undefined, max: number) => {
    const fit = fitted(text ?? "", max);
    return fit && grounded(fit, corpus, context) ? fit : null;
  };
  // Without a usable one the read layer says what the issue carries, naming only what is still public.
  const overview = usable(written.overview, OVERVIEW_CHARS[kind]);
  const intro = (g: { label: string; items: Candidate[] }) => g.items.length >= INTRO_EVENTS ? usable(written.sections[g.label], INTRO_CHARS) : null;
  const [lead] = top as [Candidate, ...Candidate[]];
  const content = {
    kind,
    title: kind === "weekly" ? `${configForContext(context).siteName} 周报 · ${key}` : `${configForContext(context).siteName} 月报 · ${key}`,
    ...(kind === "weekly" ? { isoLabel: key } : { monthLabel: key }),
    periodStart: startDate,
    periodEnd: endDateInclusive,
    headline: lead.title,
    leadItemId: lead.itemId,
    highlights: top.slice(1, 4).map((e) => e.itemId),
    overview,
    themes: groups.map((g) => ({ heading: g.label, summary: intro(g), storyRefs: g.items.map(({ category: _c, factKey: _f, ...e }) => e) })),
    storyOrder: top.map((e) => e.itemId),
    metrics: { totalStories: top.length, selectedCount: selected.length, reportsCovered: issues },
    generator: { version: promptVersionFor(context, "report-period", "report-period-sections", "report-period-no-sections"), configVersion: context.configVersion, model, written: overview !== null },
  };
  const status = await saveReport(kind, key, start, end, content, reason, model, receiptId === null ? [] : [receiptId], context);
  return { key, entries: top.length, status };
}

export async function composeWeekly(label: string, reason?: string, context?: SpaceContext) {
  const range = isoWeekRange(label);
  if (!range) throw new Error(`bad week label ${label}`);
  return composePeriod("weekly", label, range.start, range.end, reason, await reportContext(context));
}

export async function composeMonthly(label: string, reason?: string, context?: SpaceContext) {
  const range = monthRange(label);
  if (!range) throw new Error(`bad month label ${label}`);
  return composePeriod("monthly", label, range.start, range.end, reason, await reportContext(context));
}

/** The newest daily due by `now`: today's from its edition time (Beijing), yesterday's before. */
export function dueDaily(now = new Date(), context?: SpaceContext): string {
  const today = beijingDate(now);
  return beijingTime(now) >= reportConfig(context).editionTimes.daily ? today : addDays(today, -1);
}

/** The newest weekly due by `now`: the last complete ISO week from its edition time on Monday, the one before until then. */
export function dueWeekly(now = new Date(), context?: SpaceContext): string {
  const today = beijingDate(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const due = dow > 0 || beijingTime(now) >= reportConfig(context).editionTimes.weekly;
  return isoWeekLabel(addDays(today, -dow - (due ? 7 : 14)));
}

/** The newest monthly due by `now`: the last complete month from its edition time on the 1st, the one before until then. */
export function dueMonthly(now = new Date(), context?: SpaceContext): string {
  const [y, m, d] = beijingDate(now).split("-").map(Number) as [number, number, number];
  const due = d > 1 || beijingTime(now) >= reportConfig(context).editionTimes.monthly;
  const back = due ? 1 : 2;
  const month = (y * 12 + (m - 1) - back);
  return `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}`;
}

const nextWeek = (label: string) => isoWeekLabel(addDays(isoWeekRange(label)!.start, 7));
const nextMonth = (label: string) => {
  const [y, m] = label.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * The scheduled run (every half hour): every issue due by `now` that does not exist yet, oldest first.
 * The newest one appears at the first run after it falls due (above); a long stop or an older gap is
 * filled too. A kind with no issue yet only gets its latest due one. An issue that fails does not hold
 * up the others; at most `limit` issues are written per run, the next run continues.
 */
export async function composeDueReports(now = new Date(), limit = 8, context?: SpaceContext): Promise<{ generated: string[]; failed: string[] }> {
  context = await reportContext(context);
  const generated: string[] = [];
  const failed: string[] = [];
  const kinds: Array<{ kind: ReportKind; due: string; next: (k: string) => string; end: (k: string) => string; compose: (k: string) => Promise<ComposedReport | null> }> = [
    { kind: "daily", due: dueDaily(now, context), next: (k) => addDays(k, 1), end: (k) => k, compose: (key) => composeDaily(key, undefined, context) },
    { kind: "weekly", due: dueWeekly(now, context), next: nextWeek, end: (k) => isoWeekRange(k)!.end, compose: (key) => composeWeekly(key, undefined, context) },
    { kind: "monthly", due: dueMonthly(now, context), next: nextMonth, end: (k) => monthRange(k)!.end, compose: (key) => composeMonthly(key, undefined, context) },
  ];
  // Weeklies and monthlies sum up dailies: a period that ended before the site's first daily has nothing to sum
  // up and is not due (a site started mid-month would otherwise fail that month's issue on every run).
  const [{ first: firstDaily }] = await sql<{ first: string | null }[]>`SELECT min(key) AS first FROM reports WHERE space_id = ${context.spaceId} AND kind = 'daily'`;
  kinds: for (const k of kinds) {
    const have = new Set((await sql<{ key: string }[]>`SELECT key FROM reports WHERE space_id = ${context.spaceId} AND kind = ${k.kind}`).map((r) => r.key));
    const first = [...have].sort()[0] ?? k.due;
    for (let key = first; key <= k.due; key = k.next(key)) {
      if (have.has(key)) continue;
      if (k.kind !== "daily" && (!firstDaily || k.end(key) < firstDaily)) continue;
      if (shutdownSignal.signal.aborted || generated.length >= limit) break kinds;
      try {
        const result = await k.compose(key);
        if (result?.status === "stale") break kinds;
        if (result?.status === "published") generated.push(`${k.kind}:${key}`);
      } catch (error) {
        // An issue interrupted by the stop is not a failure: it is written after the restart.
        if (shutdownSignal.signal.aborted) break kinds;
        failed.push(`${k.kind}:${key}`);
        console.error(JSON.stringify({ level: "error", msg: "report failed", report: `${k.kind}:${key}`, error: logError(error) }));
      }
    }
  }
  if (failed.length) throw new Error(`reports: ${failed.join(", ")} failed${generated.length ? `; ${generated.join(", ")} written` : ""}`);
  return { generated, failed };
}
