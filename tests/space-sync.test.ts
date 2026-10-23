import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { defaultSpaceConfig, resolveSpaceContext, storeSpaceConfig, type SpaceContext } from '@aihot/backend/spaces/context';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';
import { selectedSnapshot, selectedChanges, SnapshotRequiredError } from '@aihot/backend/publication/v1';
import { withPublicationSpace, type PublicSpace } from '@aihot/backend/publication/context';
import { setVisibility } from '@aihot/backend/admin/content';
import { decodeCursor, encodeCursor } from '@aihot/backend/lib/cursor';

after(async () => {
  await stopBoss();
  await closeDb();
});
const at = new Date(Date.now() - 60_000);

async function channel(name: string) {
  const id = `sync-${tag()}`;
  await sql`INSERT INTO spaces(id,slug,enabled) VALUES(${id},${id},true)`;
  const value = structuredClone(defaultSpaceConfig());
  value.siteName = name;
  const context = await storeSpaceConfig(id, value);
  await sql`UPDATE spaces SET active_config_version=${context.configVersion} WHERE id=${id}`;
  const space: PublicSpace = { id, slug: id, name, configVersion: context.configVersion };
  return { context, space };
}

async function publish(context: SpaceContext, name: string) {
  const source = `sync-source-${tag()}`;
  await sql`INSERT INTO sources(id,space_id,name,kind,tier) VALUES(${source},${context.spaceId},${name},'rss','T1')`;
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.invalid/${tag()}`, title: `${name}公告`,
    bodyText: '这是一则用于核验公开同步隔离的本地公告。', bodyStatus: 'ok', publishedAt: at, via: 'fetch',
  }, sql, context);
  await sql`INSERT INTO analyses(space_id,article_id,input_revision,origin,config_version,relevance,title_zh,summary_zh,selected,score,category)
    VALUES(${context.spaceId},${articleId},1,'rule',${context.configVersion},'pass',${`${name}公告`},${`${name}摘要`},true,100,'ai-models')`;
  const result = await publishArticle(articleId, { releasedAt: at });
  assert.equal(result!.ledger, 'upsert');
  return articleId;
}

const within = <T>(space: PublicSpace, read: () => T | Promise<T>) => withPublicationSpace(space, read);
const idOf = (change: Awaited<ReturnType<typeof selectedChanges>>['changes'][number]) =>
  change.op === 'remove' ? change.id : change.item.id;

function legacy(cursor: string) {
  const { s: _space, ...payload } = decodeCursor<Record<string, unknown>>('ax1', cursor);
  return encodeCursor('ax1', payload);
}

test('real publishers share ordered sequence allocation while each channel synchronizes only its own upserts and removals', async () => {
  const a = await channel('同步甲');
  const b = await channel('同步乙');
  const a1 = await publish(a.context, '甲一');
  const b1 = await publish(b.context, '乙一');
  const a2 = await publish(a.context, '甲二');
  const b2 = await publish(b.context, '乙二');
  const rows = await sql<{ article_id: string; space_id: string; seq: number }[]>`SELECT article_id,space_id,seq FROM selected_ledger
    WHERE article_id=ANY(${[a1, b1, a2, b2]}::text[]) ORDER BY seq`;
  assert.deepEqual(rows.map(row => row.article_id), [a1, b1, a2, b2]);
  assert.deepEqual(rows.map(row => row.space_id), [a.space.id, b.space.id, a.space.id, b.space.id]);
  const snapshots = await Promise.all([a, b].map(ch => within(ch.space, () => selectedSnapshot({ limit: 1, page: null }))));
  assert.ok(snapshots.every(s => s.hasMore && s.nextPage));
  await assert.rejects(within(b.space, () => selectedSnapshot({ limit: 10, page: snapshots[0]!.nextPage })), SnapshotRequiredError);
  for (const [ch, ids, snapshot] of [[a, [a1, a2], snapshots[0]!], [b, [b1, b2], snapshots[1]!]] as const) {
    const page = await within(ch.space, () => selectedSnapshot({ limit: 10, page: snapshot.nextPage }));
    assert.deepEqual(new Set([...snapshot.items, ...page.items].map(item => item.id)), new Set(ids));
    assert.ok([...snapshot.items, ...page.items].every(item => item.links.aihot.includes(`/channels/${ch.space.slug}/`)));
  }
  const a3 = await publish(a.context, '甲三');
  const b3 = await publish(b.context, '乙三');
  await setVisibility(a1, { visibility: 'withdrawn', reason: 'local test', version: 0 }, 'test');
  await setVisibility(b2, { visibility: 'withdrawn', reason: 'local test', version: 0 }, 'test');
  for (const [ch, snapshot, expected] of [[a, snapshots[0]!, [a3, a1]], [b, snapshots[1]!, [b3, b2]]] as const) {
    let cursor = snapshot.cursor;
    const seen: Array<{ id: string; op: string }> = [];
    for (let n = 0; n < 10; n++) {
      const page = await within(ch.space, () => selectedChanges({ cursor, limit: 1 }));
      seen.push(...page.changes.map(change => ({ id: idOf(change), op: change.op })));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    assert.deepEqual(seen, [{ id: expected[0], op: 'upsert' }, { id: expected[1], op: 'remove' }]);
  }
});

test('own tombstones survive deleting the article and its publication without crossing channel boundaries', async () => {
  const a = await channel('删除甲');
  const b = await channel('删除乙');
  const a1 = await publish(a.context, '待删除甲');
  const b1 = await publish(b.context, '待删除乙');
  const own = await within(a.space, () => selectedSnapshot({ limit: 10, page: null }));
  const foreign = await within(b.space, () => selectedSnapshot({ limit: 10, page: null }));
  await setVisibility(a1, { visibility: 'withdrawn', reason: 'local deletion', version: 0 }, 'test');
  await sql`DELETE FROM articles WHERE id=${a1}`;
  const afterDelete = await within(a.space, () => selectedChanges({ cursor: own.cursor, limit: 10 }));
  assert.deepEqual(afterDelete.changes.map(change => ({ id: idOf(change), op: change.op })), [{ id: a1, op: 'remove' }]);
  const other = await within(b.space, () => selectedChanges({ cursor: foreign.cursor, limit: 10 }));
  assert.deepEqual(other.changes, []);
  assert.deepEqual((await within(b.space, () => selectedSnapshot({ limit: 10, page: null }))).items.map(item => item.id), [b1]);
});

test('an incorrectly imported default ledger row cannot disclose a live foreign article id or payload', async () => {
  const foreign = await channel('外部频道');
  const item = await publish(foreign.context, '不可从默认出口读取');
  const before = await selectedSnapshot({ limit: 100, page: null });
  await sql`INSERT INTO selected_ledger(seq,space_id,article_id,op,payload,visible_at)
    SELECT (SELECT max(seq)+1 FROM selected_ledger),'default',article_id,'upsert',payload,visible_at
    FROM selected_ledger WHERE article_id=${item} ORDER BY seq DESC LIMIT 1`;
  const changes = await selectedChanges({ cursor: before.cursor, limit: 100 });
  assert.ok(!JSON.stringify(changes).includes(item));
  assert.ok(!JSON.stringify(changes).includes('不可从默认出口读取'));
  assert.ok(!(await selectedSnapshot({ limit: 100, page: null })).items.some(row => row.id === item));
});

test('legacy sync and page tokens without a space field remain restricted to default', async () => {
  const own = await resolveSpaceContext('default');
  await publish(own, '默认一');
  await publish(own, '默认二');
  const current = await selectedSnapshot({ limit: 1, page: null });
  assert.ok(current.nextPage);
  const oldPage = legacy(current.nextPage!);
  const oldSync = legacy(current.cursor);
  assert.ok((await selectedSnapshot({ limit: 10, page: oldPage })).items.length >= 1);
  assert.deepEqual((await selectedChanges({ cursor: oldSync, limit: 10 })).changes, []);
  const other = await channel('无权复用旧token');
  await assert.rejects(within(other.space, () => selectedSnapshot({ limit: 10, page: oldPage })), SnapshotRequiredError);
  await assert.rejects(within(other.space, () => selectedChanges({ cursor: oldSync, limit: 10 })), SnapshotRequiredError);
});
