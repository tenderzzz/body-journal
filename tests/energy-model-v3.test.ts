import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateDay,refs,runningMET} from '../src/shared/energy';
import type {DailyEnergyInput,EnergyProfile,HealthRecord,RunEntry,DailyActivity} from '../src/shared/types';
const date='2026-10-28',zone='Asia/Shanghai',stamp=date+'T08:00:00+08:00';
const profile:EnergyProfile={id:'profile',createdAt:stamp,effectiveDate:date,age:30,heightCm:180,sex:'male',activity:'seated',strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:20,runPerWeek:1,runPace:360,generalAdult:true,usualSteps:5000,strideCm:72};
const record=(id:string,patch:Partial<HealthRecord>={}):HealthRecord=>({id,kind:'note',occurredAt:stamp,timezone:zone,text:'',attachments:[],body:null,analysis:null,status:'ready',revision:1,createdAt:stamp,updatedAt:stamp,deleted:false,source:'synthetic test',...patch});
const body=record('weight',{kind:'body',body:{weightKg:80}});
const run=(id='run',data:RunEntry={km:5,minutes:30},patch:Partial<HealthRecord>={})=>record(id,{kind:'training',text:'跑步已完成',analysis:{summary:'跑步实际结果',questions:[],assumptions:[],engine:'local',at:stamp,run:{completion:'completed',...data}},...patch});
const report=(id:string,dailyActivity:DailyActivity,patch:Partial<HealthRecord>={})=>record(id,{analysis:{summary:'全天活动',questions:[],assumptions:[],engine:'local',at:stamp,dailyActivity},...patch});
function estimate(extra:HealthRecord[]=[],input:Partial<DailyEnergyInput>={},p:EnergyProfile=profile){const records=[body,...extra];const activityRecords=extra.filter(r=>r.kind==='training'||r.analysis?.run||r.analysis?.sets?.length||r.analysis?.training?.durationMinutes||r.analysis?.dailyActivity);return estimateDay(date,zone,records,p,{date,timezone:zone,mealComplete:false,activityComplete:true,mealSources:[],activitySources:refs(activityRecords),updatedAt:stamp,...input},null);}
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);

test('actual steps change expenditure relative to confirmed usual steps, with signed corrections',()=>{
 const low=estimate([],{steps:2000,stepsScope:'nonTraining'}),high=estimate([],{steps:12000,stepsScope:'nonTraining'}),usual=estimate([],{steps:5000,stepsScope:'nonTraining'});
 close(low.walking!.correction!.low,-86.4);close(high.walking!.correction!.high,201.6);
 close(usual.walking!.correction!.low,0);close(high.expenditure!.low-low.expenditure!.low,288);
 const uncertain=estimate([],{steps:2000,stepsScope:'nonTraining'},{...profile,strideCm:undefined});
 assert.ok(uncertain.walking!.correction!.low<uncertain.walking!.correction!.high);
});
test('missing usual steps uses an explicit assumed reference and still extracts nontraining steps',()=>{
 const day=estimate([],{steps:12000},{...profile,usualSteps:undefined});
 assert.ok(day.expenditure!.low>day.baseline!.low);assert.equal(day.walking!.nonTrainingSteps,12000);assert.equal(day.walking!.reference?.method,'assumed');
 assert.match(day.assumptions.join(' '),/参考步数范围/);assert.equal(day.activityComplete,true);
});
test('reported running steps and cadence deduct overlap exactly once',()=>{
 const a=estimate([run('run',{km:5,minutes:30,steps:5000})],{steps:10000});
 const b=estimate([run('run',{km:5,minutes:30,cadence:5000/30})],{steps:10000});
 assert.equal(a.walking!.nonTrainingSteps,5000);assert.equal(b.walking!.nonTrainingSteps,5000);close(a.walking!.correction!.low,0);
 const unknown=estimate([run()],{steps:10000});assert.equal(unknown.walking!.correction,null);assert.equal(unknown.activityComplete,true);
 const separate=estimate([run()],{steps:10000,stepsScope:'nonTraining'});assert.equal(separate.walking!.nonTrainingSteps,10000);
});
test('elapsed time alone never turns cadence into allegedly known running steps',()=>{
 const day=estimate([run('run',{elapsedMinutes:30,cadence:170,activeKcal:300})],{steps:10000});
 assert.equal(day.walking!.correction,null);assert.equal(day.workouts[0].method,'app-active');
});
test('active and total App calories subtract different overlapping baseline amounts',()=>{
 const active=estimate([run('run',{minutes:30,activeKcal:300,sourceApp:'App'})]);
 const total=estimate([run('run',{minutes:30,totalKcal:300+active.resting!*30/1440,sourceApp:'App'})]);
 close(active.workouts[0].extra.low,total.workouts[0].extra.low);
 close(active.workouts[0].extra.high,total.workouts[0].extra.high);
 assert.equal(active.workouts[0].method,'app-active');assert.equal(total.workouts[0].method,'app-total');
 const withBoth=estimate([run('run',{minutes:30,km:5,activeKcal:300,totalKcal:350})]);
 close(withBoth.workouts[0].extra.low,active.workouts[0].extra.low);assert.equal(withBoth.workouts.length,1);
});
test('unlabelled App calories remain a note while formula fallback provides the estimate',()=>{
 const raw=estimate([run('run',{km:5,minutes:30,reportedKcal:1000,calorieLabel:'消耗'})]);
 const fallback=estimate([run()]);assert.deepEqual(raw.expenditure,fallback.expenditure);assert.equal(raw.workouts[0].method,'met');assert.match(raw.assumptions.join(' '),/口径待核对/);
});
test('inconsistent run numbers are not silently corrected and plans do not contribute',()=>{
 const conflict=estimate([run('run',{km:5,minutes:30,paceSecondsPerKm:240,activeKcal:300})]);
 assert.equal(conflict.workouts.length,0);assert.equal(conflict.activityComplete,false);assert.match(conflict.missing.join(' '),/5%/);
 const planned=estimate([run('run',{km:5,minutes:30,activeKcal:300,completion:'planned'})]);assert.equal(planned.workouts.length,0);
});
test('same attachment with matching run metrics counts once; suspected duplicate needs an exclusion',()=>{
 const attachment={name:'run.png',mime:'image/png',sha256:'a'.repeat(64),file:'run.png'};
 const a=run('a',{km:5,minutes:30,steps:5000},{attachments:[attachment]}),b=run('b',{km:5,minutes:30,steps:5000},{attachments:[attachment]});
 const exact=estimate([a,b],{steps:10000});assert.equal(exact.workouts.length,1);assert.equal(exact.duplicates[0].exact,true);assert.equal(exact.walking!.nonTrainingSteps,5000);assert.equal(exact.activityComplete,true);
 const different={...b,attachments:[{...attachment,sha256:'b'.repeat(64)}]};
 const suspect=estimate([a,different],{steps:10000});assert.equal(suspect.workouts.length,1);assert.equal(suspect.activityComplete,false);assert.equal(suspect.walking!.correction,null);
 const resolved=estimate([a,different],{steps:10000,excludedWorkoutIds:['b']});assert.equal(resolved.activityComplete,true);assert.equal(resolved.duplicates.length,0);
});
test('latest complete report per source replaces cumulative screenshots and partial reports stay partial',()=>{
 const early=report('early',{steps:8000,scope:'nonTraining',coverage:'full',sourceApp:'phone'});
 const late=report('late',{steps:10000,scope:'nonTraining',coverage:'full',sourceApp:'phone'},{occurredAt:date+'T22:00:00+08:00'});
 const partial=report('partial',{steps:12000,scope:'nonTraining',coverage:'partial',asOf:'12:00',sourceApp:'phone'},{occurredAt:date+'T23:00:00+08:00'});
 const day=estimate([early,late,partial]);assert.equal(day.walking!.steps,10000);assert.equal(day.walking!.source!.id,'late');
 const onlyPartial=estimate([partial]);assert.equal(onlyPartial.walking!.correction,null);assert.equal(onlyPartial.activityComplete,false);assert.match(onlyPartial.walking!.basis,/12:00/);
});
test('manual values and explicit source selection resolve conflicts; changed and deleted source invalidates confirmation',()=>{
 const a=report('a',{steps:8000,scope:'nonTraining',coverage:'full',sourceApp:'phone'}),b=report('b',{steps:12000,scope:'nonTraining',coverage:'full',sourceApp:'other'});
 const conflict=estimate([a,b]);assert.equal(conflict.walking,null);assert.equal(conflict.activityComplete,false);
 const selected=estimate([a,b],{stepSourceId:'b'});assert.equal(selected.walking!.steps,12000);
 const manual=estimate([a,b],{steps:9000,stepsScope:'nonTraining'});assert.equal(manual.walking!.steps,9000);assert.equal(manual.walking!.source,undefined);
 const oldRefs=refs([a]);const changed=estimate([{...a,revision:2}],{activitySources:oldRefs});assert.equal(changed.activityComplete,false);
 const deleted=estimate([{...a,deleted:true}],{activitySources:oldRefs});assert.equal(deleted.walking,null);assert.equal(deleted.activityComplete,false);
});
test('reported nontraining distance is used before height-derived step distance',()=>{
 const day=estimate([],{steps:10000,stepsScope:'nonTraining',walkingKm:4});
 close(day.walking!.distanceKm!.low,4);close(day.walking!.correction!.low,16);
});
test('MET interpolation is continuous across previous nearest-row boundaries',()=>{
 const boundary=(6.15+6.7)/2,pace=3600/(boundary*1.609344);
 const a=runningMET(pace-.001)!,b=runningMET(pace+.001)!;
 assert.ok(Math.abs(a.low-b.low)<.001);assert.equal(runningMET(100),null);
});
test('strength duration corrections override stale original text and clearing returns to usual duration',()=>{
 const a=record('strength',{kind:'training',text:'卧推50kg 3x8，力量训练60分钟',analysis:{summary:'已完成',engine:'local',at:stamp,questions:[],assumptions:[],sets:[{exercise:'卧推',kg:50,reps:8,sets:3,loadBasis:'total',confirmed:true}],training:{part:'chest',completion:'completed',durationMinutes:45},activityOverrides:{training:{durationMinutes:45}}}});
 const corrected=estimate([a]);assert.deepEqual(corrected.workouts[0].minutes,{low:45,high:45});
 a.analysis!.activityOverrides={cleared:['training.durationMinutes']};a.analysis!.training!.durationMinutes=undefined;
 const cleared=estimate([a]);assert.deepEqual(cleared.workouts[0].minutes,profile.strengthMinutes);assert.equal(cleared.workouts[0].assumed,true);
});

test('activity screenshots saved as notes retain completed run data and activity references',()=>{
 const screenshot=run('note',{minutes:30,activeKcal:300},{kind:'note'});
 const day=estimate([screenshot]);assert.equal(day.workouts.length,1);assert.equal(day.activityComplete,true);assert.equal(day.workouts[0].method,'app-active');
});

test('reanalysis of an older cumulative report does not replace a newer snapshot',()=>{
 const older=report('older',{steps:8000,scope:'nonTraining',coverage:'full',sourceApp:'phone'},{occurredAt:date+'T10:00:00+08:00',updatedAt:date+'T23:00:00+08:00'});
 const newer=report('newer',{steps:12000,scope:'nonTraining',coverage:'full',sourceApp:'phone'},{occurredAt:date+'T22:00:00+08:00',updatedAt:date+'T22:00:00+08:00'});
 assert.equal(estimate([older,newer]).walking!.source!.id,'newer');
});
test('two distinct explicit workout IDs do not become suspected duplicates',()=>{
 const a=run('a',{km:5,minutes:30,sourceApp:'phone',sourceId:'first'}),b=run('b',{km:5,minutes:30,sourceApp:'phone',sourceId:'second'});
 const day=estimate([a,b]);assert.equal(day.workouts.length,2);assert.equal(day.duplicates.length,0);
});
test('identical strength-only screenshots are counted once',()=>{
 const attachment={name:'strength.png',mime:'image/png',sha256:'c'.repeat(64),file:'strength.png'};
 const a=record('a',{kind:'training',text:'卧推 50kg 3x8，力量训练60分钟',attachments:[attachment],analysis:{summary:'已完成',engine:'local',at:stamp,questions:[],assumptions:[],sets:[{exercise:'卧推',kg:50,reps:8,sets:3,loadBasis:'total',confirmed:true}],training:{part:'chest',completion:'completed',durationMinutes:60}}});
 const day=estimate([a,{...a,id:'b'}]);assert.equal(day.workouts.length,1);assert.equal(day.duplicates[0].exact,true);
});

test('manual nontraining distance works alongside total steps without requiring an overlap estimate',()=>{
 const day=estimate([run()],{steps:10000,stepsScope:'all',walkingKm:4});
 close(day.walking!.distanceKm!.low,4);close(day.walking!.correction!.low,16);assert.equal(day.walking!.nonTrainingSteps,undefined);assert.equal(day.activityComplete,true);
});
test('activity reports with an unconfirmed occurrence date do not permit a complete day',()=>{
 const uncertain=report('uncertain',{steps:10000,scope:'nonTraining',coverage:'full'},{timeSource:'file_modified'});
 const day=estimate([uncertain]);assert.equal(day.activityComplete,false);assert.equal(day.walking,null);assert.match(day.missing.join(' '),/活动汇总发生日期/);
});

test('App kcal use moving-to-elapsed interval for overlap while cadence uses moving time',()=>{
 const day=estimate([run('run',{km:5,minutes:20,elapsedMinutes:30,totalKcal:350,cadence:170})],{steps:8400});
 assert.equal(day.walking!.nonTrainingSteps,5000);assert.deepEqual(day.workouts[0].minutes,{low:20,high:30});
 close(day.workouts[0].extra.low,350-day.baseline!.high*30/1440);close(day.workouts[0].extra.high,350-day.baseline!.low*20/1440);assert.match(day.workouts[0].basis,/覆盖时长未明/);
 const active=estimate([run('run',{km:5,minutes:20,elapsedMinutes:30,activeKcal:300})]);
 close(active.workouts[0].extra.low,300-(active.baseline!.high-active.resting!)*30/1440);
 close(active.workouts[0].extra.high,300-(active.baseline!.low-active.resting!)*20/1440);
});

test('distance and pace derive moving time before total time is used as a fallback',()=>{
 const day=estimate([run('run',{km:5,paceSecondsPerKm:240,elapsedMinutes:30,totalKcal:350})]);
 assert.deepEqual(day.workouts[0].minutes,{low:20,high:30});
 close(day.workouts[0].extra.high,350-day.baseline!.low*20/1440);
});

test('exact screenshot duplicates prefer the record with manual energy corrections',()=>{
 const attachment={name:'same.png',mime:'image/png',sha256:'d'.repeat(64),file:'same.png'};
 const first=run('first',{km:5,minutes:30,activeKcal:300},{attachments:[attachment]});
 const corrected=run('second',{km:5,minutes:30,activeKcal:400},{attachments:[attachment]});
 corrected.analysis!.activityOverrides={run:{activeKcal:400}};
 const day=estimate([first,corrected]);
 assert.equal(day.workouts.length,1);assert.equal(day.workouts[0].recordId,'second');assert.match(day.workouts[0].basis,/400 kcal/);
});
test('unconfirmed daily summaries are kept out of a complete day',()=>{
 const pending=report('pending',{steps:12000,scope:'nonTraining',coverage:'full'},{status:'needs_info'});
 const day=estimate([pending]);assert.equal(day.walking,null);assert.equal(day.activityComplete,false);assert.match(day.missing.join(' '),/尚待分析或核对/);
 assert.doesNotMatch(day.missing.join(' '),/疑似重复/);
});

test('two genuinely separate matching runs can be confirmed without excluding either',()=>{
 const a=run('a',{km:5,minutes:30,steps:5000}),b=run('b',{km:5,minutes:30,steps:5000});
 const day=estimate([a,b],{steps:15000,distinctWorkoutPairs:[['a','b']]});
 assert.equal(day.duplicates.length,0);assert.equal(day.workouts.length,2);assert.equal(day.walking?.nonTrainingSteps,5000);assert.equal(day.activityComplete,true);
});
test('matching strength screenshots can be excluded or confirmed as different sessions',()=>{
 const attachment={name:'strength.png',mime:'image/png',sha256:'e'.repeat(64),file:'strength.png'};
 const a=record('a',{kind:'training',text:'卧推 50kg 3x8，力量训练60分钟',attachments:[attachment],analysis:{summary:'已完成',engine:'local',at:stamp,questions:[],assumptions:[],sets:[{exercise:'卧推',kg:50,reps:8,sets:3,loadBasis:'total',confirmed:true}],training:{part:'chest',completion:'completed',durationMinutes:60}}});
 const b={...a,id:'b',attachments:[{...attachment,sha256:'f'.repeat(64)}]};
 const suspect=estimate([a,b]);assert.equal(suspect.workouts.length,1);assert.equal(suspect.duplicates[0].exact,false);assert.equal(suspect.activityComplete,false);
 const different=estimate([a,b],{distinctWorkoutPairs:[['a','b']]});assert.equal(different.workouts.length,2);assert.equal(different.activityComplete,true);
});

test('a completed strength screenshot can use actual duration without inventing sets',()=>{
 const strength=record('strength-photo',{kind:'note',text:'无补充',analysis:{summary:'已完成力量训练',engine:'deepseek',at:stamp,questions:[],assumptions:[],training:{part:'unknown',completion:'completed',durationMinutes:42.5}}});
 const day=estimate([strength]);assert.equal(day.workouts.length,1);assert.equal(day.workouts[0].kind,'strength');assert.equal(day.workouts[0].minutes.low,42.5);assert.equal(day.activityComplete,true);
 const cancelled=estimate([{...strength,text:'本次没有完成力量训练'}]);assert.equal(cancelled.workouts.length,0);assert.equal(cancelled.activityComplete,false);
});

test('conflicting unnamed sources are not silently assumed to be one App',()=>{
 const first=report('first',{steps:8000,scope:'nonTraining',coverage:'full'});
 const second=report('second',{steps:12000,scope:'nonTraining',coverage:'full'},{occurredAt:date+'T22:00:00+08:00'});
 const day=estimate([first,second]);assert.equal(day.walking,null);assert.equal(day.activityComplete,false);assert.match(day.missing.join(' '),/来源或数值有冲突/);
 assert.equal(estimate([first,second],{stepSourceId:'second'}).walking?.steps,12000);
});
