// Report pushes render the public projection again before each send and during manual recovery.
import type { ReportKind } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { configForContext, type SpaceContext } from "../spaces/context.ts";
import { loadReport } from "../publication/reports.ts";
import { siteUrl } from "../publication/links.ts";
import { notificationContext, withNotificationSpace } from "./context.ts";

const literal = (text: string) => text.replace(/[&<>*_~`[\]]/g, c => `&#${c.charCodeAt(0)};`);

export async function reportContent(id: number, context?: SpaceContext) {
  context = await notificationContext(context);
  if (!Number.isSafeInteger(id) || id < 1) return { status: "skipped", reason: "report not published" } as const;
  const [row] = await sql<{ kind: ReportKind; key: string; window_end: Date; created_at: Date }[]>`
    SELECT kind, key, window_end, created_at FROM reports WHERE space_id = ${context.spaceId} AND id = ${id}`;
  if (!row || row.window_end > new Date()) return { status: "skipped", reason: "report not published" } as const;
  return withNotificationSpace(context, async () => {
    const report = await loadReport(row.kind, row.key);
    if (!report) return { status: "skipped", reason: "report not published" } as const;
    const lead = report.lead;
    const summary = lead?.leadParagraph ?? report.overview;
    const url = siteUrl(`/${row.kind}/${encodeURIComponent(row.key)}`);
    const name = configForContext(context!).siteName;
    const card = {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: report.title } },
      body: { elements: [
        ...(lead ? [{ tag: "markdown", content: `**${literal(lead.title)}**` }] : []),
        ...(summary ? [{ tag: "markdown", content: literal(summary) }] : []),
        { tag: "button", text: { tag: "plain_text", content: `在 ${name} 阅读` }, type: "primary", behaviors: [{ type: "open_url", default_url: url }] },
      ] },
    };
    return { status: "ready", contentAt: row.created_at, card } as const;
  });
}
