// Job queue on PostgreSQL (pg-boss). Every queue is declared here with the data its jobs carry and its
// retry policy: business code enqueues by name, the worker registers one handler per queue (jobs/*.ts),
// and both sides are checked against JobData, so a payload cannot drift between producer and consumer.
// A module declares its own queues (modules.ts ModuleQueue), typed by the queue in the same way.
import { PgBoss, type SendOptions, type WorkOptions } from "pg-boss";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { DEFAULT_SPACE_ID, resolveSpaceContext, type SpaceContext } from "../spaces/context.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { logError } from "../lib/log-error.ts";
import { serverModules, type ModuleQueue } from "../modules.ts";
export { shutdownSignal } from "../lib/shutdown.ts";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export interface ProcessingJobContext {
  context?: SpaceContext;
  inputRevision?: number;
  generation?: number;
  groupingGeneration?: number;
}

export interface JobData {
  "content.analyze": { articleId: string; attemptTag?: string } & ProcessingJobContext;
  "content.extract-body": { articleId: string } & ProcessingJobContext;
  "events.group": { articleId: string; signalOnly?: boolean } & ProcessingJobContext;
  "events.digest": { storyId: number } & { context?: SpaceContext };
  "sources.fetch": { sourceId: string; force?: boolean } & { context?: SpaceContext };
  "sources.fetch-x": { key: string; sourceIds: string[] } & { context?: SpaceContext };
  "sources.mp": { sourceId: string; reason?: "schedule" | "manual" } & { context?: SpaceContext };
  "notify.selected": { articleId: string; attempt?: number; context?: SpaceContext };
  "notify.report": { reportId: number; attempt?: number; context?: SpaceContext };
  "publication.republish-source": { sourceId: string; context?: SpaceContext };
  "media.prepare": { articleId: string; context?: SpaceContext } | { url: string; mode: string };
}
export type QueueName = keyof JobData;

export const QUEUES = {
  analyze: "content.analyze",
  extractBody: "content.extract-body",
  group: "events.group",
  digest: "events.digest",
  fetchSource: "sources.fetch",
  fetchXShard: "sources.fetch-x",
  mpCheck: "sources.mp",
  notifySelected: "notify.selected",
  notifyReport: "notify.report",
  republishSource: "publication.republish-source",
  prepareMedia: "media.prepare",
} as const satisfies Record<string, QueueName>;

export type QueueOptions = NonNullable<Parameters<PgBoss["createQueue"]>[1]>;

/** Queue definitions in one place; created on first use by any process. */
const QUEUE_OPTIONS: Record<QueueName, QueueOptions> = {
  [QUEUES.analyze]: { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.extractBody]: { policy: "short", retryLimit: 2, retryDelay: 120, expireInSeconds: 300 },
  [QUEUES.group]: { policy: "short", retryLimit: 4, retryDelay: 20, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.digest]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.fetchSource]: { policy: "short", retryLimit: 0, expireInSeconds: 600 },
  [QUEUES.fetchXShard]: { policy: "short", retryLimit: 0, expireInSeconds: 900 },
  [QUEUES.mpCheck]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.notifySelected]: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  [QUEUES.notifyReport]: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  [QUEUES.republishSource]: { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 3600 },
  [QUEUES.prepareMedia]: { policy: "short", retryLimit: 1, retryDelay: 120, expireInSeconds: 600 },
};

const ensured = new Set<string>();

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const b = new PgBoss({ connectionString: config.databaseUrl, max: 4, schema: "pgboss", application_name: "aihot-jobs" });
    b.on("error", (err) => console.error("[pg-boss]", logError(err)));
    try {
      await b.start();
      boss = b;
      return b;
    } catch (error) {
      await b.stop({ graceful: false }).catch((cleanup) => console.error("[pg-boss] startup cleanup", logError(cleanup)));
      throw error;
    } finally {
      // A temporary connection error must not leave every caller sharing a rejected promise.
      starting = null;
    }
  })();
  return starting;
}

/** Let in-flight backups and paid calls finish; process supervisors wait longer for cleanup. */
export const STOP_TIMEOUT_MS = 470_000;

export async function stopBoss(): Promise<void> {
  shutdownSignal.abort();
  if (boss) {
    const draining = boss;
    const started = performance.now();
    const report = (phase: "start" | "waiting" | "complete") => {
      // Read this process's workers, including scheduled/internal work. Never log payloads or errors:
      // they can contain credentials and reader data. Multiple workers on one queue count together.
      const queues = new Map<string, { queue: string; count: number; oldestMs: number }>();
      const now = Date.now();
      for (const work of draining.getWipData({ includeInternal: true })) {
        if (!work.count) continue;
        const item = queues.get(work.name) ?? { queue: work.name, count: 0, oldestMs: 0 };
        item.count += work.count;
        item.oldestMs = Math.max(item.oldestMs, work.lastJobStartedOn === null ? 0 : Math.max(0, now - work.lastJobStartedOn));
        queues.set(work.name, item);
      }
      const jobs = [...queues.values()].sort((a, b) => a.queue.localeCompare(b.queue));
      console.log(JSON.stringify({ level: "info", msg: "queue drain", phase,
        elapsedMs: Math.round(performance.now() - started), count: jobs.reduce((sum, job) => sum + job.count, 0), jobs }));
    };
    report("start");
    const progress = setInterval(() => report("waiting"), 10_000);
    progress.unref();
    try {
      await draining.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
      report("complete");
    } finally {
      clearInterval(progress);
    }
  }
  boss = null;
  starting = null;
}

export async function ensureQueue(name: string, options: QueueOptions = QUEUE_OPTIONS[name as QueueName] ?? {}): Promise<void> {
  if (ensured.has(name)) return;
  const b = await getBoss();
  const existing = await b.getQueue(name);
  if (!existing) await b.createQueue(name, options);
  ensured.add(name);
}

function queueDb(tx: Db) {
  return { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) };
}

/** Capture scope at enqueue time; a restarted worker must use this exact version. */
export async function scopeJobData<Q extends QueueName>(name: Q, data: JobData[Q], db: Db = sql, replay = false): Promise<JobData[Q]> {
  const value = data as ProcessingJobContext & { articleId?: string; reportId?: number; sourceId?: string; sourceIds?: string[]; storyId?: number };
  let owner: string | undefined;
  let version: string | null = null;
  let revision: number | undefined;
  let generation: number | undefined;
  let groupingGeneration: number | undefined;
  if ([QUEUES.analyze, QUEUES.extractBody, QUEUES.group].includes(name as never) && value.articleId) {
    const [row] = await db<{ space_id: string; processing_config_version: string | null; revision: number; processing_generation: number; grouping_generation: number }[]>`
      SELECT space_id, processing_config_version, revision, processing_generation, grouping_generation FROM articles WHERE id = ${value.articleId}`;
    if (row) { owner = row.space_id; version = row.processing_config_version; revision = row.revision; generation = row.processing_generation; groupingGeneration = row.grouping_generation; }
  } else if ([QUEUES.notifySelected, QUEUES.prepareMedia].includes(name as never) && value.articleId) {
    const [row] = await db<{ space_id: string; config_version: string | null }[]>`SELECT space_id, processing_config_version AS config_version FROM articles WHERE id = ${value.articleId}`;
    owner = row?.space_id; version = row?.config_version ?? null;
  } else if (name === QUEUES.notifyReport && value.reportId) {
    const [row] = await db<{ space_id: string; config_version: string | null }[]>`SELECT space_id, config_version FROM reports WHERE id = ${value.reportId}`;
    owner = row?.space_id; version = row?.config_version ?? null;
  } else if ([QUEUES.fetchSource, QUEUES.mpCheck, QUEUES.fetchXShard, QUEUES.republishSource].includes(name as never)) {
    const ids = value.sourceIds ?? (value.sourceId ? [value.sourceId] : []);
    const rows = ids.length ? await db<{ space_id: string }[]>`SELECT DISTINCT space_id FROM sources WHERE id = ANY(${ids}::text[])` : [];
    if (rows.length > 1) throw new Error("A source job cannot span spaces");
    owner = rows[0]?.space_id;
  } else if (name === QUEUES.digest && value.storyId) {
    const [row] = await db<{ space_id: string }[]>`SELECT space_id FROM stories WHERE id = ${value.storyId}`;
    owner = row?.space_id;
  }
  if (!owner) return data; // Existing missing-object jobs still finish without a write.
  if (revision !== undefined && owner !== DEFAULT_SPACE_ID && !version) throw new Error("A channel article requires its recorded configuration version");
  if (value.context && value.context.spaceId !== owner) throw new Error("Job space does not own its subject");
  if (replay && !value.context && owner !== DEFAULT_SPACE_ID) throw new Error("Unscoped legacy jobs belong only to the default space");
  const context = await resolveSpaceContext(owner, value.context?.configVersion ?? version ?? undefined, db);
  return { ...data, context, ...(revision === undefined ? {} : { inputRevision: value.inputRevision ?? revision, generation: value.generation ?? generation, ...(name === QUEUES.group ? { groupingGeneration: value.groupingGeneration ?? groupingGeneration } : {}) }) };
}

/** Enqueues a job. With `tx`, the job commits atomically with the caller's business write. */
export async function enqueue<Q extends QueueName>(name: Q, data: JobData[Q], options: SendOptions = {}, tx?: Db): Promise<string | null> {
  await ensureQueue(name);
  const b = await getBoss();
  const scoped = await scopeJobData(name, data, tx ?? sql);
  return b.send(name, scoped, tx ? { ...options, db: queueDb(tx) } : options);
}

/** Enqueues a job on a module's queue. With `tx`, the job commits atomically with the caller's business write. */
export async function enqueueOn<T extends object>(queue: ModuleQueue<T>, data: T, options: SendOptions = {}, tx?: Db): Promise<string | null> {
  await ensureQueue(queue.name, queue.options);
  const b = await getBoss();
  return b.send(queue.name, data, tx ? { ...options, db: queueDb(tx) } : options);
}

/** A receipt release also wakes jobs (e.g. grouping/embeddings) that exhausted their queue retries.
 * The release must follow the failed attempt's start: it may arrive while that attempt is finishing,
 * but cannot keep reviving attempts started after it.
 * Reading the durable audit also recovers a crash between the release and this sweep.
 */
export async function retryReleasedReceiptJobs(): Promise<number> {
  const b = await getBoss();
  return sql.begin(async (tx) => {
    const jobs = await tx<{ id: string; name: string }[]>`
      SELECT j.id, j.name FROM pgboss.job j
      WHERE j.state = 'failed'
        AND EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'receipt.release'
                    AND a.subject = 'receipt:' || (j.output->>'receiptId') AND a.created_at > j.started_on)
      ORDER BY j.completed_on LIMIT 200 FOR UPDATE OF j SKIP LOCKED`;
    for (const job of jobs) await b.retry(job.name, job.id, { db: queueDb(tx) });
    return jobs.length;
  });
}

/** The worker's handler for one queue (jobs/*.ts), called with each job's data. */
export async function work<Q extends QueueName>(boss: PgBoss, name: Q, options: WorkOptions, handler: (data: JobData[Q]) => Promise<unknown>): Promise<void> {
  await ensureQueue(name);
  await boss.work<JobData[Q]>(name, options, async ([job]) => {
    if (!job) return undefined;
    const data = await scopeJobData(name, job.data, sql, true);
    const input = data as ProcessingJobContext & { articleId?: string };
    if (input.articleId && input.inputRevision !== undefined) {
      const [current] = await sql`SELECT 1 FROM articles WHERE id = ${input.articleId} AND revision = ${input.inputRevision}
        AND processing_generation = ${input.generation ?? 0}
        AND (${name !== QUEUES.group} OR grouping_generation = ${input.groupingGeneration ?? 0})
        AND (processing_config_version IS NULL OR processing_config_version = ${input.context?.configVersion ?? null})`;
      if (!current) return { state: "stale" };
    }
    return handler(data);
  });
}

/** The worker's handlers for the site's modules' queues. */
export async function workModuleQueues(boss: PgBoss): Promise<void> {
  for (const queue of serverModules().flatMap((m) => m.queues ?? [])) {
    await ensureQueue(queue.name, queue.options);
    await boss.work(queue.name, { ...queue.worker, perJobResults: true }, async (jobs) => {
      const output = await queue.run(jobs.map(job => job.data) as never[]);
      return jobs.map(job => ({ id: job.id, status: "completed" as const, output }));
    });
  }
}

// Scheduled task bookkeeping: every run leaves a row, so operators see the latest result.

export async function recordRun<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO job_runs (job) VALUES (${job}) RETURNING id`;
  try {
    const result = await fn();
    const detail = result && typeof result === "object" ? result : { result };
    await sql`UPDATE job_runs SET status = 'ok', finished_at = now(), detail = ${sql.json(detail as never)} WHERE id = ${row!.id}`;
    return result;
  } catch (error) {
    await sql`UPDATE job_runs SET status = 'failed', finished_at = now(), error = ${String(error).slice(0, 4000)} WHERE id = ${row!.id}`;
    throw error;
  }
}
