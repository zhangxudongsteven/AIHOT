// Deliberate cutover after the scoped bridge is deployed and old writers are stopped.
// This is not part of automatic release migrations: an old binary cannot safely run afterwards.
import type postgres from "postgres";

const SCOPED_TABLES = [
  "spaces", "sources", "articles", "article_revisions", "article_discoveries", "fetch_runs", "analyses",
  "receipts", "receipt_attempts", "publications", "selected_ledger", "selected_state", "stories", "facts", "fact_articles", "story_signals",
  "story_aliases", "story_links", "grouping_decisions", "grouping_overrides", "story_digests", "story_heat_hourly", "hot_rankings",
  "reports", "notify_targets", "deliveries", "delivery_leases", "quote_translations", "translations", "translation_attempts", "space_budgets",
];

/** Also used by isolated database tests; no rows, article identities or history are rewritten. */
export async function cutoverSpaceIdentity(db: postgres.Sql): Promise<{ validated: number; changed: boolean }> {
  const session = await db.reserve();
  try {
    await session`SET lock_timeout = '1s'`;
    await session`SET statement_timeout = '30min'`;
    const [ready] = await session`
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.articles_space_identity_idx') AND i.indisvalid AND i.indisunique`;
    if (!ready) throw new Error("Apply the space expansion migrations before cutover");
    const [reportReady] = await session`SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.reports_space_kind_key_uidx') AND i.indisvalid AND i.indisunique`;
    if (!reportReady) throw new Error("Apply the channel report migrations before cutover");
    const [quoteReady] = await session`SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.quote_translations_space_tweet_idx') AND i.indisvalid AND i.indisunique`;
    if (!quoteReady) throw new Error("Apply the channel translation migrations before cutover");
    const [configured] = await session`SELECT 1 FROM spaces s JOIN space_configs c
      ON c.space_id = s.id AND c.config_version = s.active_config_version WHERE s.id = 'default'`;
    if (!configured) throw new Error("Initialize the default space before validating its historical rows");
    const constraints = await session<{ table_name: string; name: string }[]>`
      SELECT c.relname AS table_name, con.conname AS name FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = ANY(${SCOPED_TABLES}::text[]) AND NOT con.convalidated
        AND (con.conname ~ '_space(_.*)?_fk(ey)?$|_config_fk$|_scope_pair_check$' OR con.conname = 'spaces_active_config_fk')
      ORDER BY c.relname, con.conname`;
    for (const constraint of constraints) {
      await session`ALTER TABLE ${session(constraint.table_name)} VALIDATE CONSTRAINT ${session(constraint.name)}`;
    }
    const [legacy] = await session`SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.articles'::regclass AND conname = 'articles_identity_key_key' AND contype = 'u'`;
    if (legacy) {
      await session`SET statement_timeout = '10s'`;
      await session`ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_identity_key_key`;
    }
    const [legacyReport] = await session`SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.reports'::regclass AND conname = 'reports_kind_key_key' AND contype = 'u'`;
    if (legacyReport) await session`ALTER TABLE reports DROP CONSTRAINT reports_kind_key_key`;
    const [legacyQuote] = await session`SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.quote_translations'::regclass AND conname = 'quote_translations_pkey' AND contype = 'p'`;
    if (legacyQuote) await session`ALTER TABLE quote_translations DROP CONSTRAINT quote_translations_pkey`;
    return { validated: constraints.length, changed: !!legacy || !!legacyReport || !!legacyQuote };
  } finally {
    try { await session`RESET lock_timeout`; await session`RESET statement_timeout`; }
    finally { session.release(); }
  }
}

if (import.meta.main) {
  if (!process.argv.includes("--writers-stopped") || !process.argv.includes("--backup-verified")) {
    throw new Error("Stop all old API/worker/import writers and verify a restorable backup, then pass --writers-stopped --backup-verified. This cutover prevents rollback to an unscoped binary.");
  }
  const { sql, closeDb } = await import("@aihot/backend/db");
  try { console.log(JSON.stringify(await cutoverSpaceIdentity(sql))); }
  finally { await closeDb(); }
}
