import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MCP_TOOL_NAMES } from '@aihot/contracts/mcp';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { defaultSpaceConfig, resolveSpaceContext, storeSpaceConfig, type SpaceContext } from '@aihot/backend/spaces/context';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';
import { buildApp } from '../apps/api/src/app.ts';

const app = await buildApp();
const key = tag();
const channels: { slug: string; context: SpaceContext; ids: string[] }[] = [];
let defaultId: string;
let address: string;

async function article(context: SpaceContext, label: string, category: string) {
  const source = `public-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier, space_id, site_fulltext, syndicate_fulltext)
    VALUES (${source}, ${label}, 'rss', 'T1', ${context.spaceId}, true, true)`;
  const at = new Date(Date.now() - 60_000);
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.invalid/${source}`,
    title: label, bodyText: `${label} 已确认的来源正文。`.repeat(30), bodyStatus: 'ok', publishedAt: at, discoveredAt: at, via: 'fetch' }, sql, context);
  await sql`INSERT INTO analyses (article_id, space_id, config_version, input_revision, origin, relevance, title_zh, summary_zh, category, selected, score)
    VALUES (${articleId}, ${context.spaceId}, ${context.configVersion}, 1, 'rule', 'pass', ${label}, ${`${label} 摘要`}, ${category}, true, 95)`;
  await publishArticle(articleId, { releasedAt: at });
  return articleId;
}

before(async () => {
  defaultId = await article(await resolveSpaceContext('default'), `default-${key}`, 'ai-models');
  for (const name of ['alpha', 'beta']) {
    const slug = `${name}-${key}`;
    const value = structuredClone(defaultSpaceConfig());
    value.siteName = `${name} test channel`;
    value.categories = [{ key: 'security', label: '安全公告', section: '公告', tagColor: 'teal', guide: 'Test fixtures only' }];
    await sql`INSERT INTO spaces (id, slug, enabled) VALUES (${slug}, ${slug}, true)`;
    const context = await storeSpaceConfig(slug, value);
    await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = ${slug}`;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await article(context, `${name}-${key}-${i}`, 'security'));
    channels.push({ slug, context, ids });
  }
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => { app.server.closeAllConnections(); await app.close(); await stopBoss(); await closeDb(); });

const own = (text: string, index: number) => {
  assert.ok(channels[index]!.ids.some(id => text.includes(id)), text.slice(0, 300));
  assert.ok(!text.includes(defaultId), 'channel response includes the legacy default');
  assert.ok(!channels[1 - index]!.ids.some(id => text.includes(id)), 'channel response includes another channel');
};

test('concurrent site, API, Agent, RSS and discovery reads remain in their URL channel', async () => {
  const read = async (index: number, path: string) => {
    const res = await app.inject(path);
    assert.equal(res.statusCode, 200, `${path}: ${res.body.slice(0, 300)}`);
    own(res.body, index);
  };
  await Promise.all(channels.flatMap(({ slug }, i) => [
    `/api/site/spaces/${slug}/timeline`, `/api/site/spaces/${slug}/pool?q=${key}`,
    `/api/v1/spaces/${slug}/items`, `/api/v1/spaces/${slug}/agent/latest`,
    `/api/v1/spaces/${slug}/agent/search?q=${key}`, `/channels/${slug}/feed.xml`,
    `/channels/${slug}/feed/all.xml`, `/channels/${slug}/feed/full.xml`, `/channels/${slug}/sitemap.xml`,
  ].map(path => read(i, path))));
  for (const path of ['/api/site/timeline', '/api/v1/items', '/feed.xml']) {
    const res = await app.inject(`${path}?space=${channels[0]!.slug}`);
    if (path.startsWith('/api/v1')) { assert.equal(res.statusCode, 400); continue; }
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes(defaultId));
    assert.ok(!channels.some(c => c.ids.some(id => res.body.includes(id))));
  }
});

test('detail, availability, Markdown and image endpoints cannot identify foreign articles', async () => {
  for (const [i, { slug, ids }] of channels.entries()) {
    for (const id of [defaultId, ...channels[1 - i]!.ids]) {
      for (const path of [`/api/site/spaces/${slug}/items/${id}`, `/api/site/spaces/${slug}/items/${id}/original`, `/channels/${slug}/items/${id}/markdown`, `/channels/${slug}/og/items/${id}.png`, `/channels/${slug}/og/posters/${id}.png`]) {
        assert.equal((await app.inject(path)).statusCode, 404, path);
      }
    }
    const availability = (await app.inject(`/api/site/spaces/${slug}/items/availability?ids=${ids[0]},${defaultId}`)).json();
    assert.equal(availability[defaultId]?.status, 'unavailable');
    assert.notEqual(availability[ids[0]!]?.status, 'unavailable');
    for (const path of [`/api/site/spaces/${slug}/items/${ids[0]}`, `/channels/${slug}/items/${ids[0]}/markdown`]) assert.equal((await app.inject(path)).statusCode, 200, path);
    assert.equal((await app.inject(`/api/site/items/${ids[0]}`)).statusCode, 404);
  }
});

test('category schemas, links, metadata and ETags describe the selected channel', async () => {
  for (const { slug, ids } of channels) {
    const meta = (await app.inject(`/api/site/spaces/${slug}/meta`)).json();
    assert.equal(meta.space.slug, slug);
    assert.deepEqual(meta.categories.map((c: { key: string }) => c.key), ['security']);
    assert.deepEqual(Object.keys(meta.space).sort(), ['configVersion', 'id', 'name', 'slug']);
    assert.ok(!JSON.stringify(meta).includes('apiKeyEnv'));
    const api = await app.inject(`/api/v1/spaces/${slug}/items?category=security`);
    assert.equal(api.statusCode, 200);
    assert.ok(api.json().items.every((item: { links: { aihot: string } }) => item.links.aihot.includes(`/channels/${slug}/items/`)));
    assert.equal((await app.inject(`/api/v1/spaces/${slug}/items?category=ai-models`)).statusCode, 400);
    const spec = await app.inject(`/channels/${slug}/openapi-v1.json`);
    assert.equal(spec.statusCode, 200);
    assert.ok(spec.json().paths[`/api/v1/spaces/${slug}/items`]);
    assert.ok(!spec.json().paths['/api/v1/items']);
    assert.ok(spec.body.includes(`/channels/${slug}/openapi-v1.json`));
    const doc = await app.inject(`/channels/${slug}/llms.txt`);
    assert.equal(doc.statusCode, 200);
    assert.ok(doc.body.includes(`/api/mcp/spaces/${slug}`));
    assert.ok(doc.body.includes(`/api/v1/spaces/${slug}/agent`));
    assert.ok(ids.length);
  }
  const paths = channels.map(c => `/api/site/spaces/${c.slug}/hot`);
  const first = await app.inject(paths[0]!);
  const same = await app.inject({ url: paths[0]!, headers: { 'if-none-match': String(first.headers.etag) } });
  assert.equal(same.statusCode, 304);
  const other = await app.inject({ url: paths[1]!, headers: { 'if-none-match': String(first.headers.etag) } });
  assert.equal(other.statusCode, 200, 'even identical empty payloads have channel-specific validators');
  assert.notEqual(other.headers.etag, first.headers.etag);
});

test('pagination and selected synchronization cursors cannot cross channel boundaries', async () => {
  const [a, b] = channels;
  const response = (await app.inject(`/api/v1/spaces/${a!.slug}/items?limit=1`)).json();
  assert.ok(response.page.nextCursor);
  assert.equal((await app.inject(`/api/v1/spaces/${a!.slug}/items?limit=1&cursor=${response.page.nextCursor}`)).statusCode, 200);
  assert.equal((await app.inject(`/api/v1/spaces/${b!.slug}/items?limit=1&cursor=${response.page.nextCursor}`)).statusCode, 400);
  const snapshot = (await app.inject(`/api/v1/spaces/${a!.slug}/selected/snapshot?limit=1`)).json();
  own(JSON.stringify(snapshot), 0);
  const changes = await app.inject(`/api/v1/spaces/${b!.slug}/selected/changes?cursor=${snapshot.cursor}`);
  assert.equal(changes.statusCode, 409);
  if (snapshot.nextPage) assert.equal((await app.inject(`/api/v1/spaces/${b!.slug}/selected/snapshot?limit=1&page=${snapshot.nextPage}`)).statusCode, 409);
});

test('unknown and disabled channels fail before methods, body parsing or conditional cache responses', async () => {
  const slug = `disabled-${key}`;
  await sql`INSERT INTO spaces (id, slug, enabled) VALUES (${slug}, ${slug}, false)`;
  for (const name of [slug, `missing-${key}`]) {
    for (const path of [`/api/site/spaces/${name}/meta`, `/api/v1/spaces/${name}/items`, `/api/v1/spaces/${name}/unknown`, `/channels/${name}/feed.xml`, `/channels/${name}/llms.txt`, `/channels/${name}/openapi-v1.json`, `/api/mcp/spaces/${name}`]) {
      const res = await app.inject({ url: path, headers: { 'if-none-match': '*' } });
      assert.equal(res.statusCode, 404, path);
      assert.match(String(res.headers['cache-control']), /no-store/);
    }
    for (const path of [`/channels/${name}/feed.xml`, `/api/v1/spaces/${name}/items`, `/api/mcp/spaces/${name}`]) assert.equal((await app.inject({ method: 'OPTIONS', url: path })).statusCode, 404, path);
    const res = await app.inject({ method: 'POST', url: `/api/v1/spaces/${name}/items`, headers: { 'content-type': 'application/json' }, payload: 'broken{' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['access-control-allow-origin'], '*');
  }
  const { slug: active } = channels[0]!;
  assert.equal((await app.inject({ method: 'OPTIONS', url: `/api/v1/spaces/${active}/items` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/spaces/${active}/items`, headers: { 'content-type': 'application/json' }, payload: 'broken{' })).statusCode, 405);
  const list = (await app.inject('/api/site/spaces')).json().spaces;
  assert.ok(!list.some((s: { slug: string }) => s.slug === slug));
  for (const path of ['/api/v1/spaces/%E0%A4%A/items', '/channels/%E0%A4%A/openapi-v1.json']) {
    const malformed = await app.inject(path);
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.headers['access-control-allow-origin'], '*');
    assert.equal(malformed.headers['cache-control'], 'no-store');
    assert.equal(malformed.headers['content-type'], 'application/problem+json');
    assert.equal(malformed.json().code, 'invalid_request');
  }
});

test('MCP endpoint selection isolates tool schemas, cached answers and later channel disabling', async () => {
  const clients = channels.map(() => new Client({ name: 'channel-check', version: '1.0.0' }));
  try {
    await Promise.all(clients.map((client, i) => client.connect(new StreamableHTTPClientTransport(new URL(`${address}/api/mcp/spaces/${channels[i]!.slug}`)))));
    for (const [i, client] of clients.entries()) {
      const schema = (await client.listTools()).tools.find(t => t.name === MCP_TOOL_NAMES.latest)!.inputSchema.properties!.category as { enum: string[] };
      assert.deepEqual(schema.enum, ['security']);
      const result = await client.callTool({ name: MCP_TOOL_NAMES.latest, arguments: { category: 'security' } });
      assert.notEqual(result.isError, true);
      own(JSON.stringify(result.structuredContent), i);
    }
    // Warm both response caches, then alternate the same query to catch accidental shared keys.
    const responses = await Promise.all([0, 1, 0, 1].map(i => clients[i]!.callTool({ name: MCP_TOOL_NAMES.latest, arguments: { category: 'security' } })));
    responses.forEach((res, index) => own(JSON.stringify(res.structuredContent), index % 2));
    const { slug } = channels[1]!;
    const cached = await app.inject(`/channels/${slug}/feed.xml`);
    await sql`UPDATE spaces SET enabled = false WHERE id = ${slug}`;
    assert.equal((await app.inject({ url: `/channels/${slug}/feed.xml`, headers: { 'if-none-match': String(cached.headers.etag) } })).statusCode, 404);
    await assert.rejects(clients[1]!.callTool({ name: MCP_TOOL_NAMES.latest, arguments: {} }));
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await sql`UPDATE spaces SET enabled = true WHERE id = ${channels[1]!.slug}`;
  }
});


test('legacy endpoints read the active default configuration without switching their URL scope', async () => {
  const original = await resolveSpaceContext('default');
  const changed = structuredClone(defaultSpaceConfig());
  changed.categories = [{ key: 'default-category', label: '默认分类', section: '默认栏目', tagColor: 'teal', guide: 'Fixture' }];
  const context = await storeSpaceConfig('default', changed);
  await sql`UPDATE spaces SET active_config_version = ${context.configVersion} WHERE id = 'default'`;
  try {
    const customId = await article(context, `default-custom-${key}`, 'default-category');
    const meta = (await app.inject('/api/site/meta')).json();
    assert.equal(meta.space, null);
    assert.deepEqual(meta.categories.map((c: { key: string }) => c.key), ['default-category']);
    const items = await app.inject('/api/v1/items?category=default-category');
    assert.equal(items.statusCode, 200);
    assert.ok(!items.body.includes('/channels/'));
    const customItem = items.json().items.find((item: { id: string }) => item.id === customId);
    assert.ok(customItem, 'the active default category returns its published item');
    assert.equal(customItem.category, 'default-category');
    assert.ok(customItem.links.aihot.endsWith(`/items/${customId}`));
    const snapshot = await app.inject('/api/v1/selected/snapshot');
    assert.equal(snapshot.statusCode, 200);
    const customSnapshot = snapshot.json().items.find((item: { id: string }) => item.id === customId);
    assert.ok(customSnapshot, 'selected synchronization retains the custom default-category item');
    assert.equal(customSnapshot.category, 'default-category');
    assert.equal(customSnapshot.links.aihot, customItem.links.aihot);
    const schema = (await app.inject('/openapi-v1.json')).json();
    assert.ok(schema.paths['/api/v1/items']);
    const category = schema.paths['/api/v1/items'].get.parameters.find((p: { name: string }) => p.name === 'category');
    assert.deepEqual(category.schema.examples, ['default-category']);
    await sql`UPDATE spaces SET enabled = false WHERE id = 'default'`;
    assert.equal((await app.inject('/api/v1/items')).statusCode, 404);
    const list = (await app.inject('/api/site/spaces')).json().spaces;
    assert.ok(list.every((space: { id: string }) => space.id !== 'default'));
  } finally {
    await sql`UPDATE spaces SET enabled = true, active_config_version = ${original.configVersion} WHERE id = 'default'`;
  }
  assert.equal(Number((await sql`SELECT count(*) AS n FROM receipts`)[0]!.n), 0, 'public readers never call paid models');
});


test('channels do not inherit legacy reports through JSON, RSS, Agent Markdown or share cards', async () => {
  const reportKey = '2098-10-23';
  const reportTitle = `legacy-report-${key}`;
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, origin, generated_at)
    VALUES ('daily', ${reportKey}, now() - interval '1 day', now(),
      ${sql.json({ sections: [{ label: '公告', items: [{ itemId: defaultId, title: reportTitle, summary: 'Legacy only' }] }], flashes: [] })}, 'manual', now())`;
  for (const { slug } of channels) {
    for (const path of [`/api/site/spaces/${slug}/reports/daily`, `/api/v1/spaces/${slug}/dailies`, `/channels/${slug}/feed/daily.xml`]) {
      const res = await app.inject(path);
      assert.equal(res.statusCode, 200, path);
      assert.ok(!res.body.includes(defaultId));
      assert.ok(!res.body.includes(reportTitle));
    }
    for (const path of [`/api/site/spaces/${slug}/reports/daily/${reportKey}`, `/api/v1/spaces/${slug}/dailies/${reportKey}`, `/api/v1/spaces/${slug}/agent/daily/${reportKey}`, `/channels/${slug}/og/reports/daily/${reportKey}.png`]) assert.equal((await app.inject(path)).statusCode, 404, path);
  }
});
