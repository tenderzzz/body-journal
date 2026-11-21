import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseTraining} from '../electron/core/parser';
import {estimateDay,refs} from '../src/shared/energy';
import {computeStats,needsAnalysis} from '../src/shared/stats';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import type {HealthRecord,EnergyProfile,DailyEnergyInput} from '../src/shared/types';

const date='2026-10-15',stamp=date+'T18:00:00+08:00',zone='Asia/Shanghai';
const profile:EnergyProfile={id:'synthetic-profile',createdAt:stamp,effectiveDate:date,age:30,heightCm:180,sex:'male',activity:'seated',strengthMinutes:{low:45,high:60},strengthPerWeek:3,runMinutes:30,runPerWeek:1,runPace:360,generalAdult:true,usualSteps:3000};
function entry(id:string,patch:Partial<HealthRecord>):HealthRecord{return {id,kind:'training',occurredAt:stamp,timezone:zone,text:'',attachments:[],body:null,analysis:null,status:'ready',revision:1,createdAt:stamp,updatedAt:stamp,deleted:false,source:'synthetic',...patch};}
function estimate(record:HealthRecord,input:Partial<DailyEnergyInput>={}){
 const weight=entry('synthetic-weight',{kind:'body',body:{weightKg:80},occurredAt:date+'T08:00:00+08:00'});
 return estimateDay(date,zone,[weight,record],profile,{date,timezone:zone,steps:9000,stepsScope:'all',stepCoverage:'full',mealComplete:false,activityComplete:true,mealSources:[],activitySources:refs([record]),updatedAt:stamp,...input},null);
}
function incline(){return entry('synthetic-cardio',{text:'跑步机爬坡 坡度12% 1.8km 24min',analysis:{summary:'合成有氧结果',questions:[],assumptions:[],run:{km:1.8,minutes:24,terrain:'hilly',completion:'completed'},engine:'local',at:stamp}});}

test('incline treadmill input is locally retained as cardio with separate strength and grade units',()=>{
 const a=parseTraining('腿：\n跑步机爬坡 坡度12% 1.8km 24min\n深蹲 50kg 3x8')!;
 assert.equal(a.run!.activity,'incline');assert.equal(a.run!.inclinePercent,12);assert.equal(a.run!.inclineSource,'reported');
 assert.equal(a.training!.durationMinutes,undefined);assert.equal(a.sets![0].sets,3);
 const assumed=parseTraining('跑步机爬坡 坡度12 1.8km 24min')!;assert.equal(assumed.run!.inclineSource,'assumed');
 const degrees=parseTraining('跑步机爬坡 坡度10度 1.8km 24min')!;assert.ok(Math.abs(degrees.run!.inclinePercent!-17.6327)<.001);
 assert.equal(parseTraining('非训练步行距离2km')?.run,undefined);
 const planned=parseTraining('计划爬坡步行1.8km 24min')!;assert.equal(planned.run!.completion,'planned');
});
test('incline expenditure uses speed and grade and its step interval reaches the residual walking correction',()=>{
 const result=estimate(incline()),cardio=result.workouts.find(w=>w.kind==='run')!;
 assert.ok(cardio);assert.match(cardio.basis,/ACSM|爬坡/);assert.equal(cardio.method,'acsm-walking');
 const gross=(3.5+.1*75+1.8*75*.12)*80/200*24;
 assert.ok(Math.abs(cardio.extra.low-(gross-result.baseline!.high*24/1440))<1e-8);
 const walking=result.walking!,deduction=walking.deductions![0];
 assert.equal(deduction.method,'distance');assert.ok(deduction.range!.low<deduction.range!.high);
 assert.ok(walking.nonTrainingStepRange!.low<walking.nonTrainingStepRange!.high);assert.equal(walking.pending,undefined);
 const low=(9000-3000)*(.35*180/100)/1000-1.8;
 const high=(9000-3000)*(.45*180/100)/1000-1.8;
 assert.ok(Math.abs(walking.correction!.low-.5*80*low)<1e-8);assert.ok(Math.abs(walking.correction!.high-.5*80*high)<1e-8);
});
test('reported steps and cadence take precedence, and excluding treadmill steps leaves the full daily count',()=>{
 const r=incline();r.analysis!.run={...r.analysis!.run,steps:2400};let result=estimate(r);assert.equal(result.walking!.nonTrainingSteps,6600);assert.equal(result.walking!.deductions![0].method,'reported');
 r.analysis!.run={...r.analysis!.run,steps:undefined,cadence:100};result=estimate(r);assert.equal(result.walking!.nonTrainingSteps,6600);assert.equal(result.walking!.deductions![0].method,'cadence');
 r.analysis!.run!.stepsIncluded=false;result=estimate(r);assert.equal(result.walking!.nonTrainingSteps,9000);assert.equal(result.walking!.deductions!.length,0);assert.ok(result.workouts.length);
});
test('unknown uphill grade, partial totals and cross-midnight cardio retain pending evidence',()=>{
 const r=incline();r.text='户外爬坡步行1.8km 24min';const unknown=estimate(r);assert.ok(unknown.missing.some(m=>/坡度/.test(m)));assert.ok(!unknown.workouts.length);
 assert.equal(estimate(incline(),{stepCoverage:'partial'}).walking!.pending,'partial');
 const cross=incline();cross.occurredAt=date+'T23:55:00+08:00';assert.equal(estimate(cross).walking!.pending,'overlap');
});
test('migration corrects legacy incline once, preserves raw input and strength, and survives backup and overrides',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-cardio-'));const store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const r=store.importEnvelope({version:1,id:'synthetic-incline',kind:'training',text:'跑步机爬坡 坡度12 1.8km 24min\n卧推 50kg 3x8',occurredAt:stamp,timezone:zone}).record;
 const legacy=JSON.parse(JSON.stringify({...r,analysis:{...r.analysis!,run:{km:1.8,minutes:24,terrain:'hilly',completion:'completed'}}}));
 store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(legacy),r.id);
 assert.equal(store.migrateCardio(),1);const fixed=store.record(r.id);
 assert.equal(fixed.text,r.text);assert.deepEqual(fixed.analysis!.sets,legacy.analysis!.sets);assert.equal(fixed.analysis!.run!.activity,'incline');assert.equal(store.migrateCardio(),0);
 const corrected=store.updateActivity({id:r.id,revision:fixed.revision,run:{inclinePercent:8,stepsIncluded:false}});
 assert.equal(corrected.analysis!.run!.inclinePercent,8);
 const again=store.applyAnalysis(r.id,{...corrected.analysis!,run:{...corrected.analysis!.run!,inclinePercent:12,stepsIncluded:true}},'local',corrected.revision);assert.equal(again.analysis!.run!.inclinePercent,8);assert.equal(again.analysis!.run!.stepsIncluded,false);
 const file=path.join(root,'roundtrip.bodyjournal');store.backup(file);store.restoreFile(file);assert.equal(store.record(r.id).analysis!.run!.stepsIncluded,false);
});

test('swimming logs preserve actual and elapsed time, meters, and completion independently of strength',()=>{
 const swim=parseTraining('游泳一个半小时，轻松，蛙泳')!;
 assert.equal(swim.run!.activity,'swimming');
 assert.equal(swim.run!.swimStroke,'breaststroke');
 assert.equal(swim.run!.elapsedMinutes,90);
 assert.equal(swim.run!.minutes,undefined);
 assert.equal(swim.run!.effort,'轻松');
 assert.equal(swim.run!.completion,'completed');
 assert.equal(swim.training!.durationMinutes,undefined);
 assert.deepEqual(swim.questions,[]);

 const mixed=parseTraining('游泳总时长 1小时20分钟\n实际游动 45 分钟\n自由泳 1,250 米\n卧推 45kg 3x8')!;
 assert.equal(mixed.run!.elapsedMinutes,80);
 assert.equal(mixed.run!.minutes,45);
 assert.equal(mixed.run!.km,1.25);
 assert.equal(mixed.run!.swimStroke,'freestyle');
 assert.equal(mixed.sets![0].sets,3);
 assert.equal(parseTraining('计划：\n游泳90分钟')!.run!.completion,'planned');
 assert.equal(parseTraining('游泳90分钟，后来取消游泳')!.run!.completion,'unknown');
});

test('swimming leaves daily steps intact and uses only explicitly reported device calories',()=>{
 const text='自由泳800米，实际游动30分钟，总时长50分钟',analysis=parseTraining(text)!;
 const record=entry('synthetic-swim',{text,analysis});
 const result=estimate(record);
 assert.equal(result.walking!.nonTrainingSteps,9000);
 assert.deepEqual(result.walking!.deductions,[]);
 assert.equal(result.workouts.length,0);
 assert.ok(result.missing.some(item=>item.includes('游泳已记录')));
 assert.equal(result.activityComplete,false);

 const reported=estimate({...record,analysis:parseTraining(text+'，活动热量 270 kcal')});
 assert.equal(reported.walking!.nonTrainingSteps,9000);
 assert.equal(reported.workouts[0].activity,'swimming');
 assert.equal(reported.workouts[0].method,'app-active');
 assert.deepEqual(reported.workouts[0].minutes,{low:30,high:50});
 assert.equal(reported.workouts[0].comparison?.formula,null);
});

test('old swimming enum failures recover once without a provider and preserve other pending results',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-swim-'));
 const store=new HealthStore(root,new FoodCatalog([]),path.join(root,'inbox'),false);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const failed=(id:string,text:string,error:string)=>{
  const {record}=store.importEnvelope({version:1,id,kind:'training',text,occurredAt:stamp,timezone:zone});
  store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify({...record,analysis:null,status:'pending'}),id);
  store.markAnalysisFailure(id,record.revision,error);
  return store.record(id);
 };
 const schemaError='run.activity: Invalid option: expected one of "running"|"walking"|"incline"';
 const legacy=failed('legacy-swim','游泳八十分钟，强度一般，蛙泳',schemaError);
 const cancelled=failed('cancelled-swim','游泳90分钟，水温太低取消游泳',schemaError);
 const timeout=failed('timeout-swim','自由泳750米，总时长 45 分钟','合成连接超时');
 assert.equal(store.recoverSwimmingAnalyses(),1);
 assert.equal(store.recoverSwimmingAnalyses(),0);
 const recovered=store.record(legacy.id);
 assert.equal(recovered.status,'ready');
 assert.equal(recovered.text,legacy.text);
 assert.equal(recovered.occurredAt,legacy.occurredAt);
 assert.equal(recovered.revision,legacy.revision+1);
 assert.equal(recovered.analysisError,undefined);
 assert.equal(needsAnalysis(recovered),false);
 assert.equal(recovered.analysis?.run?.elapsedMinutes,80);
 assert.equal(computeStats([recovered],zone).runs[0].swimStroke,'breaststroke');
 assert.equal(store.record(cancelled.id).analysisError,schemaError);
 assert.equal(store.record(timeout.id).analysisError,timeout.analysisError);

 const reanalyzed=store.applyAnalysis(timeout.id,{
  summary:'合成泳池记录',questions:[],assumptions:[],
  run:{activity:'Swim',swimStroke:'freestyle',elapsedMinutes:45,km:.75,completion:'completed',paceSecondsPerKm:null,steps:500},
 },'chatgpt',timeout.revision);
 assert.equal(reanalyzed.analysis?.run?.activity,'swimming');
 assert.equal(reanalyzed.analysis?.run?.swimStroke,'freestyle');
 assert.equal(reanalyzed.analysis?.run?.steps,undefined);
 assert.equal(reanalyzed.status,'ready');
 const corrected=store.updateActivity({id:reanalyzed.id,revision:reanalyzed.revision,run:{swimStroke:'backstroke',activeKcal:210}});
 assert.equal(corrected.analysis?.run?.swimStroke,'backstroke');
 assert.equal(corrected.analysis?.run?.activeKcal,210);
 const file=path.join(root,'swim-roundtrip.bodyjournal');
 store.backup(file);
 store.restoreFile(file);
 assert.equal(store.record(legacy.id).analysis?.run?.elapsedMinutes,80);
 assert.equal(store.record(timeout.id).analysis?.run?.swimStroke,'backstroke');
});
