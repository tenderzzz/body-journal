import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {parseTraining} from '../electron/core/parser';
import {addDays,restingEnergy,workoutExtra,initialEnergySuggestion,runningMET} from '../src/shared/energy';
import type {EnergyProfile} from '../src/shared/types';
import {AssistantService} from '../electron/ai/service';
import type {ChatGPTAuth,SecretStorage} from '../electron/ai/auth';
import {computeStats} from '../src/shared/stats';
import type {HealthRecord} from '../src/shared/types';

const now=new Date('2026-10-27T12:00:00Z'),today='2026-10-27';
const profile={effectiveDate:'2026-09-01',age:30,heightCm:180,sex:'male' as const,activity:'seated' as const,strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:20,runPerWeek:1,runPace:360,generalAdult:true};
function setup(t:test.TestContext){t.mock.timers.enable({apis:['Date'],now:+now});const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-energy-'));const store=new HealthStore(root,new FoodCatalog([]),path.join(root,'inbox'),false);t.after(()=>{if(store.db.isOpen)store.close();rmSync(root,{recursive:true,force:true});});return store;}
function weight(store:HealthStore,date=today,kg=80){return store.importEnvelope({version:1,id:randomUUID(),kind:'body',occurredAt:date+'T08:00:00+08:00',timezone:'Asia/Shanghai',body:{weightKg:kg},text:'晨间体重'}).record;}
function training(store:HealthStore,text:string,date=today){return store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:date+'T18:00:00+08:00',timezone:'Asia/Shanghai',text}).record;}
function meal(store:HealthStore,date=today,kcal={low:2000,high:2200}){const r=store.importEnvelope({version:1,id:randomUUID(),kind:'meal',occurredAt:date+'T12:00:00+08:00',timezone:'Asia/Shanghai',text:'测试：当天所有饮食合并记录'}).record;return store.applyAnalysis(r.id,{summary:'合成测试饮食',questions:[],assumptions:[],ingredients:[{name:'合成测试食材',foodId:null,grams:{low:1000,high:1000},assumption:'测试',nutrition:{source:'estimate',basis:'合成测试',per100g:{kcal:{low:kcal.low/10,high:kcal.high/10},protein:{low:10,high:11},carbs:{low:5,high:6},fat:{low:2,high:2.5}}}}]},'local',r.revision);}
function complete(store:HealthStore,date=today){store.energy.saveDay({date,mealComplete:true,activityComplete:true},now);}
function photoRun(store:HealthStore){
  const r=store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:today+'T18:00:00+08:00',timezone:'Asia/Shanghai',text:'无补充',attachments:[{name:'run.png',mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGqoAAAAASUVORK5CYII='}]}).record;
  return store.applyAnalysis(r.id,{summary:'户外跑步结果截图：5.02公里，训练时长26分54秒。',questions:[],assumptions:['数据来自截图，不从备注补造。'],sets:[],run:{km:5.02,minutes:26.9}},'deepseek',r.revision);
}
function eligible(store:HealthStore){store.energy.saveProfile(profile,now);store.energy.saveTarget({effectiveDate:'2026-10-06',mode:'maintain',kcal:2300,protein:128},new Date('2026-10-06T04:00:00Z'));for(let i=0;i<21;i++){const day=addDays('2026-10-06',i);weight(store,day,80-i*.01);meal(store,day,{low:800,high:900});complete(store,day);}return store.energy.review(now);}

test('Mifflin equations and net exercise replace overlapping baseline energy',()=>{
  assert.equal(restingEnergy(80,180,30,'male'),1780);
  assert.equal(restingEnergy(65,165,30,'female'),1370.25);
  const extra=workoutExtra(80,{low:60,high:60},{low:3.5,high:6},{low:2136,high:2403});
  assert.ok(Math.abs(extra.low-(3.5*3.5*80/200-2403/1440)*60)<1e-9);
  assert.ok(extra.high<6*3.5*80/200*60);
  assert.equal(runningMET(360)?.low,9.3);
  assert.equal(runningMET(100),null);
});
test('mixed strength and running durations are independent; pure reported runs are completed',()=>{
  const a=parseTraining("卧推 50kg 3x8\n力量训练60分钟\n跑步3km 配速6' 用时18分钟")!;
  assert.equal(a.training?.durationMinutes,60);
  assert.equal(a.run?.minutes,18);
  assert.equal(parseTraining("跑步3km 6'")?.training?.completion,'completed');
});
test('legacy photo-only runs enter energy and trends and keep an already-saved activity confirmation',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);const r=photoRun(store);complete(store);
  const d=store.energy.day(today);
  assert.equal(d.workouts.length,1);assert.equal(d.workouts[0].kind,'run');assert.equal(d.workouts[0].minutes.low,26.9);
  assert.ok(d.workouts[0].extra.low>0);assert.equal(d.activityComplete,true);
  assert.equal(computeStats(store.records()).runs.length,1);
  assert.equal(store.record(r.id).revision,r.revision);assert.equal(store.record(r.id).text,'无补充');
});
test('photo recognition can explicitly confirm completion without requiring duplicate text',async t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);const r=photoRun(store);
  const confirmed={...r,analysis:{...r.analysis!,run:{...r.analysis!.run!,completion:'completed' as const}}};
  const d=()=>store.energy.day(today);
  const view=computeStats([confirmed]);assert.equal(view.runs.length,1);
  store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(confirmed),r.id);
  assert.equal(d().workouts.length,1);
  const service=assistant(t,store,body=>{assert.match(body.instructions,/run.completion必须单独标注/);return sse({summary:'已完成的跑步结果截图',questions:[],assumptions:[],sets:[],run:{km:5.02,minutes:26.9,completion:'completed'}});});
  await service.analyze([r.id]);assert.equal(store.record(r.id).analysis?.run?.completion,'completed');
});
test('legacy photo fallback never upgrades explicit unknown, pending, questions, plans or cancellations',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);const w=weight(store),r=photoRun(store);
  const variants:HealthRecord[]=[
    {...r,analysis:{...r.analysis!,run:{...r.analysis!.run!,completion:'unknown'}}},
    {...r,status:'pending'},
    {...r,status:'needs_info',analysis:{...r.analysis!,questions:['这张图是实际结果还是计划？']}},
    {...r,analysis:{...r.analysis!,summary:'这是跑步计划截图，预计跑5公里。'}},
    {...r,analysis:{...r.analysis!,summary:'这是跑步计划截图，预计跑5公里。',run:{...r.analysis!.run!,completion:'completed'}}},
    {...r,text:'明天计划跑步5km',analysis:{...r.analysis!,run:{...r.analysis!.run!,completion:'completed'}}},
    {...r,text:'这次没有完成跑步',analysis:{...r.analysis!,run:{...r.analysis!.run!,completion:'completed'}}},
    {...r,attachments:[]}
  ];
  for(const candidate of variants){
    assert.equal(computeStats([candidate]).runs.length,0,JSON.stringify({text:candidate.text,status:candidate.status,run:candidate.analysis?.run}));
    const prior=store.record(r.id);store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(candidate),r.id);
    assert.equal(store.energy.day(today).workouts.length,0);store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(prior),r.id);
  }
});
test('photo running completion is independent of completed or planned strength in mixed logs',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);const r=photoRun(store),sets=parseTraining('卧推 50kg 3x8')!.sets;
  const plannedRun:HealthRecord={...r,text:'卧推 50kg 3x8\n明天计划跑步3km',analysis:{...r.analysis!,sets,training:{part:'chest',completion:'completed'},run:{...r.analysis!.run!,completion:'planned'}}};
  store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(plannedRun),r.id);
  assert.deepEqual(store.energy.day(today).workouts.map(w=>w.kind),['strength']);assert.equal(computeStats([plannedRun]).runs.length,0);
  const completedRun:HealthRecord={...r,text:'明天计划训练\n卧推 50kg 3x8\n跑步3km 6\'',analysis:{...r.analysis!,sets,training:{part:'chest',completion:'planned'},run:{...r.analysis!.run!,completion:'completed'}}};
  store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(completedRun),r.id);
  assert.deepEqual(store.energy.day(today).workouts.map(w=>w.kind),['run']);assert.equal(computeStats([completedRun]).runs.length,1);
  const photoWithPlannedStrength={...completedRun,text:'明天计划训练\n卧推50kg3x8'};
  store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(photoWithPlannedStrength),r.id);
  assert.deepEqual(store.energy.day(today).workouts.map(w=>w.kind),['run']);assert.equal(computeStats([photoWithPlannedStrength]).runs.length,1);
});
test('missing profile or preceding weight never uses future measurements',t=>{
  const store=setup(t);weight(store,'2026-10-28');
  assert.equal(store.energy.day(today).expenditure,null);
  store.energy.saveProfile(profile,now);assert.equal(store.energy.day(today).weight,undefined);
  weight(store,'2026-09-01');const d=store.energy.day(today);
  assert.equal(d.resting,1780);assert.ok(d.assumptions.some(a=>a.includes('超过30天')));
});
test('confirmed usual duration is an assumption, plans are excluded and inputs stay unchanged',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);
  const r=training(store,'卧推 50kg 3x8');training(store,'明天计划训练\n深蹲60kg 3x8');
  const day=store.energy.day(today);assert.equal(day.workouts.length,1);assert.equal(day.workouts[0].assumed,true);assert.deepEqual(day.workouts[0].minutes,{low:60,high:75});
  assert.equal(store.record(r.id).analysis?.training?.durationMinutes,undefined);
  store.energy.saveDay({date:today,steps:20000,mealComplete:false,activityComplete:false},now);
  assert.deepEqual(store.energy.day(today).expenditure,day.expenditure);
  store.revise(r.id,{deleted:true},r.revision);assert.equal(store.energy.day(today).workouts.length,0);
  store.undoRecord(r.id);assert.equal(store.energy.day(today).workouts.length,1);
});
test('completed strength and a planned run are counted independently; cancelled runs and walks are not running',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);
  training(store,'卧推 50kg 3x8\n力量训练60分钟\n明天计划跑步3km，配速6分/公里');
  assert.deepEqual(store.energy.day(today).workouts.map(w=>w.kind),['strength']);
  assert.equal(parseTraining('没有完成跑步3km')?.training?.completion,'unknown');
  assert.equal(parseTraining('步行3km 用时30分钟')?.run,undefined);
});
test('standalone plan headings and action-prefixed plans never count as completed workouts',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);
  training(store,'计划：\n卧推 50kg 3x8');training(store,'计划卧推 50kg 3x8');training(store,'计划：\n跑步3km 6\'');
  assert.deepEqual(store.energy.day(today).workouts,[]);
  training(store,'卧推 50kg 3x8\n计划跑步3km 配速6\'');
  assert.deepEqual(store.energy.day(today).workouts.map(w=>w.kind),['strength']);
});
test('incomplete meals never yield a deficit; complete interval spanning zero is uncertain',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);meal(store);
  assert.equal(store.energy.day(today).balance,null);complete(store);
  assert.equal(store.energy.day(today).balanceState,'uncertain');
  const partial=store.importEnvelope({version:1,id:randomUUID(),kind:'meal',occurredAt:today+'T20:00:00+08:00',timezone:'Asia/Shanghai',text:'还有一餐没有分析'}).record;
  assert.equal(store.energy.day(today).intake.complete,false);complete(store);assert.equal(store.energy.day(today).balance,null);
  store.revise(partial.id,{deleted:true},1);complete(store);assert.equal(store.energy.day(today).balanceState,'uncertain');
});
test('complete intake and expenditure use full interval subtraction and require reconfirmation after edits',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);const m=meal(store,today,{low:100,high:200});complete(store);
  assert.equal(store.energy.day(today).balanceState,'deficit');
  assert.deepEqual(store.energy.day(today).balance,{low:100-2403,high:200-2136});
  store.revise(m.id,{text:'修改了分量'},m.revision);assert.equal(store.energy.day(today).balanceState,'incomplete');
});
test('timezone groups actual dates and invalid calendar days are rejected',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store,'2026-10-26');
  store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:'2026-10-26T23:30:00Z',timezone:'UTC',text:'卧推50kg 3x8'});
  assert.equal(store.energy.day(today).sources.length,2);
  assert.throws(()=>store.energy.day('2026-02-30'));
});
test('fixed targets preserve manual settings and effective-date history',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);
  const p=store.energy.profiles()[0];const suggested=initialEnergySuggestion(p,{id:'weight-test',kg:80},'lose')!;
  assert.equal(suggested.kcal%50,0);assert.equal(suggested.protein,128);
  assert.equal(initialEnergySuggestion({...p,generalAdult:false},{id:'weight-test',kg:80},'gain'),null);
  store.setSettings({...store.getSettings(),goals:{...store.getSettings().goals,kcal:2200,protein:130}});
  const before=store.energy.day(today).target;training(store,'卧推50kg 3x8');assert.equal(store.energy.day(today).target?.kcal,2200);
  store.energy.saveTarget({effectiveDate:today,mode:before!.mode,kcal:2200,protein:130},now);assert.equal(store.energy.day(today).target?.id,before?.id);
  store.energy.saveTarget({effectiveDate:'2026-10-28',mode:'gain',kcal:2400,protein:130},now);
  assert.equal(store.energy.day(today).target?.id,before?.id);assert.equal(store.energy.day('2026-10-28').target?.kcal,2400);
  assert.equal(store.getSettings().goals.kcal,2200);
  store.energy.syncTarget(new Date('2026-10-28T04:00:00Z'));assert.equal(store.getSettings().goals.kcal,2400);
});
test('review needs 21 unchanged target days, 15 complete food days and three weight days each week',t=>{
  const store=setup(t);assert.equal(store.energy.review(now).eligible,false);
  assert.equal(eligible(store).eligible,true);
  store.energy.saveDay({date:'2026-10-06',mealComplete:false,activityComplete:true},now);
  assert.equal(store.energy.review(now).completeDays,20);
  store.energy.saveProfile({...profile,generalAdult:false},now);assert.equal(store.energy.review(now).eligible,false);
});
test('proposals require adoption, next-day activation, bounded changes, cooldown, undo and stale rejection',t=>{
  const store=setup(t);const review=eligible(store);
  const hash=store.energy.hash(review.from,today),id=randomUUID();
  assert.throws(()=>store.energy.createProposal({kcal:2450,reason:'测试'},id,hash,now),/100/);
  const p=store.energy.createProposal({kcal:2400,reason:'合成测试调整'},id,hash,now);
  assert.equal(store.energy.day(today).target?.kcal,2300);
  const target=store.energy.applyProposal(p.id,now);assert.equal(target.effectiveDate,'2026-10-28');assert.equal(store.energy.day(today).target?.kcal,2300);
  assert.equal(store.energy.day('2026-10-28').target?.kcal,2400);
  assert.equal(store.energy.review(new Date('2026-10-28T04:00:00Z')).eligible,false);
  store.energy.undoTarget(target.id,now);assert.equal(store.energy.day('2026-10-28').target?.kcal,2300);
  const p2=store.energy.createProposal({kcal:2200,reason:'测试过期'},id,store.energy.hash(review.from,today),now);
  weight(store,today,79);assert.throws(()=>store.energy.applyProposal(p2.id,now),/变化|过期/);
});
test('undo after an adjustment has been used preserves its historical day and restores the previous goal prospectively',t=>{
  const store=setup(t),review=eligible(store),p=store.energy.createProposal({kcal:2400,reason:'合成测试'},randomUUID(),store.energy.hash(review.from,today),now);
  const target=store.energy.applyProposal(p.id,now);
  store.energy.undoTarget(target.id,new Date('2026-10-29T04:00:00Z'));
  assert.equal(store.energy.day('2026-10-28').target?.kcal,2400);
  assert.equal(store.energy.day('2026-10-29').target?.kcal,2300);
  assert.equal(store.energy.targets().find(t=>t.id===target.id)?.undoneAt,undefined);
});
test('undoing the first already-used goal clears it prospectively without erasing historical targets',t=>{
  const store=setup(t);eligible(store);const target=store.energy.targets()[0];
  store.energy.undoTarget(target.id,new Date('2026-10-29T04:00:00Z'));
  assert.equal(store.energy.day('2026-10-28').target?.kcal,2300);
  assert.equal(store.energy.day('2026-10-29').target,null);
  assert.equal(store.energy.view({},new Date('2026-10-29T04:00:00Z')).currentTarget,null);
  assert.equal(store.getSettings().goals.kcal,null);
});
test('energy answers invalidate on new records, profile changes and day confirmations',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);weight(store);
  const context=store.energy.chatContext('今天怎么吃',now),createdAt=now.toISOString();
  const msg={id:randomUUID(),role:'assistant' as const,text:'测试',createdAt,status:'complete' as const,sources:[],provider:'test',stale:false,energyDependency:context.dependency};store.putMessage(msg);
  meal(store);assert.equal(store.messages().at(-1)?.stale,true);
  store.putMessage({...msg,energyDependency:store.energy.chatContext('今天怎么吃',now).dependency});
  store.energy.saveDay({date:today,mealComplete:true,activityComplete:true},now);assert.equal(store.messages().at(-1)?.stale,true);
});
test('dependency hashes use the same actual-time ordering as calculation for preceding mixed-timezone weights',t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);
  const a=store.importEnvelope({version:1,id:randomUUID(),kind:'body',occurredAt:'2026-09-30T23:00:00-10:00',timezone:'Pacific/Honolulu',body:{weightKg:80},text:'体重A'}).record;
  store.importEnvelope({version:1,id:randomUUID(),kind:'body',occurredAt:'2026-10-01T08:00:00Z',timezone:'UTC',body:{weightKg:70},text:'体重B'});
  const c=store.energy.chatContext('今天怎么吃',now);assert.equal(c.selected.weight?.id,a.id);
  store.putMessage({id:randomUUID(),role:'assistant',text:'合成测试',createdAt:now.toISOString(),status:'complete',sources:[],provider:'test',stale:false,energyDependency:c.dependency});
  store.revise(a.id,{body:{weightKg:90}},a.revision);
  assert.equal(store.energy.day(today).resting,1880);
  assert.equal(store.messages().at(-1)?.stale,true);
});
test('v1 migration creates a pre-upgrade backup; v2 backup round-trip and v1 restore clear energy data',t=>{
  let store=setup(t);store.energy.saveProfile(profile,now);weight(store);meal(store);complete(store);
  const bundle=store.exportBundle();assert.equal(bundle.version,2);
  const expected=store.energy.export();store.energy.saveProfile({...profile,heightCm:170},now);store.restore(bundle);assert.deepEqual(store.energy.export(),expected);
  const bad=structuredClone(bundle);bad.energy!.profiles[0].heightCm=0;assert.throws(()=>store.restore(bad));assert.deepEqual(store.energy.export(),expected);
  store.restore({...bundle,version:1,energy:undefined});assert.deepEqual(store.energy.export(),{profiles:[],targets:[],days:[],proposals:[]});
  const root=store.root;store.db.exec('PRAGMA user_version=1');store.close();
  store=new HealthStore(root,new FoodCatalog([]),path.join(root,'inbox'),false);
  const files=readdirSync(path.join(root,'backups')).filter(f=>f.startsWith('before-energy-v2-'));assert.equal(files.length,1);assert.equal(JSON.parse(readFileSync(path.join(root,'backups',files[0]),'utf8')).version,1);
  assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version,2);store.close();
});

function sse(value:unknown,complete=true){const text=JSON.stringify(value);return new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:text})}\n\n`+(complete?`data: ${JSON.stringify({type:'response.completed',response:{usage:{input_tokens:20,output_tokens:30}}})}\n\n`:''),{headers:{'Content-Type':'text/event-stream'}});}
function assistant(t:test.TestContext,store:HealthStore,respond:(body:any)=>Response){
  store.setSettings({...store.getSettings(),chatgptModel:'test-model'});
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(_input,init)=>respond(JSON.parse(String(init?.body)));
  return new AssistantService(store,{accessToken:async()=> 'synthetic-token'} as ChatGPTAuth,{read:async()=>({}),write:async()=>{}} as SecretStorage,()=>{});
}
test('energy questions use the same local results as the page, and never change goals by answering',async t=>{
  const store=setup(t);store.energy.saveProfile(profile,now);const w=weight(store);meal(store);let calls=0;
  const service=assistant(t,store,body=>{calls++;const context=JSON.parse(body.input[0].content[0].text).context;
    assert.deepEqual(context.energy.selected.expenditure,store.energy.day(today).expenditure);
    assert.equal(context.energy.selected.balance,null);assert.match(body.instructions,/不要自己重算TDEE/);
    return sse({answerMarkdown:`饮食还没有记齐，先看已记部分。[记录:${w.id}]`,memoryChanges:[],goalProposal:null});});
  store.energy.view({},now);assert.equal(calls,0);await service.chat('今天怎么吃？');
  assert.equal(calls,1);assert.equal(store.energy.targets().length,0);assert.ok(store.messages().at(-1)?.energyDependency);
});
test('AI proposals are pending; invalid numeric proposals roll back accompanying memory changes',async t=>{
  const store=setup(t);eligible(store);
  let invalid=false;
  const service=assistant(t,store,()=>sse({answerMarkdown:'这只是调整草案，采纳后才生效。',memoryChanges:invalid?[{operation:'upsert',key:'eating.preference',kind:'fact',text:'喜欢米饭',evidenceQuote:'我喜欢米饭'}]:[],goalProposal:{kcal:invalid?2500:2400,reason:'三周合成记录，仅供测试'}}));
  await service.chat('请检查目标是否需要调整？');
  assert.equal(store.energy.proposals().length,1);assert.equal(store.energy.targetAt(today)?.kcal,2300);assert.ok(store.messages().at(-1)?.goalProposalId);
  invalid=true;await assert.rejects(()=>service.chat('我喜欢米饭，请检查目标是否需要调整？'),/100/);
  assert.equal(store.energy.proposals().length,1);assert.equal(store.memories().filter(m=>m.topicKey==='eating.preference').length,0);
});
test('a response interrupted or made stale in flight never creates an adoptable proposal',async t=>{
  const store=setup(t);eligible(store);let interrupted=true;
  const service=assistant(t,store,()=>{if(!interrupted)weight(store,today,79);return sse({answerMarkdown:'待确认',memoryChanges:[],goalProposal:{kcal:2400,reason:'合成测试'}},!interrupted);});
  await assert.rejects(()=>service.chat('目标需要调整吗？'),/中断/);assert.equal(store.energy.proposals().length,0);
  interrupted=false;await assert.rejects(()=>service.chat('目标需要调整吗？'),/依据发生变化/);assert.equal(store.energy.proposals().length,0);
});
test('legacy duration repair preserves raw text and history and is idempotent',t=>{
  const store=setup(t),r=training(store,"卧推 50kg 3x8\n力量训练60分钟\n跑步3km 配速6' 用时18分钟");
  const legacy={...r,analysis:{...r.analysis!,run:{...r.analysis!.run!,minutes:60}}};
  store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(legacy),r.id);
  const raw=readFileSync(path.join(store.root,'raw',r.id+'.json'),'utf8');
  assert.equal(store.migrateEnergyParsing(),1);assert.equal(store.record(r.id).analysis?.run?.minutes,18);assert.equal(store.history(r.id).length,1);assert.equal(readFileSync(path.join(store.root,'raw',r.id+'.json'),'utf8'),raw);assert.equal(store.migrateEnergyParsing(),0);
});
