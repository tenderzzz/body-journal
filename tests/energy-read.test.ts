import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FoodCatalog} from '../electron/core/nutrition';
import {HealthStore} from '../electron/core/store';
import {addDays} from '../src/shared/energy';
const date='2026-10-22',now=new Date(date+'T20:00:00+08:00'),zone='Asia/Shanghai';
function fixture(t:test.TestContext){
  const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-energy-read-')),s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return s;
}
const profile={effectiveDate:'2026-09-01',age:30,heightCm:175,sex:'male',activity:'seated',strengthMinutes:{low:40,high:60},strengthPerWeek:3,runMinutes:30,runPerWeek:1,runPace:360,generalAdult:true};
test('views, reviews, step chat and history each read records once, invalidation shares range hashes and notices edits',t=>{
  const s=fixture(t),e=s.energy;
  e.saveProfile(profile,now);
  const weight=s.importEnvelope({version:1,id:'synthetic-weight',kind:'body',occurredAt:'2026-09-10T14:00:00+08:00',timezone:zone,text:'历史测量',body:{weightKg:75}}).record;
  s.importEnvelope({version:1,id:'synthetic-early',kind:'meal',occurredAt:date+'T03:59:59+08:00',timezone:zone,text:'上一手记日的加餐'}).record;
  const step=s.importEnvelope({version:1,id:'synthetic-steps',kind:'note',occurredAt:date+'T03:59:59+08:00',timezone:zone,text:'步数记录'}).record;
  s.applyAnalysis(step.id,{summary:'自然日步数',dailyActivity:{steps:900,scope:'all',coverage:'partial'}},'local',step.revision);
  const records=s.records.bind(s);let reads=0;
  s.records=(...args)=>{reads++;return records(...args);};
  for(const days of [7,30]){
    reads=0;const v=e.view({days},now);assert.equal(reads,1);
    assert.equal(v.days.length,days);assert.equal(v.stepReports?.[0]?.id,step.id);assert.equal(v.selected.weight?.id,weight.id);
    assert.equal(v.selected.intake.meals,0);
    assert.equal(v.days.at(-2)?.intake.meals,1);
  }
  for(const run of [()=>e.review(now),()=>e.trendWeeks(date),()=>e.chatContext('今天能量怎么样',now),()=>s.context('今天步数和热量','chat',now),()=>s.context('昨天的热量和步数','chat',now)]){
    reads=0;run();assert.equal(reads,1);
  }
  const from=addDays(date,-20),hash=e.hash(from,date);
  for(let i=0;i<3;i++)s.putMessage({id:'synthetic-message-'+i,role:'assistant',provider:'local',status:'complete',text:'合成回答',sources:[],createdAt:now.toISOString(),stale:false,energyDependency:{from,to:date,hash}});
  reads=0;e.invalidate();assert.equal(reads,1);assert.ok(s.messages().every(m=>!m.stale));
  s.setRecordDeleted(weight.id,true);
  assert.notEqual(e.hash(from,date),hash);assert.ok(s.messages().every(m=>m.stale));assert.equal(e.day(date).weight,undefined);
});
test('overlapping 28-day windows reuse each unanchored sample and keep the original ordering of evidence',t=>{
  const s=fixture(t),e=s.energy;
  const legacy={...profile,id:'legacy-profile',createdAt:now.toISOString()};
  s.db.prepare('INSERT INTO energy_profiles VALUES(?,?)').run(legacy.id,JSON.stringify(legacy));
  for(let i=1;i<=12;i++)e.saveDay({date:addDays(date,-i),steps:4000+i*100,stepsScope:'nonTraining',stepCoverage:'full',mealComplete:false,activityComplete:true},now);
  const read=e.read(),first=e.day(date,read);
  assert.equal(read.samples.size,12);
  assert.equal(e.day(date,read),first);
  e.day(addDays(date,-1),read);e.trendWeeks(date,read);assert.equal(read.samples.size,12);
  const rolling=e.view({date},now);assert.equal(rolling.suggestedUsualSteps,4650);
  e.saveDay({date:addDays(date,-6),steps:8000,stepsScope:'nonTraining',stepCoverage:'full',mealComplete:false,activityComplete:true},now);
  assert.equal(e.view({date},now).suggestedUsualSteps,4750);
});
test('dashboard reads the archive once without loading review and keeps journal and civil dates separate',t=>{
  const s=fixture(t),e=s.energy;
  e.saveProfile({...profile,strengthPerWeek:4},now);
  const add=(id:string,kind:'body'|'training',day:string,text:string,kg?:number)=>s.importEnvelope({version:1,id:'synthetic-'+id,kind,occurredAt:day+'T12:00:00+08:00',timezone:zone,dateLocked:true,text,body:kg?{weightKg:kg}:undefined});
  add('weight-one','body',date,'测量',70);add('weight-two','body',date,'测量',72);
  add('weight-old','body',addDays(date,-28),'四周前',73);
  add('chest','training',addDays(date,-2),'胸日\n杠铃卧推 45kg 3×8');
  add('plan','training',date,'训练计划\n背日\n高位下拉 40kg 3×8');
  const overnight=new Date('2026-10-23T02:00:00+08:00');
  e.saveDay({date:'2026-10-23',steps:0,stepsScope:'all',stepCoverage:'partial',mealComplete:false,activityComplete:false},overnight);
  const records=s.records.bind(s);let reads=0;s.records=()=>{reads++;return records();};
  e.review=()=>{throw Error('expanded review loaded on dashboard');};
  e.trendWeeks=()=>{throw Error('expanded trend loaded on dashboard');};
  const v=e.overview(overnight);
  assert.equal(reads,1);assert.equal(v.date,date);assert.equal(v.stepDate,'2026-10-23');
  assert.equal(v.days.length,7);assert.equal(v.days[0].date,'2026-10-16');
  assert.equal(v.balance,null);assert.ok(v.days.at(-1)?.expenditure);
  assert.equal(v.days.at(-1)?.intake,null);
  assert.equal(v.steps.at(-1)?.count,0);assert.equal(v.steps.at(-1)?.coverage,'partial');assert.equal(v.steps.at(-2)?.count,null);
});

test('quick step entry derives readiness and clears obsolete distance without approving pending meal estimates',t=>{
  const s=fixture(t),e=s.energy;e.saveProfile(profile,now);
  const meal=s.importEnvelope({version:1,id:'synthetic-meal-confirmation',kind:'meal',occurredAt:date+'T12:00:00+08:00',timezone:zone,text:'午餐'}).record;
  e.saveDay({date,walkingKm:3,steps:4000,mealComplete:true,activityComplete:true},now);
  const saved=e.saveSteps({date,timezone:zone,steps:6200,coverage:'full'},now);
  assert.equal(saved.walkingKm,undefined);assert.equal(saved.stepSourceId,undefined);
  assert.equal(saved.mealComplete,false);assert.equal(saved.activityComplete,true);
  s.revise(meal.id,{text:'午餐补充'},meal.revision);
  const revised=e.saveSteps({date,timezone:zone,steps:6500,coverage:'partial'},now);
  assert.equal(revised.mealComplete,false);assert.equal(revised.activityComplete,true);
  assert.equal(e.overview(now).steps.at(-1)?.count,6500);
  assert.equal(e.overview(now).steps.at(-1)?.coverage,'partial');
  assert.throws(()=>e.saveSteps({date,timezone:'UTC',steps:1,coverage:'full'},now),/时区/);
  for(const steps of [-1,1.5,100001])assert.throws(()=>e.saveSteps({date,timezone:zone,steps,coverage:'full'},now));
  assert.throws(()=>e.saveSteps({date:'2026-10-23',timezone:zone,steps:1,coverage:'full'},now),/日期/);
});

test('overview selects any valid historical journal day and preserves current civil steps with a single archive read',t=>{
  const s=fixture(t),e=s.energy;e.saveProfile(profile,now);
  const records=s.records.bind(s);let reads=0;s.records=()=>{reads++;return records();};
  const past=e.overview(now,'2026-10-01');assert.equal(reads,1);
  assert.equal(past.date,'2026-10-01');assert.equal(past.today,date);assert.equal(past.stepDate,date);
  assert.equal(past.days[0].date,'2026-09-25');assert.equal(past.days.at(-1)?.date,'2026-10-01');
  assert.throws(()=>e.overview(now,'2026-02-30'));assert.throws(()=>e.overview(now,'2026-10-23'),/手记日期/);
  const overnight=new Date('2026-10-23T02:00:00+08:00');
  const todaySteps=e.saveSteps({date:'2026-10-23',timezone:zone,steps:0},overnight);
  assert.equal(todaySteps.stepCoverage,'partial');assert.equal(todaySteps.activityComplete,false);
  const history=e.saveSteps({date:'2026-10-21',timezone:zone,steps:6500},overnight);
  assert.equal(history.stepCoverage,'full');assert.equal(e.overview(overnight).steps.at(-1)?.count,0);
  assert.throws(()=>e.overview(overnight,'2026-10-23'),/手记日期/);
});
