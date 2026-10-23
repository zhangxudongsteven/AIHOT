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

const actor = `settings-${tag()}`;
after(closeDb);
async function channel() {
  const id = `settings-${tag()}`;
  await sql`INSERT INTO spaces(id,slug,enabled) VALUES(${id},${id},true)`;
  const context = await storeSpaceConfig(id, defaultSpaceConfig());
  await sql`UPDATE spaces SET active_config_version=${context.configVersion} WHERE id=${id}`;
  return context;
}
const targetInput = (name = `group-${tag()}`) => ({ name, kind: 'feishu_webhook' as const, configRef: 'TEST_SPACE_WEBHOOK', subjectKinds: ['selected'] as Array<'selected'|'report'>, enabled: false, reason: 'configure channel group' });
const targetState = async (key: string) => (await sql`SELECT space_id,kind,enabled,enabled_at::text AS enabled_at,config_ref,subject_kinds,updated_at::text AS updated_at FROM notify_targets WHERE key=${key}`)[0]!;
const platformInput = (limit: number) => ({ perMinute: limit, perHour: limit, perDay: limit, reason: 'platform capacity' });

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
