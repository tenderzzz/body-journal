import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseTraining} from '../electron/core/parser';
import {estimateDay,refs} from '../src/shared/energy';
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
