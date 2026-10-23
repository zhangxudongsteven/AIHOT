// Content pushes: newly selected items, and the images they need prepared first.
import type { PgBoss } from "pg-boss";
import { notificationContext, withNotificationSpace } from "../notify/context.ts";
import { pushReport } from "../notify/reports.ts";
import { pushSelected } from "../notify/selected.ts";
import { prepareArticleMedia, warmShareImage } from "../media/prepare.ts";
import { convertAnimated } from "../media/images.ts";
import { enqueue, QUEUES, work } from "./queue.ts";

const MAX_RETRIES = 6;

export async function registerNotifyJobs(boss: PgBoss) {
  await work(boss, QUEUES.notifySelected, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async ({ articleId, attempt = 0, context: queuedContext }) => {
    const context = await notificationContext(queuedContext);
    // The push makes chat apps unfurl the link: have its share image ready (first attempt only).
    if (!attempt) await withNotificationSpace(context, () => warmShareImage(articleId));
    const outcome = await pushSelected(articleId, undefined, context);
    if (outcome.status === "retry" && attempt < MAX_RETRIES) {
      await enqueue(QUEUES.notifySelected, { articleId, context, attempt: attempt + 1 }, { startAfter: outcome.after });
    }
    return outcome;
  });

  await work(boss, QUEUES.notifyReport, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async ({ reportId, context }) =>
    pushReport(reportId, context));

  await work(boss, QUEUES.prepareMedia, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async (data) =>
    "articleId" in data
      ? withNotificationSpace(await notificationContext(data.context), () => prepareArticleMedia(data.articleId))
      : { animatedSaved: await convertAnimated(data.url, data.mode) });
}
