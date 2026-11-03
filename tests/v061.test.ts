import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {JournalQueries} from '../electron/core/queries';
import {InboxSync} from '../electron/core/inbox';
import {dayBounds,journalDay,calendarDay,DAY_POLICY_VERSION} from '../src/shared/dates';
import {queryPeriod,periodBounds,temporalScope} from '../electron/core/recall';
import {resolveRecordDate} from '../electron/core/dates';
import {AssistantService} from '../electron/ai/service';
import {validateMutation} from '../electron/core/ipc';
import type {Message} from '../src/shared/types';

const zone='Asia/Shanghai';
function fixture(t:test.TestContext){
  const base=mkdtempSync(path.join(tmpdir(),'bodyjournal-v061-')),root=path.join(base,'vault'),inbox=path.join(base,'inbox');mkdirSync(inbox);
  const store=new HealthStore(root,new FoodCatalog([]),inbox,false);
  t.after(()=>{store.close();rmSync(base,{recursive:true,force:true});});
  return {base,root,inbox,store};
}
function record(store:HealthStore,id:string,at:string,kind='note',text='合成测试记录'){
  return store.importEnvelope({version:1,id:'synthetic-'+id,kind,text,occurredAt:at,timezone:zone,dateLocked:true}).record;
}
function deepseek(value:unknown){return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(value)}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}})}\n\ndata: [DONE]\n\n`);}

test('four oclock grouping uses wall time across month, week and DST while steps use midnight',()=>{
  assert.equal(journalDay('2026-11-03T03:59:59+08:00',zone),'2026-11-02');
  assert.equal(journalDay('2026-11-03T04:00:00+08:00',zone),'2026-11-03');
  assert.equal(journalDay('2026-11-01T01:00:00+08:00',zone),'2026-10-31');
  assert.equal(calendarDay('2026-11-03T01:20:00+08:00',zone),'2026-11-03');
  const b=dayBounds('2026-10-31','2026-10-31','America/New_York');assert.equal((b.until-b.from)/3600000,25);
  const at=new Date('2026-11-03T01:30:00+08:00');
  assert.equal(queryPeriod('今天摄入多少',zone,at).period!.from,'2026-11-02');
  assert.equal(queryPeriod('今天给三点训练建议',zone,at).period!.basis,'journal');
  assert.equal(queryPeriod('今天晚上十点能训练吗',zone,at).period!.fromAt,'2026-11-01T20:00:00.000Z');
  assert.equal(queryPeriod('今天走了多少步',zone,at).period!.from,'2026-11-03');
  const exact=queryPeriod('11月3日凌晨一点吃了什么',zone,at);assert.equal(new Date(periodBounds(exact.period!,zone).from).toISOString(),'2026-11-02T17:00:00.000Z');
  assert.equal(temporalScope('这周最多练40分钟','2026-11-02T10:00:00+08:00',zone).expiresAt,'2026-11-08T20:00:00.000Z');
  assert.equal(resolveRecordDate('今天吃了合成夜宵',at.toISOString(),zone)!.occurredAt,at.toISOString());
  assert.equal(resolveRecordDate('11月3日凌晨一点吃了合成夜宵',at.toISOString(),zone)!.occurredAt,'2026-11-02T17:00:00.000Z');
  assert.equal(resolveRecordDate('11月3日早餐吃了一点合成食物','2026-11-03T12:00:00+08:00',zone)!.dateOnly,true);
});

test('a 1am run belongs to the preceding journal and is deducted only from its civil day steps',t=>{
  const {store}=fixture(t),now=new Date('2026-11-04T12:00:00+08:00');
  store.importEnvelope({version:1,id:'test-weight',kind:'body',body:{weightKg:70},text:'合成体重',occurredAt:'2026-11-01T08:00:00+08:00',timezone:zone});
  store.energy.saveProfile({effectiveDate:'2026-11-01',age:25,heightCm:175,sex:'male',activity:'seated',strengthMinutes:{low:45,high:60},strengthPerWeek:3,runMinutes:30,runPerWeek:1,runPace:360,generalAdult:true,usualSteps:3000},now);
  const r=record(store,'night-run','2026-11-03T01:00:00+08:00','training','已完成跑步3公里，18分钟，3000步');
  store.applyAnalysis(r.id,{summary:'合成跑步',questions:[],assumptions:[],run:{km:3,minutes:18,steps:3000,completion:'completed'}},'local',r.revision);
  for(const date of ['2026-11-02','2026-11-03'])store.energy.saveDay({date,steps:10000,mealComplete:false,activityComplete:true},now);
  const prior=store.energy.day('2026-11-02'),civil=store.energy.day('2026-11-03');
  assert.equal(prior.workouts.length,1);assert.equal(civil.workouts.length,0);
  assert.equal(prior.walking!.nonTrainingSteps,10000);assert.equal(civil.walking!.nonTrainingSteps,7000);
  const changed=store.revise(r.id,{occurredAt:'2026-11-02T23:55:00+08:00'},store.record(r.id).revision);
  assert.equal(store.energy.day('2026-11-02').walking!.pending,'overlap');
  assert.equal(store.energy.day('2026-11-03').walking!.pending,'overlap');
  store.undoRecord(changed.id);assert.equal(store.energy.day('2026-11-03').walking!.nonTrainingSteps,7000);
});

test('upgrade snapshots the v5 archive before regrouping and preserves original record documents',t=>{
  const {store,base,root,inbox}=fixture(t),r=record(store,'night','2026-11-03T01:20:00+08:00','meal','合成夜宵');
  store.db.prepare('DELETE FROM config WHERE key=?').run('dayPolicyVersion');
  store.db.exec('PRAGMA user_version=5');const before=JSON.stringify(store.record(r.id));store.close();
  const upgraded=new HealthStore(root,new FoodCatalog([]),inbox,false);
  try{
    assert.equal(JSON.stringify(upgraded.record(r.id)),before);
    const report=upgraded.getConfig<any>('dayMigrationReport');assert.deepEqual(report.moved,[{id:r.id,from:'2026-11-03',to:'2026-11-02'}]);
    const rollback=readdirSync(base).find(x=>x.startsWith('vault-before-v061-'))!;assert.ok(rollback);
    const old=new DatabaseSync(path.join(base,rollback,'health.sqlite'),{readOnly:true});assert.equal(old.prepare('PRAGMA user_version').get()!.user_version,5);old.close();
    const archive=path.join(base,'roundtrip.bodyjournal');upgraded.backup(archive);upgraded.restoreFile(archive);
    assert.equal(JSON.stringify(upgraded.record(r.id)),before);assert.equal(upgraded.getConfig('dayPolicyVersion'),DAY_POLICY_VERSION);
  }finally{upgraded.close();}
});

test('record and message keyset pages cover 10000 rows without transferring the archive on overview reads',t=>{
  const {store}=fixture(t),seed=record(store,'seed','2026-11-03T12:00:00+08:00');
  const insert=store.db.prepare('INSERT INTO records VALUES(?,?,?)'),message=store.db.prepare('INSERT INTO messages VALUES(?,?)');
  store.db.exec('BEGIN');
  for(let i=0;i<10000;i++){
    const id='synthetic-'+String(i).padStart(5,'0');insert.run(id,JSON.stringify({...seed,id,text:'合成历史 '+i}),'fingerprint-'+i);
    const m:Message={id,role:'user',text:'合成历史问题 '+i,createdAt:'2026-11-03T04:00:00Z',status:'complete',provider:'test',stale:false,sources:[]};message.run(id,JSON.stringify(m));
  }store.db.exec('COMMIT');
  const queries=new JournalQueries(store),changes=store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const first=queries.records(),second=queries.records({cursor:first.next});assert.equal(first.items.length,50);assert.equal(second.items.length,50);assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,100);
  assert.equal(first.total,10001);assert.equal(queries.records({search:'历史 9999'}).items[0].id,'synthetic-09999');
  const messages=queries.messages(),earlier=queries.messages({before:messages.before});assert.equal(messages.items.length,30);assert.equal(earlier.items.length,30);assert.ok(!earlier.items.some(m=>messages.items.some(x=>x.id===m.id)));
  const overview={summary:queries.summary(),records:queries.records({limit:12}).items};assert.equal(overview.summary.total,10001);assert.ok(JSON.stringify(overview).length<50000);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
});

test('inbox discovers entries beyond 5000 files, retries partial JSON, deduplicates and survives restart',async t=>{
  const {store,inbox,base}=fixture(t),envelope={version:1,id:'shared-old',kind:'note',text:'合成旧记录',occurredAt:'2026-11-03T12:00:00+08:00',timezone:zone};
  store.importEnvelope(envelope);
  for(let i=0;i<5001;i++)writeFileSync(path.join(inbox,'old-'+String(i).padStart(5,'0')+'.json'),JSON.stringify(envelope));
  const latest=path.join(inbox,'zz-new.json');writeFileSync(latest,'{"version":');
  const state=path.join(base,'inbox-state.json');let sync=new InboxSync(store,state,()=>{});sync.start();
  try{
    await sync.scan();assert.equal(store.syncState.pending,1);assert.equal(store.records().length,1);
    writeFileSync(latest,JSON.stringify({...envelope,id:'shared-new',text:'合成新记录'}));await sync.scan();assert.equal(store.records().length,2);
    await sync.scan();assert.equal(store.records().length,2);await sync.stop();
    sync=new InboxSync(store,state,()=>{});sync.start();await sync.scan();assert.equal(store.records().length,2);
    assert.ok(!readFileSync(state,'utf8').includes('合成新记录'));
  }finally{await sync.stop();}
});

test('schema boundary rejects invalid revisions, timestamps, body measurements and deletion payloads',()=>{
  assert.throws(()=>validateMutation('record:update',{id:'synthetic-r',revision:1,text:5}));
  assert.throws(()=>validateMutation('record:update',{id:'synthetic-r',revision:1,occurredAt:'invalid'}));
  assert.throws(()=>validateMutation('record:update',{id:'synthetic-r',revision:1,body:{weightKg:-1}}));
  assert.throws(()=>validateMutation('record:setDeleted',{id:'synthetic-r',deleted:'yes'}));
});

test('both serialized model channels receive separate journal and civil dates at 1am with one call',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-03T01:30:00+08:00')});
  for(const provider of ['chatgpt','deepseek'] as const){
    const {store}=fixture(t);store.setSettings({...store.getSettings(),provider,chatgptModel:'synthetic-model',deepseekBudget:100});
    record(store,'night-food','2026-11-03T01:20:00+08:00','meal','合成夜宵');
    let calls=0;
    const service=new AssistantService(store,{accessToken:async()=>'synthetic-token'} as any,{read:async()=>({deepseekKey:'synthetic'}),write:async()=>{}},()=>{},x=>x,async(_url,init)=>{
      calls++;const body=JSON.parse(String(init?.body)),payload=JSON.parse(provider==='chatgpt'?body.input[0].content[0].text:body.messages[1].content[0].text);
      assert.equal(payload.context.query.period.from,'2026-11-02');assert.equal(payload.context.stepPeriod.from,'2026-11-03');
      assert.ok(payload.context.records.some((r:any)=>r.id==='synthetic-night-food'));
      const result={answerMarkdown:'11月2日手记包含这顿夜宵，11月3日步数尚待补充。',memoryChanges:[]};
      return provider==='deepseek'?deepseek(result):new Response(`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(result)})}\n\nevent: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:10}}})}\n\n`);
    });
    await service.chat('今天吃了多少、走了多少步？');assert.equal(calls,1);
    const receipt=store.messages().at(-1)!.contextReceipt!;assert.equal(receipt.dayPolicy!.journalStartHour,4);assert.equal(receipt.stepPeriod!.from,'2026-11-03');
  }
});

test('an in-flight request freezes provider and prices and cannot overwrite a revised source',async t=>{
  const {store}=fixture(t),r=record(store,'analyse','2026-11-03T12:00:00+08:00','meal','合成一餐');
  store.setSettings({...store.getSettings(),provider:'deepseek',deepseekBudget:100,deepseekInputPrice:1,deepseekOutputPrice:2});
  let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});let calls=0;
  const service=new AssistantService(store,{} as any,{read:async()=>({deepseekKey:'synthetic'}),write:async()=>{}},()=>{},x=>x,async(_url,init)=>{
    calls++;assert.equal(JSON.parse(String(init?.body)).model,'deepseek-flash');started();await waiting;
    return deepseek({summary:'旧输入的合成分析',questions:[],assumptions:[],ingredients:[]});
  });
  const running=service.analyze([r.id]);await ready;
  store.setSettings({...store.getSettings(),provider:'chatgpt',deepseekInputPrice:999});
  const revised=store.revise(r.id,{text:'已经更正的合成一餐'},r.revision);release();
  await assert.rejects(running,/分析期间记录已修改/);assert.equal(store.record(r.id).revision,revised.revision);assert.equal(store.record(r.id).text,revised.text);assert.equal(calls,1);
  assert.equal(store.usage().cost,0.00003);
});
