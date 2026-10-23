import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { defaultSpaceConfig, storeSpaceConfig } from '@aihot/backend/spaces/context';
import { withPublicationSpace, type PublicSpace } from '@aihot/backend/publication/context';
import { loadPool } from '@aihot/backend/publication/pool';
import { loadTimeline } from '@aihot/backend/publication/timeline';
import { loadItemDetail, exportMarkdown } from '@aihot/backend/publication/detail';
import { loadItemOgCard } from '@aihot/backend/publication/og';
import { itemAvailability } from '@aihot/backend/publication/availability';
import { loadGroupReports } from '@aihot/backend/publication/groups';
import { loadStoryFollowups } from '@aihot/backend/publication/followups';
import { loadStoryDetail, loadHot, resolveStory, v1Story } from '@aihot/backend/publication/stories';
import { itemFeed, reportFeed } from '@aihot/backend/publication/feeds';
import { loadReport, listReports, v1Daily, v1Period } from '@aihot/backend/publication/reports';
import { loadLlmsAvailability, llmsTxt } from '@aihot/backend/publication/llms';
import { agentGuide } from '@aihot/backend/publication/agent';
import { listTopicSummaries, loadTopicPage, publicationTopics } from '@aihot/backend/publication/topics';
import { loadSitemap } from '@aihot/backend/publication/sitemap';
import { loadSiteStats } from '@aihot/backend/site/stats';
import { InvalidCursorError } from '@aihot/backend/lib/cursor';

const now = new Date();
const at = new Date(+now - 60_000);
const filters = { channel: 'all' as const, category: null, tag: null };
let a: Awaited<ReturnType<typeof fixture>>;
let b: Awaited<ReturnType<typeof fixture>>;
after(closeDb);

async function fixture(name: string) {
  const id = `dev04-${tag()}`;
  const slug = `${name.toLowerCase()}-${tag()}`;
  await sql`INSERT INTO spaces(id,slug,enabled) VALUES(${id},${slug},true)`;
  const config = structuredClone(defaultSpaceConfig());
  config.siteName = name;
  config.categories = [{ key: 'security', label: `${name}安全`, guide: '安全公告', section: '安全', tagColor: 'red' }];
  config.topicTags = [`${name}专题`];
  config.categoryTags = [`${name}分类`];
  config.entities = { vendor: { name: `${name}厂商`, displayTag: null, aliases: [`${name}厂商`] } };
  config.entityOrder = ['vendor'];
  const context = await storeSpaceConfig(id, config);
  await sql`UPDATE spaces SET active_config_version=${context.configVersion} WHERE id=${id}`;
  const space: PublicSpace = { id, slug, name, configVersion: context.configVersion };
  const source = `source-${tag()}`;
  const title = `${name}厂商安全公告`;
  await sql`INSERT INTO sources(id,space_id,name,kind,tier,site_fulltext,syndicate_fulltext) VALUES(${source},${id},${name},'rss','T1',true,true)`;
  const [story] = await sql<{ id:number; public_id:string }[]>`INSERT INTO stories(space_id,public_id,title,latest_at)
    VALUES(${id},${randomUUID()},${title},${at}) RETURNING id,public_id`;
  const [fact] = await sql<{ id:number; public_id:string }[]>`INSERT INTO facts(space_id,public_id,story_id,title)
    VALUES(${id},${randomUUID()},${story!.id},${title}) RETURNING id,public_id`;
  const items: string[] = [];
  for (let n = 0; n < 2; n++) {
    const item = `item-${tag()}`;
    items.push(item);
    await sql`INSERT INTO articles(id,space_id,source_id,identity_key,url,title,body_text,body_html,body_status,published_at,discovered_at,timeline_at)
      VALUES(${item},${id},${source},${item},${`https://example.invalid/${item}`},${title},${`${name}原文`},${`<p>${name}原文</p>`},'ok',${at},${at},${at})`;
    await sql`INSERT INTO publications(article_id,space_id,source_id,title,summary,url,channel,timeline_at,discovered_at,published_at,sort_at,
      selected,seat,eligible,visible_after,tags,body_mode,score,category,indexable,syndicate,search_text,story_id,fact_id)
      VALUES(${item},${id},${source},${title},${`${name}独立摘要`},${`https://example.invalid/${item}`},'news',${at},${at},${at},${at},
      true,true,true,${at},${[`entity:vendor`, `${name}专题`]},'full',90,'security',true,true,${title.toLowerCase()},${n === 0 ? story!.id : null},${n === 0 ? fact!.id : null})`;
    if (n === 0) await sql`INSERT INTO fact_articles(space_id,fact_id,article_id,role) VALUES(${id},${fact!.id},${item},'report')`;
  }
  const hot = { rank: 1, storyId: story!.id, storyPublicId: story!.public_id, title, heat: 5, trend: 'flat', trendPct: 0, badges: [],
    participantCount: 1, sourceCount: 1, signalCount: 0, reportCount: 1, sourceNames: [name], latestAt: at.toISOString(), firstReportAt: at.toISOString(),
    representativeItemId: items[0], representativeUrl: `https://example.invalid/${items[0]}`, representativeSource: name, participants: [{ name, kind: 'editorial', tier: 'T1' }] };
  await sql`INSERT INTO hot_rankings(space_id,computed_at,rule_version,entries,published) VALUES(${id},${at},'test',${sql.json([hot])},true)`;
  return { space, story: story!, fact: fact!, items, source, hot };
}

before(async () => {
  a = await fixture('Alpha'); b = await fixture('Beta');
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at)
    VALUES('daily','2099-01-01',${at},${now},${sql.json({ lead: { title: 'Default report secret' }, sections: [] })},${now})`;
});

const inSpace = <T>(space: PublicSpace, read: () => T | Promise<T>) => withPublicationSpace(space, read);

test('concurrent public reads and cached totals remain in their requested channel; timeline cursors cannot cross channels', async () => {
  const [left, right] = await Promise.all([a,b].map(f => inSpace(f.space, async () => ({
    pool: await loadPool(filters), timeline: await loadTimeline({ ...filters, limit: 1 }), stats: await loadSiteStats(),
  }))));
  assert.deepEqual(new Set(left!.pool.items.map(i=>i.id)),new Set(a.items));
  assert.deepEqual(new Set(right!.pool.items.map(i=>i.id)),new Set(b.items));
  assert.equal(left!.pool.total,2); assert.equal(right!.pool.total,2);
  assert.equal(left!.stats.sources,1); assert.equal(right!.stats.sources,1);
  assert.ok(left!.stats.latest.every(i=>a.items.includes(i.id)));
  assert.ok(left!.timeline.nextCursor);
  await assert.rejects(inSpace(b.space,()=>loadTimeline({...filters,cursor:left!.timeline.nextCursor})),InvalidCursorError);
  const next=await inSpace(a.space,()=>loadTimeline({...filters,cursor:left!.timeline.nextCursor}));
  assert.equal(next.cards.length,1); assert.ok(a.items.includes(next.cards[0]!.item.id));
  const legacy=await loadPool(filters); assert.ok(legacy.items.every(i=>!a.items.includes(i.id)&&!b.items.includes(i.id)));
});

test('item, Markdown, share card, availability, story, groups and followups reject foreign identifiers', async () => {
  await inSpace(a.space,async()=>{
    assert.equal((await loadItemDetail(a.items[0]!)).kind,'found');
    assert.equal((await loadItemDetail(b.items[0]!)).kind,'not_found');
    assert.match((await exportMarkdown(a.items[0]!))!.body,new RegExp(`/channels/${a.space.slug}/items/`));
    assert.equal(await exportMarkdown(b.items[0]!),null);
    assert.equal((await loadItemOgCard(a.items[0]!))!.kicker,'Alpha安全');
    assert.equal(await loadItemOgCard(b.items[0]!),null);
    assert.equal((await itemAvailability([a.items[0]!,b.items[0]!]))[b.items[0]!]!.status,'unavailable');
    assert.equal((await resolveStory(b.story.public_id)).kind,'not_found');
    assert.equal(await loadStoryDetail(b.story.id),null); assert.equal(await v1Story(b.story.id),null);
    assert.equal((await loadStoryDetail(a.story.id))!.publicId,a.story.public_id);
    assert.equal(await loadGroupReports({...filters,factPublicId:b.fact.public_id}),null);
    assert.equal((await loadGroupReports({...filters,factPublicId:a.fact.public_id}))!.reports[0]!.id,a.items[0]);
    assert.equal(await loadStoryFollowups(b.story.public_id),null);
    assert.equal((await loadStoryFollowups(a.story.public_id))!.items[0]!.representative.id,a.items[0]);
  });
});

test('RSS, discovery, topic directory and channel sitemap expose only current channel vocabulary and links', async()=>{
  const [left,right]=await Promise.all([a,b].map(f=>inSpace(f.space,async()=>{
    const feeds=await Promise.all((['all','selected','selected-full'] as const).map(kind=>itemFeed(kind,null)));
    const topics=await listTopicSummaries();
    const own=publicationTopics().find(t=>t.name===`${f.space.name}专题`)!;
    const page=await loadTopicPage(own.slug,1);
    const llms=llmsTxt(await loadLlmsAvailability());
    return {feeds,topics,page,llms,guide:agentGuide(),sitemap:(await loadSitemap()).xml};
  })));
  for(const [f,other,out] of [[a,b,left],[b,a,right]] as const){
    for(const feed of out.feeds){assert.ok(feed.includes(f.items[0]!));assert.ok(!feed.includes(other.items[0]!));assert.ok(feed.includes(`/channels/${f.space.slug}/items/`));}
    assert.ok(out.topics.topics.some(t=>t.name===`${f.space.name}专题`));
    assert.ok(!out.topics.topics.some(t=>t.name===`${other.space.name}专题`));
    assert.ok(out.page!.items.every(i=>f.items.includes(i.id)));
    assert.ok(out.llms.includes(`/api/v1/spaces/${f.space.slug}/items`));
    assert.ok(out.guide.includes(`/api/v1/spaces/${f.space.slug}/agent/latest`));
    assert.ok(out.sitemap.includes(`/channels/${f.space.slug}/items/${f.items[0]}`));
    assert.ok(!out.sitemap.includes(other.items[0]!));assert.ok(!out.sitemap.includes('2099-01-01'));
  }
});

test('channels without report schema return empty archives and missing reports, never default reports',async()=>{
  await inSpace(a.space,async()=>{
    assert.deepEqual(await listReports('daily'),[]);assert.equal(await loadReport('daily','2099-01-01'),null);
    assert.equal(await v1Daily('latest'),null);assert.equal(await v1Period('weekly','latest'),null);
    assert.ok(!(await reportFeed('daily')).includes('Default report secret'));
    const availability=await loadLlmsAvailability();assert.equal(availability.hasDailies,false);
  });
});

test('saved hot JSON cannot import a foreign representative, story public id or source name',async()=>{
  await sql`UPDATE hot_rankings SET entries=${sql.json([
    {...a.hot, storyPublicId:b.story.public_id, sourceNames:['Alpha','Beta'],participants:[{name:'Alpha',kind:'editorial'},{name:'Beta',kind:'editorial'}]},
    {...b.hot,rank:2},
  ])} WHERE space_id=${a.space.id}`;
  const hot=await inSpace(a.space,()=>loadHot());
  assert.equal(hot.entries.length,1);assert.equal(hot.entries[0]!.story.publicId,a.story.public_id);
  assert.deepEqual(hot.entries[0]!.sourceNames,['Alpha']);
  assert.ok(hot.entries[0]!.participants.every(p=>p.name==='Alpha'));
});

test('explicit default channel reads its versioned vocabulary and leaves legacy topics available outside the request', async()=>{
  const config=structuredClone(defaultSpaceConfig());
  config.categories=[{key:'advisory',label:'安全公告',guide:'公告',section:'安全',tagColor:'red'}];
  config.topicTags=['漏洞披露'];
  const context=await storeSpaceConfig('default',config);
  await inSpace({id:'default',slug:'default',name:'Default',configVersion:context.configVersion},async()=>{
    const topics=await listTopicSummaries();
    assert.ok(topics.topics.some(topic=>topic.name==='漏洞披露'));
    assert.ok(topics.topics.some(topic=>topic.name==='安全公告'));
    assert.ok(agentGuide().includes('advisory（安全公告）'));
  });
  assert.ok(publicationTopics().some(topic=>topic.name.includes('OpenAI')));
});

test('a saved digest with foreign article evidence cannot expose its frozen text',async()=>{
  await sql`UPDATE stories SET digest='Foreign frozen digest',digest_updated_at=now() WHERE id=${a.story.id}`;
  await sql`INSERT INTO story_digests(space_id,story_id,version,digest,article_ids,inputs_hash)
    VALUES(${a.space.id},${a.story.id},1,'Foreign frozen digest',${[b.items[0]!] },'foreign-input')`;
  const detail=await inSpace(a.space,()=>loadStoryDetail(a.story.id));
  assert.equal(detail!.digest,null);
  assert.ok(!JSON.stringify(detail).includes('Foreign frozen digest'));
});

test('nondefault X exports do not borrow globally stored quote translations',async()=>{
  const tweet='1234567890987654321';
  await sql`INSERT INTO quote_translations(tweet_id,text_hash,text_zh) VALUES(${tweet},'test','默认频道的独占译文')`;
  await sql`UPDATE articles SET x_post=${sql.json({text:'Original post text',quoted:{text:'Original quotation',url:`https://x.com/vendor/status/${tweet}`,handle:'vendor'}})}
    WHERE id=${a.items[1]!}`;
  await sql`UPDATE publications SET channel='x' WHERE article_id=${a.items[1]!}`;
  await inSpace(a.space,async()=>{
    const detail=await loadItemDetail(a.items[1]!);
    assert.equal(detail.kind,'found');
    if(detail.kind==='found')assert.equal(detail.item.x?.quoted?.translation,null);
    assert.ok(!(await exportMarkdown(a.items[1]!))!.body.includes('默认频道的独占译文'));
    assert.ok(!(await itemFeed('selected-full',null)).includes('默认频道的独占译文'));
  });
});
