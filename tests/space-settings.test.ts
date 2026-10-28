// Operator writes must preserve channel routing, activation boundaries, reserved capacity and audit atomicity.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeDb, sql } from '@aihot/backend/db';
import { configureContentTarget, listTargets, setTargetEnabled, updateBudget } from '@aihot/backend/admin/settings';
import { defaultSpaceConfig, storeSpaceConfig } from '@aihot/backend/spaces/context';
import { getSpaceBudgets, setSpaceBudget } from '@aihot/backend/spaces/quotas';
import { ensureContentTargets } from '@aihot/backend/notify/deliver';
import Fastify from 'fastify';
import { config } from '@aihot/backend/config';
import { passwordLogin, SESSION_COOKIE, sessionPrincipal } from '@aihot/backend/admin/auth';
import { registerAdmin } from '../apps/api/src/routes/admin.ts';
import { upsertMaterial } from '@aihot/backend/content/materials';

const actor = `settings-${tag()}`;
const app = Fastify({ logger: false });
registerAdmin(app);
const originalAdmin = { password: config.adminPassword, dev: config.devAdmin };
const webhookEnv = ['FEISHU_PUSH_WEBHOOK_URL', 'FEISHU_SECURITY_WEBHOOK_URL', 'LLM_API_KEY'];
const originalEnv = new Map(webhookEnv.map(key => [key, process.env[key]]));
config.adminPassword = `settings-password-${tag()}`;
config.devAdmin = null;
after(async () => {
  await app.close(); config.adminPassword = originalAdmin.password; config.devAdmin = originalAdmin.dev;
  for (const [key, value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await closeDb();
});
async function adminHeaders() {
  const { token } = await passwordLogin(config.adminPassword!, '/admin', 'synthetic-settings-test');
  const cookie = `${SESSION_COOKIE}=${token}`;
  return { cookie, 'x-csrf-token': (await sessionPrincipal(cookie))!.csrf };
}
async function channel(name?: string, id = `settings-${tag()}`) {
  await sql`INSERT INTO spaces(id,slug,enabled) VALUES(${id},${id},true)`;
  const value = structuredClone(defaultSpaceConfig());
  if (name) value.siteName = name;
  const context = await storeSpaceConfig(id, value);
  await sql`UPDATE spaces SET active_config_version=${context.configVersion} WHERE id=${id}`;
  return context;
}
const targetInput = (name = `group-${tag()}`) => ({ name, kind: 'feishu_webhook' as const, configRef: 'TEST_SPACE_WEBHOOK', subjectKinds: ['selected'] as Array<'selected'|'report'>, enabled: false, reason: 'configure channel group' });
const targetState = async (key: string) => (await sql`SELECT space_id,kind,enabled,enabled_at::text AS enabled_at,config_ref,subject_kinds,updated_at::text AS updated_at FROM notify_targets WHERE key=${key}`)[0]!;
const platformInput = (limit: number) => ({ perMinute: limit, perHour: limit, perDay: limit, reason: 'platform capacity' });

test('admin channel discovery includes disabled channels and counts only their enabled failing sources', async () => {
  const [a, b] = await Promise.all([channel('AI fixture'), channel('Security fixture')]);
  await sql`UPDATE spaces SET enabled = false WHERE id = ${b.spaceId}`;
  await sql`INSERT INTO sources (id, name, kind, space_id, enabled, health) VALUES
    (${`count-a-${tag()}`}, 'A failing', 'rss', ${a.spaceId}, true, 'failing'),
    (${`count-b-${tag()}`}, 'B failing', 'rss', ${b.spaceId}, true, 'failing'),
    (${`count-off-${tag()}`}, 'A disabled', 'rss', ${a.spaceId}, false, 'failing')`;
  assert.equal((await app.inject('/api/admin/spaces')).statusCode, 401);
  const response = await app.inject({ url: '/api/admin/spaces', headers: await adminHeaders() });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const spaces = response.json().spaces;
  assert.deepEqual(spaces.find((s: { id: string }) => s.id === a.spaceId), { id: a.spaceId, slug: a.spaceId, name: 'AI fixture', enabled: true, failedSources: 1 });
  assert.deepEqual(spaces.find((s: { id: string }) => s.id === b.spaceId), { id: b.spaceId, slug: b.spaceId, name: 'Security fixture', enabled: false, failedSources: 1 });
});

test('scoped settings expose only registered channel groups, scoped budgets and explicit environment gates', async () => {
  const security = await channel('Security settings fixture', 'security');
  process.env.FEISHU_PUSH_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/fictional-ai';
  process.env.FEISHU_SECURITY_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/fictional-security';
  process.env.LLM_API_KEY = 'not-a-group-secret';
  const knownName = `registered-${tag()}`;
  const known = await configureContentTarget('default', { ...targetInput(knownName), configRef: 'FEISHU_PUSH_WEBHOOK_URL' }, actor);
  const unregistered = await configureContentTarget('default', { ...targetInput(), configRef: 'LLM_API_KEY' }, actor);
  const foreign = await configureContentTarget(security.spaceId, { ...targetInput(), configRef: 'FEISHU_SECURITY_WEBHOOK_URL' }, actor);
  const service = `scope-${tag()}`;
  await updateBudget(service, platformInput(100), actor);
  await setSpaceBudget('default', service, { ...platformInput(10), reservedDay: 3 }, actor);
  await setSpaceBudget(security.spaceId, service, platformInput(20), actor);
  const headers = await adminHeaders();
  const response = await app.inject({ url: '/api/admin/spaces/default/settings', headers });
  assert.equal(response.statusCode, 200);
  const settings = response.json();
  assert.deepEqual(settings.pushGroups, [{ id: 'main', label: '现有飞书群', configured: true }]);
  assert.deepEqual(settings.gates, { collectEnabled: process.env.COLLECT_ENABLED === 'true', modelCallsEnabled: config.modelCallsEnabled, contentPushEnabled: false });
  assert.equal(settings.space.id, 'default');
  assert.ok(settings.space.active_config_version);
  assert.ok(settings.targets.every((t: { space_id: string }) => t.space_id === 'default'));
  assert.equal(settings.targets.find((t: { key: string }) => t.key === known.key).targetName, knownName);
  assert.equal(settings.targets.find((t: { key: string }) => t.key === known.key).groupId, 'main');
  assert.equal(settings.targets.find((t: { key: string }) => t.key === unregistered.key).groupId, null);
  assert.ok(!response.body.includes(String(foreign.key)));
  assert.ok(!response.body.includes('fictional-ai') && !response.body.includes('fictional-security') && !response.body.includes('not-a-group-secret'));
  assert.equal(settings.budgets.find((b: { service: string }) => b.service === service).per_day, 10);
  assert.equal(settings.budgets.find((b: { service: string }) => b.service === service).reserved_day, 3);
  assert.equal(settings.platformBudgets.find((b: { service: string }) => b.service === service).per_day, 100);
  const securitySettings = await app.inject({ url: '/api/admin/spaces/security/settings', headers });
  assert.equal(securitySettings.statusCode, 200);
  assert.equal(securitySettings.json().budgets.find((b: { service: string }) => b.service === service).per_day, 20);
  assert.ok(securitySettings.json().targets.every((t: { space_id: string }) => t.space_id === 'security'));
  assert.equal((await app.inject({ url: '/api/admin/spaces/missing-channel/settings', headers })).statusCode, 404);
});

test('web subscriptions accept only channel group IDs, require CSRF and never deliver on save', async () => {
  process.env.FEISHU_PUSH_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/fictional-subscription';
  const headers = await adminHeaders();
  const url = '/api/admin/spaces/default/content-subscription';
  const payload = { targetName: `web-${tag()}`, groupId: 'main', enabled: true, subjectKinds: ['selected'], reason: 'configure an existing group' };
  const [{ deliveries }] = await sql<{ deliveries: number }[]>`SELECT count(*)::int AS deliveries FROM deliveries`;
  assert.equal((await app.inject({ method: 'PUT', url, headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  const saved = await app.inject({ method: 'PUT', url, headers, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().groupId, 'main');
  assert.equal(saved.json().targetName, payload.targetName);
  assert.equal(saved.json().space_id, 'default');
  assert.equal(saved.json().enabled, true);
  const before = await targetState(payload.targetName);
  for (const bad of [
    { ...payload, configRef: 'LLM_API_KEY' }, { ...payload, webhook: 'https://example.invalid/secret' },
    { ...payload, groupId: 'not-registered' }, { ...payload, targetName: 'space:security:foreign' },
    { ...payload, enabled: 'true' }, { ...payload, subjectKinds: ['everything'] },
  ]) assert.equal((await app.inject({ method: 'PUT', url, headers, payload: bad })).statusCode, 400);
  assert.deepEqual(await targetState(payload.targetName), before);
  const unbound = await channel('Unregistered group fixture', 'constructor');
  const unboundSettings = await app.inject({ url: `/api/admin/spaces/${unbound.spaceId}/settings`, headers });
  assert.equal(unboundSettings.statusCode, 200);
  assert.deepEqual(unboundSettings.json().pushGroups, []);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/admin/spaces/${unbound.spaceId}/content-subscription`, headers, payload })).statusCode, 400);
  assert.equal((await listTargets(unbound.spaceId)).length, 0);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/spaces/missing-channel/content-subscription', headers, payload })).statusCode, 404);
  delete process.env.FEISHU_PUSH_WEBHOOK_URL;
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { ...payload, targetName: `missing-${tag()}` } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { ...payload, enabled: false } })).statusCode, 200);
  const legacyName = `unregistered-${tag()}`;
  await configureContentTarget('default', { ...targetInput(legacyName), configRef: 'OPERATOR_ONLY_WEBHOOK', enabled: true, subjectKinds: ['selected', 'report'] }, actor);
  const paused = await app.inject({ method: 'PUT', url, headers, payload: { ...payload, targetName: legacyName, groupId: null, enabled: false } });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().config_ref, 'OPERATOR_ONLY_WEBHOOK');
  assert.deepEqual(paused.json().subject_kinds, ['report', 'selected']);
  assert.equal(paused.json().enabled, false);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { ...payload, targetName: legacyName, groupId: null } })).statusCode, 400);
  assert.equal((await sql<{ deliveries: number }[]>`SELECT count(*)::int AS deliveries FROM deliveries`)[0]!.deliveries, deliveries);
  const audits = await sql`SELECT action, after FROM audit_log WHERE subject = ${`space:default:notify-target:${payload.targetName}`}`;
  assert.equal(audits.length, 2);
  assert.ok(audits.every(row => row.action === 'notify.configure'));
  assert.ok(!JSON.stringify(audits).includes('fictional-subscription'));
  const emptyName = `unconfigured-${tag()}`;
  await configureContentTarget('default', { ...targetInput(emptyName), configRef: null }, actor);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { ...payload, targetName: emptyName, enabled: false } })).statusCode, 200);
});

test('web subscription names cannot replace an operations target', async () => {
  const name = `operations-${tag()}`;
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, note) VALUES (${name}, 'alert', 'log', true, 'operator-managed')`;
  const before = await targetState(name);
  const response = await app.inject({ method: 'PUT', url: '/api/admin/spaces/default/content-subscription', headers: await adminHeaders(),
    payload: { targetName: name, groupId: 'main', enabled: false, subjectKinds: ['selected'], reason: 'attempt to repurpose target' } });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(await targetState(name), before);
});

test('unregistered webhook routes stay operator-managed until their reference is registered', async () => {
  const name = `operator-route-${tag()}`;
  await configureContentTarget('default', { ...targetInput(name), configRef: 'OPERATOR_ROUTE_WEBHOOK', enabled: true }, actor);
  const before = await targetState(name);
  const response = await app.inject({ method: 'PUT', url: '/api/admin/spaces/default/content-subscription', headers: await adminHeaders(),
    payload: { targetName: name, groupId: 'main', enabled: false, subjectKinds: ['report'], reason: 'attempt to replace operator routing' } });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(await targetState(name), before);
});

test('scoped quota edits preserve reservations, reject invalid input and leave other channels and platform limits unchanged', async () => {
  const [a, b] = await Promise.all([channel(), channel()]);
  const service = `web-budget-${tag()}`;
  await updateBudget(service, platformInput(100), actor);
  await setSpaceBudget(a.spaceId, service, { ...platformInput(10), reservedMinute: 2, reservedHour: 3, reservedDay: 4 }, actor);
  await setSpaceBudget(b.spaceId, service, { ...platformInput(20), reservedDay: 5 }, actor);
  const headers = await adminHeaders();
  const url = `/api/admin/spaces/${a.spaceId}/budgets/${service}`;
  const payload = { perMinute: 30, perHour: 40, perDay: 50, reason: 'adjust channel limits' };
  assert.equal((await app.inject({ method: 'PUT', url, headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  const saved = await app.inject({ method: 'PUT', url, headers, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().space_id, a.spaceId);
  assert.deepEqual([saved.json().reserved_minute, saved.json().reserved_hour, saved.json().reserved_day], [2, 3, 4]);
  const settings = (await app.inject({ url: `/api/admin/spaces/${a.spaceId}/settings`, headers })).json();
  assert.equal(settings.budgets.find((row: { service: string }) => row.service === service).per_day, 50);
  assert.equal((await getSpaceBudgets(b.spaceId)).find(row => row.service === service)?.per_day, 20);
  assert.equal((await sql`SELECT per_day FROM budgets WHERE service = ${service}`)[0]!.per_day, 100);
  for (const bad of [
    { ...payload, perDay: -1 }, { ...payload, perMinute: '30' }, { ...payload, perHour: 2.5 },
    { ...payload, perDay: 3 }, { ...payload, reservedDay: 51 }, { ...payload, reservedDay: -1 },
    { ...payload, perDay: 2_147_483_648 }, { ...payload, reason: '' }, { ...payload, spaceId: b.spaceId },
  ]) assert.equal((await app.inject({ method: 'PUT', url, headers, payload: bad })).statusCode, 400);
  assert.equal((await getSpaceBudgets(a.spaceId)).find(row => row.service === service)?.per_day, 50);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/admin/spaces/missing-channel/budgets/${service}`, headers, payload })).statusCode, 404);
  const audit = await sql`SELECT after FROM audit_log WHERE action = 'space.budget.update' AND subject = ${`space:${a.spaceId}:budget:${service}`} AND reason = ${payload.reason}`;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.after.space_id, a.spaceId);
  assert.equal(audit[0]!.after.reserved_day, 4);
});

test('global content diagnosis identifies the article channel for a scoped source link', async () => {
  const context = await channel('Diagnostic fixture');
  const sourceId = `diagnostic-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, space_id) VALUES (${sourceId}, 'Diagnostic source', 'rss', ${context.spaceId})`;
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.invalid/${sourceId}`, title: 'Diagnostic article',
    bodyText: 'Synthetic body', bodyStatus: 'ok', publishedAt: null, via: 'fetch' }, sql, context);
  const response = await app.inject({ url: `/api/admin/content/${articleId}`, headers: await adminHeaders() });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().article.space_id, context.spaceId);
  assert.equal(response.json().article.source_id, sourceId);
});

test('targets have explicit channel ownership and legacy toggles cannot reach another channel', async () => {
  const [a,b] = await Promise.all([channel(),channel()]);
  const input = targetInput();
  const [first,second] = await Promise.all([configureContentTarget(a.spaceId,input,actor),configureContentTarget(b.spaceId,input,actor)]);
  assert.notEqual(first.key,second.key);
  assert.equal(first.space_id,a.spaceId);
  assert.equal(second.space_id,b.spaceId);
  assert.equal(await setTargetEnabled(String(first.key),true,'wrong default path',actor),null);
  assert.equal(await setTargetEnabled(String(first.key),true,'wrong channel',actor,b.spaceId),null);
  await setTargetEnabled(String(first.key),true,'enable first',actor,a.spaceId);
  assert.equal((await targetState(String(first.key))).enabled,true);
  assert.equal((await targetState(String(second.key))).enabled,false);
  const defaultTarget=await configureContentTarget('default',targetInput(),actor);
  await setTargetEnabled(String(defaultTarget.key),true,'default target',actor);
  assert.equal((await targetState(String(defaultTarget.key))).enabled,true);
  assert.deepEqual((await listTargets(a.spaceId)).map(t=>t.key),[first.key]);
});

test('selected-only defaults remain unchanged; routing/subscription edits advance the no-backfill boundary', async () => {
  const context=await channel();
  await ensureContentTargets(context);
  assert.ok((await listTargets(context.spaceId)).every(t=>JSON.stringify(t.subject_kinds)==='["selected"]' && !t.enabled && t.config_ref===null));
  const input={...targetInput(),enabled:true};
  const target=await configureContentTarget(context.spaceId,input,actor);
  const key=String(target.key);
  await sql`UPDATE notify_targets SET enabled_at='2025-01-01' WHERE key=${key}`;
  const original=(await targetState(key)).enabled_at;
  await configureContentTarget(context.spaceId,{...input,reason:'note only'},actor);
  assert.equal((await targetState(key)).enabled_at,original);
  await setTargetEnabled(key,true,'already enabled',actor,context.spaceId);
  assert.equal((await targetState(key)).enabled_at,original);
  await configureContentTarget(context.spaceId,{...input,subjectKinds:['selected','report']},actor);
  assert.notEqual((await targetState(key)).enabled_at,original);
  const changed=(await targetState(key)).enabled_at;
  await configureContentTarget(context.spaceId,{...input,subjectKinds:['report','selected','report']},actor);
  assert.equal((await targetState(key)).enabled_at,changed,'same subscription set does not reset activation');
  await sql`UPDATE notify_targets SET enabled_at='2025-01-01' WHERE key=${key}`;
  await configureContentTarget(context.spaceId,{...input,configRef:'ANOTHER_CHANNEL_GROUP'},actor);
  assert.notEqual((await targetState(key)).enabled_at,original);
  await setTargetEnabled(key,false,'pause group',actor,context.spaceId);
  await sql`UPDATE notify_targets SET enabled_at='2025-01-01' WHERE key=${key}`;
  await setTargetEnabled(key,true,'resume group',actor,context.spaceId);
  assert.notEqual((await targetState(key)).enabled_at,original);
});

test('target configuration accepts secret references only and cannot inherit legacy default secrets', async () => {
  const context=await channel();
  for (const configRef of ['https://example.com/webhook/secret','secret-value','FEISHU_PUSH_WEBHOOK_URL','FEISHU_PUSH_MIRROR_WEBHOOK_URL']) {
    await assert.rejects(configureContentTarget(context.spaceId,{...targetInput(),configRef},actor));
  }
  await assert.rejects(configureContentTarget(context.spaceId,{...targetInput(),enabled:true,configRef:null},actor),/reference/);
  await assert.rejects(configureContentTarget('unknown-space',targetInput(),actor),/Unknown space/);
  assert.equal((await listTargets(context.spaceId)).length,0);
  const plain=await configureContentTarget(context.spaceId,{...targetInput(),kind:'log',configRef:null},actor);
  assert.equal(plain.config_ref,null);
  const legacy=await configureContentTarget('default',{...targetInput(),configRef:'FEISHU_PUSH_WEBHOOK_URL'},actor);
  assert.equal(legacy.config_ref,'FEISHU_PUSH_WEBHOOK_URL');
});

test('target and platform budget mutations roll back with an unavailable audit log', async () => {
  const context=await channel();
  const input=targetInput();
  const target=await configureContentTarget(context.spaceId,input,actor);
  const key=String(target.key);
  const before=await targetState(key);
  const service=`audit-${tag()}`;
  await updateBudget(service,platformInput(10),actor);
  const platform=async()=>(await sql`SELECT * FROM budgets WHERE service=${service}`)[0];
  const original=await platform();
  await sql.unsafe("CREATE FUNCTION reject_space_settings_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor = 'reject-space-settings' THEN RAISE EXCEPTION 'settings audit unavailable'; END IF; RETURN NEW; END $$");
  await sql.unsafe('CREATE TRIGGER reject_space_settings_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_space_settings_audit()');
  try {
    await assert.rejects(setTargetEnabled(key,true,'enable while audit down','reject-space-settings',context.spaceId),/audit unavailable/);
    assert.deepEqual(await targetState(key),before);
    await assert.rejects(configureContentTarget(context.spaceId,{...input,enabled:true},'reject-space-settings'),/audit unavailable/);
    assert.deepEqual(await targetState(key),before);
    await assert.rejects(updateBudget(service,platformInput(20),'reject-space-settings'),/audit unavailable/);
    assert.deepEqual(await platform(),original);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE actor='reject-space-settings'`).length,0);
  } finally {
    await sql.unsafe('DROP TRIGGER reject_space_settings_audit ON audit_log');
    await sql.unsafe('DROP FUNCTION reject_space_settings_audit()');
  }
  const audits=await sql<{action:string;after:Record<string,unknown>}[]>`SELECT action,after FROM audit_log WHERE actor=${actor} AND subject=${`space:${context.spaceId}:notify-target:${key}`}`;
  assert.equal(audits.length,1);
  assert.equal(audits[0]!.after.space_id,context.spaceId);
});

test('platform downsize and reservation allocation serialize and cannot overallocate capacity', async () => {
  const context=await channel();
  const service=`settings-race-${tag()}`;
  await updateBudget(service,platformInput(10),actor);
  const edits=await Promise.allSettled([
    updateBudget(service,platformInput(5),actor),
    setSpaceBudget(context.spaceId,service,{...platformInput(10),reservedMinute:8,reservedHour:8,reservedDay:8},actor),
  ]);
  assert.equal(edits.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(edits.filter(x=>x.status==='rejected').length,1);
  const [platform]=await sql<{per_minute:number;per_hour:number;per_day:number}[]>`SELECT * FROM budgets WHERE service=${service}`;
  const rows=await getSpaceBudgets(context.spaceId);
  const reservation=rows.find(r=>r.service===service);
  assert.ok((reservation?.reserved_day??0)<=platform!.per_day);
  const second=`settings-stop-${tag()}`;
  await updateBudget(second,platformInput(10),actor);
  await setSpaceBudget(context.spaceId,second,{...platformInput(10),reservedMinute:8,reservedHour:8,reservedDay:8},actor);
  await assert.rejects(updateBudget(second,platformInput(7),actor),/lower than allocated/);
  await updateBudget(second,platformInput(0),actor);
  assert.equal((await sql<{per_day:number}[]>`SELECT per_day FROM budgets WHERE service=${second}`)[0]!.per_day,0,'emergency stop stays available');
  await assert.rejects(updateBudget('',platformInput(10),actor),/service is required/);
});

test('space-ops show reads back scoped targets and quota state without credentials', async () => {
  const [a,b]=await Promise.all([channel(),channel()]);
  const target=await configureContentTarget(a.spaceId,{...targetInput(),configRef:'TEST_SPACE_WEBHOOK'},actor);
  await configureContentTarget(b.spaceId,targetInput(),actor);
  const service=`cli-${tag()}`;
  await setSpaceBudget(a.spaceId,service,{...platformInput(3)},actor);
  const secret='test-secret-must-never-be-output';
  const output=execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/space-ops.ts',import.meta.url)),'show','--space',a.spaceId],
    {encoding:'utf8',env:{...process.env,TEST_SPACE_WEBHOOK:secret},stdio:['ignore','pipe','pipe']});
  const shown=JSON.parse(output);
  assert.equal(shown.space.id,a.spaceId);
  assert.deepEqual(shown.targets.map((x:{key:string})=>x.key),[target.key]);
  assert.deepEqual(shown.budgets.map((x:{service:string;per_day:number;used_day:number})=>[x.service,x.per_day,x.used_day]),[[service,3,0]]);
  assert.doesNotMatch(output,new RegExp(secret));
  assert.doesNotMatch(output,new RegExp(b.spaceId));
});
