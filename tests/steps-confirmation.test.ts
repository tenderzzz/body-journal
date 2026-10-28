import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
const date='2026-10-27',now=new Date('2026-10-28T08:00:00+08:00');
const profile={effectiveDate:'2026-10-25',age:30,heightCm:180,sex:'male',activity:'walking',strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:30,runPerWeek:2,runPace:360,generalAdult:true};
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-step-confirmation-'));const store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});store.energy.saveProfile(profile,now);store.importEnvelope({version:1,id:randomUUID(),kind:'body',occurredAt:date+'T08:00:00+08:00',timezone:'Asia/Shanghai',text:'合成体重',body:{weightKg:80}});return store;}
function complete(store:HealthStore,changes:Record<string,unknown>={}){store.energy.saveDay({date,steps:6000,stepsScope:'all',stepCoverage:'full',mealComplete:false,activityComplete:true,...changes},now);return store.energy.day(date);}

test('saved activity confirmation survives a missing optional usual-step reference',t=>{
 const store=setup(t);const day=complete(store);
 assert.equal(store.energy.export().days[0].activityComplete,true);
 assert.equal(day.activityComplete,true);
 assert.ok(day.walking?.correction);assert.equal(day.walking?.reference?.method,'assumed');assert.notDeepEqual(day.expenditure,day.baseline);
});
test('a completed run with unknown step overlap preserves confirmation and uses the baseline',t=>{
 const store=setup(t);store.energy.saveProfile({...profile,usualSteps:4000},now);
 store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:date+'T18:00:00+08:00',timezone:'Asia/Shanghai',text:'跑步5km 用时30分钟'});
 const day=complete(store);assert.equal(day.activityComplete,true);assert.equal(day.walking?.correction,null);assert.equal(day.workouts.length,1);
});
test('partial coverage and invalid run data remain unresolved',t=>{
 const store=setup(t);const partial=complete(store,{stepCoverage:'partial'});assert.equal(partial.activityComplete,false);assert.equal(partial.activityConfirmed,true);
 const r=store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:date+'T18:00:00+08:00',timezone:'Asia/Shanghai',text:'跑步5km 用时30分钟'}).record;
 store.applyAnalysis(r.id,{summary:'合成冲突数据',questions:[],assumptions:[],run:{km:5,minutes:30,paceSecondsPerKm:240,completion:'completed'}},'local',r.revision);
 assert.equal(complete(store).activityComplete,false);
});
