import type { SpaceContext } from "../spaces/context.ts";
import { notificationContext } from "./context.ts";
import { deliverContent } from "./deliver.ts";
import { reportContent } from "./report-content.ts";
import type { PushOutcome } from "./selected.ts";

/** A new edition is sent once per channel target; regeneration does not create a new identity. */
export async function pushReport(reportId: number, context?: SpaceContext): Promise<PushOutcome> {
  context = await notificationContext(context);
  const content = await reportContent(reportId, context);
  if (content.status !== "ready") return content;
  const targets = await deliverContent({ subjectKind: "report", subjectId: String(reportId), dedupeKey: `report:${reportId}`,
    contentAt: content.contentAt, card: content.card }, context);
  return { status: targets.some(t => t.status === "sent") ? "pushed" : "skipped", targets, reason: targets.length ? undefined : "no new target" };
}
