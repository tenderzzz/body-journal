import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
const date='2026-10-28',now=new Date(date+'T22:00:00+08:00');
const profile={effectiveDate:'2026-09-01',age:30,heightCm:180,sex:'male',activity:'seated',strideCm:72,strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:30,runPerWeek:2,runPace:360,generalAdult:true};
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-adaptive-'));const s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});s.energy.saveProfile(profile,now);s.importEnvelope({version:1,id:'adaptive-weight',kind:'body',occurredAt:'2026-09-01T08:00:00+08:00',timezone:'Asia/Shanghai',text:'合成体重',body:{weightKg:80}});return s;}
function save(s:HealthStore,steps:number,day=date){s.energy.saveDay({date:day,steps,stepsScope:'all',stepCoverage:'full',mealComplete:false,activityComplete:true},now);return s.energy.day(day);}
function run(s:HealthStore,id:string,data:Record<string,unknown>,day=date){let r=s.importEnvelope({version:1,id,kind:'training',occurredAt:day+'T18:00:00+08:00',timezone:'Asia/Shanghai',text:'跑步已完成'}).record;return s.applyAnalysis(r.id,{summary:'合成跑步',questions:[],assumptions:[],run:{km:5,minutes:30,completion:'completed',...data}},'local',r.revision);}
test('without a manual reference, steps continuously adjust the daily baseline and preserve confirmation',t=>{
 const s=setup(t),low=save(s,2000),high=save(s,12000),next=save(s,12001);
 assert.ok(high.expenditure!.low>low.expenditure!.low);
 assert.ok(Math.abs(high.expenditure!.low-low.expenditure!.low-288)<1e-7);
 assert.ok(Math.abs(next.expenditure!.low-high.expenditure!.low-.0288)<1e-7);
 assert.equal(high.walking?.reference?.method,'assumed');
 assert.equal(high.activityConfirmed,true);assert.equal(high.activityComplete,true);
 assert.deepEqual(high.dailyBaseline,high.expenditure);
 assert.equal(s.energy.profiles()[0].usualSteps,undefined);
});
test('cadence uses moving time, exposes its source, and never deducts an excluded or planned run',t=>{
 const s=setup(t),r=run(s,'cadence-run',{minutes:20,elapsedMinutes:30,cadence:170,totalKcal:350});
 run(s,'planned-run',{completion:'planned',steps:3000});
 const d=save(s,10000);
 assert.equal(d.walking?.nonTrainingSteps,6600);
 assert.deepEqual(d.walking?.deductions,[{recordId:r.id,revision:r.revision,steps:3400,method:'cadence',cadence:170,minutes:20}]);
 assert.equal(d.workouts.length,1);
 assert.equal(d.workouts[0].method,'app-total');
 assert.ok(Math.abs(d.expenditure!.low-d.dailyBaseline!.low-d.workouts[0].extra.low)<1e-7);
 s.energy.saveDay({date,steps:6600,stepsScope:'nonTraining',mealComplete:false,activityComplete:true},now);
 assert.deepEqual(s.energy.day(date).walking?.deductions,[]);
});
test('reported running steps win; conflicting moving time cannot be used for cadence deduction',t=>{
 const s=setup(t),r=run(s,'reported-run',{cadence:170,steps:4000});
 assert.equal(save(s,10000).walking?.deductions?.[0].method,'reported');
 s.updateActivity({id:r.id,revision:r.revision,run:{steps:null,paceSecondsPerKm:240}});
 const d=save(s,10000);assert.equal(d.walking?.pending,'overlap');assert.equal(d.walking?.correction,null);
 assert.equal(d.activityComplete,false);
});
test('seven preceding confirmed days suggest a reference, explicit profile save fixes it, and history edits invalidate answers',t=>{
 const s=setup(t);let sourceId='';
 for(let i=0;i<7;i++){
  const day=`2026-10-${20+i}`;
  if(i===3){const r=s.importEnvelope({version:1,id:'historical-steps',kind:'note',occurredAt:day+'T21:00:00+08:00',timezone:'Asia/Shanghai',text:'全天步数 4000步'}).record;sourceId=r.id;s.energy.saveDay({date:day,mealComplete:false,activityComplete:true},now);}
  else save(s,[1000,2000,3000,4000,5000,6000,10000][i],day);
 }
 assert.equal(s.energy.view({date},now).suggestedUsualSteps,4000);
 assert.equal(save(s,12000).walking?.reference?.method,'assumed');
 s.energy.saveProfile({...profile,effectiveDate:date},now);
 const d=s.energy.day(date);assert.equal(d.walking?.reference?.method,'history');assert.equal(d.walking?.referenceSteps,4000);
 assert.equal(d.walking?.reference?.dates.length,7);assert.ok(d.sources.some(r=>r.id===sourceId));
 assert.equal(s.energy.day('2026-10-26').walking?.reference?.method,'assumed');
 const dependency={from:date,to:date,hash:s.energy.hash(date,date)};
 s.putMessage({id:'history-answer',role:'assistant',text:'合成回答',createdAt:now.toISOString(),status:'complete',sources:[],provider:'local',stale:false,energyDependency:dependency});
 s.updateActivity({id:sourceId,revision:s.record(sourceId).revision,dailyActivity:{steps:4500}});
 assert.equal(s.energy.day(date).walking?.referenceSteps,4000);
 assert.match(s.energy.day(date).assumptions.join(' '),/来源已有修订/);
 assert.equal(s.messages().find(m=>m.id==='history-answer')?.stale,true);
 s.energy.saveDay({date:'2026-10-23',mealComplete:false,activityComplete:true},now);
 assert.equal(s.energy.day(date).walking?.referenceSteps,4000);
 assert.equal(s.energy.view({date},now).suggestedUsualSteps,4500);
 s.energy.saveProfile({...profile,effectiveDate:date,usualSteps:7000},now);
 assert.equal(s.energy.day(date).walking?.reference?.method,'manual');assert.equal(s.energy.day(date).walking?.referenceSteps,7000);
});
