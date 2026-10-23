// A classification correction moves the same frozen entry; it never composes another issue or pays
// a writer. The override, publication, report revisions and audit commit in the caller's transaction.
import type { Tx } from "../db.ts";
import { emit } from "../modules.ts";
import { DEFAULT_SPACE_ID, resolveSpaceContext, type SpaceContext } from "../spaces/context.ts";
import { reportConfig } from "./config.ts";
import { sectionOrder, sectionOf } from "./edition.ts";

interface Entry { itemId: string; followUp?: string; firstParty?: boolean; role?: string; [key: string]: unknown }
interface Group { label?: string; heading?: string; summary?: unknown; items?: Entry[]; storyRefs?: Entry[]; [key: string]: unknown }
interface Content { sections?: Group[]; themes?: Group[]; metrics?: Record<string, number>; [key: string]: unknown }

/** Moves the item to its new section in every issue that carries it; says whether any issue changed. */
export async function correctReportClassification(tx: Tx, articleId: string, reason: string, context?: SpaceContext): Promise<boolean> {
  context = await resolveSpaceContext(context?.spaceId ?? DEFAULT_SPACE_ID, context?.configVersion, tx);
  const [space] = await tx<{ enabled: boolean; active_config_version: string | null }[]>`
    SELECT enabled, active_config_version FROM spaces WHERE id = ${context.spaceId} FOR SHARE`;
  if (!space?.enabled || space.active_config_version !== context.configVersion) return false;
  const order = sectionOrder(context);
  const release = reportConfig(context).release;
  const [item] = await tx<{ category: string | null }[]>`SELECT category FROM publications WHERE space_id=${context.spaceId} AND article_id=${articleId}`;
  if (!item?.category) return false;
  const reports = await tx<{ id: number; kind: string; content: Content; revision: number; generated_at: Date; config_version: string | null }[]>`
    SELECT id,kind,content,revision,generated_at,config_version FROM reports
    WHERE space_id = ${context.spaceId} AND (content @> ${tx.json({ sections: [{ items: [{ itemId: articleId }] }] })}
       OR content @> ${tx.json({ themes: [{ storyRefs: [{ itemId: articleId }] }] })})
    ORDER BY id FOR UPDATE`;
  let changed = false;
  for (const report of reports) {
    const content = structuredClone(report.content);
    const daily = report.kind === "daily";
    const groups = (daily ? content.sections : content.themes) ?? [];
    const labelKey = daily ? "label" : "heading";
    const entriesKey = daily ? "items" : "storyRefs";
    const from = groups.find(g => g[entriesKey]?.some(e => e.itemId === articleId));
    // Older, hand-written theme headings are not taxonomy columns; do not reinterpret their prose.
    if (!from || !order.includes(from[labelKey] ?? "")) continue;
    const label = sectionOf(item.category, context);
    if (from[labelKey] !== label) {
      const moving = from[entriesKey]!.filter(e => e.itemId === articleId);
      from[entriesKey] = from[entriesKey]!.filter(e => e.itemId !== articleId);
      let target = groups.find(g => g[labelKey] === label);
      if (!target) { target = { [labelKey]: label, [entriesKey]: [] }; groups.push(target); }
      target[entriesKey]!.push(...moving);
      if (!daily) { from.summary = null; target.summary = null; }
    }
    const arranged = groups.filter(g => g[entriesKey]?.length).sort((a, b) => order.indexOf(a[labelKey]!) - order.indexOf(b[labelKey]!));
    if (daily) {
      content.sections = arranged;
      // The release figure (dailyMetrics) follows the new classification; without a RELEASE kind there is none.
      if (release) {
        const entries = arranged.flatMap(g => g.items ?? []);
        const rows = await tx<{ article_id: string; category: string | null; tags: string[] }[]>`
          SELECT article_id,category,tags FROM publications WHERE space_id=${context.spaceId} AND article_id IN ${tx(entries.map(e => e.itemId))}`;
        const byId = new Map(rows.map(r => [r.article_id, r]));
        content.metrics = { ...content.metrics, modelsReleased: entries.filter(e => {
          const p = byId.get(e.itemId);
          return p && (p.category === release.category && p.tags.includes(release.tag)) && !e.followUp && (e.firstParty || e.role === "官方" || e.role === "X·官方");
        }).length };
      } else if (content.metrics?.modelsReleased !== undefined) {
        delete content.metrics.modelsReleased;
      }
    } else content.themes = arranged;
    if (JSON.stringify(content) === JSON.stringify(report.content)) continue;
    await tx`INSERT INTO report_revisions (report_id,revision,content,generated_at,reason,config_version)
      VALUES (${report.id},${report.revision},${tx.json(report.content as never)},${report.generated_at},${`classification ${articleId}: ${reason}`},${report.config_version})`;
    await tx`UPDATE reports SET content=${tx.json(content as never)},config_version=${context.configVersion},revision=revision+1,updated_at=now() WHERE id=${report.id}`;
    changed = true;
  }
  if (changed) await emit("reportsChanged", { reason: `report classification ${articleId}` }, tx);
  return changed;
}
