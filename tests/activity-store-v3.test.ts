import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
const day='2026-10-27',now=new Date(day+'T12:00:00+08:00');
const profile={effectiveDate:'2026-09-01',age:30,heightCm:180,sex:'male',activity:'seated',strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:30,runPerWeek:1,runPace:360,generalAdult:true,usualSteps:4000};
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-activity-v3-'));const store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{if(store.db.isOpen)store.close();rmSync(root,{recursive:true,force:true});});return store;}
function record(store:HealthStore,id:string,kind='training',date=day,text='跑步5km 用时30分钟'){return store.importEnvelope({version:1,id,kind,occurredAt:date+'T18:00:00+08:00',timezone:'Asia/Shanghai',text}).record;}
function weight(store:HealthStore){store.importEnvelope({version:1,id:'weight-v3',kind:'body',occurredAt:day+'T08:00:00+08:00',timezone:'Asia/Shanghai',text:'体重80kg',body:{weightKg:80}});}

test('manual corrections and cleared fields survive re-extraction, backup, restart and undo',t=>{
 let store=setup(t);store.energy.saveProfile(profile,now);weight(store);let r=record(store,'run-v3-01');
 r=store.applyAnalysis(r.id,{summary:'截图',questions:[],assumptions:[],run:{km:5,minutes:30,activeKcal:300,completion:'completed'}},'deepseek',r.revision);
 r=store.updateActivity({id:r.id,revision:r.revision,run:{minutes:35,activeKcal:null,totalKcal:360,paceSecondsPerKm:420}});
 assert.equal(r.analysis!.run!.minutes,35);assert.equal(r.analysis!.run!.activeKcal,undefined);
 r=store.applyAnalysis(r.id,{summary:'重新提取',questions:[],assumptions:[],run:{km:5,minutes:30,activeKcal:310,completion:'completed'},activityOverrides:{run:{minutes:1}}},'deepseek',r.revision);
 assert.equal(r.analysis!.run!.minutes,35);assert.equal(r.analysis!.run!.activeKcal,undefined);assert.equal(r.analysis!.run!.totalKcal,360);
 assert.throws(()=>store.updateActivity({id:r.id,revision:r.revision-1,run:{minutes:2}}),/已变化/);
 assert.throws(()=>store.updateActivity({id:r.id,revision:r.revision,run:{badField:null}}),/字段无效/);
 const bundle=store.exportBundle();assert.equal(bundle.version,3);store.restore(bundle);assert.equal(store.record(r.id).analysis!.run!.totalKcal,360);
 const root=store.root;store.close();store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{if(store.db.isOpen)store.close();});
 assert.equal(store.record(r.id).analysis!.run!.minutes,35);
 const changed=store.updateActivity({id:r.id,revision:store.record(r.id).revision,run:{minutes:40}});assert.equal(changed.analysis!.run!.minutes,40);
 assert.equal(store.undoRecord(r.id).analysis!.run!.minutes,35);
});

test('daily report revisions invalidate activity confirmation and source-dependent answers',t=>{
 const store=setup(t);store.energy.saveProfile(profile,now);weight(store);
 let r=record(store,'steps-v3','note',day,'全天步数8000步');
 r=store.applyAnalysis(r.id,{summary:'步数',questions:[],assumptions:[],dailyActivity:{steps:8000,scope:'nonTraining',coverage:'full',sourceApp:'测试App'}},'local',r.revision);
 store.energy.saveDay({date:day,mealComplete:false,activityComplete:true},now);
 assert.equal(store.energy.day(day).activityComplete,true);assert.equal(store.energy.day(day).walking?.nonTrainingSteps,8000);
 const dependency={from:day,to:day,hash:store.energy.hash(day,day)};
 store.putMessage({id:'answer-v3',role:'assistant',text:'测试回答',createdAt:now.toISOString(),status:'complete',sources:[],provider:'local',stale:false,energyDependency:dependency});
 store.updateActivity({id:r.id,revision:r.revision,dailyActivity:{steps:9000}});
 assert.equal(store.energy.day(day).activityComplete,false);assert.equal(store.messages().find(m=>m.id==='answer-v3')?.stale,true);
 assert.equal(store.energy.day(day).walking?.nonTrainingSteps,9000);
 store.energy.saveDay({date:day,mealComplete:false,activityComplete:true},now);assert.equal(store.energy.day(day).activityComplete,true);
 store.revise(r.id,{deleted:true},store.record(r.id).revision);assert.equal(store.energy.day(day).walking,null);assert.equal(store.energy.day(day).activityComplete,false);
});

test('reference steps suggestion needs seven complete historical days and is a median',t=>{
 const store=setup(t);store.energy.saveProfile({...profile,usualSteps:undefined},now);weight(store);
 for(let i=0;i<7;i++){
  const date=`2026-10-${String(20+i).padStart(2,'0')}`;
  store.energy.saveDay({date,steps:[1000,2000,3000,4000,5000,6000,10000][i],stepsScope:'nonTraining',stepCoverage:'full',mealComplete:false,activityComplete:true},now);
  if(i===5)assert.equal(store.energy.view({},now).suggestedUsualSteps,undefined);
 }
 assert.equal(store.energy.view({},now).suggestedUsualSteps,4000);
});

test('v2 database is backed up before v3 and v1/v2 backups remain restorable',t=>{
 let store=setup(t);store.energy.saveProfile(profile,now);record(store,'kept-v3-01');const root=store.root;
 store.db.exec('PRAGMA user_version=2');store.close();store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{if(store.db.isOpen)store.close();});
 assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version,3);
 const files=readdirSync(root+'/backups').filter(f=>f.startsWith('before-activity-v3-'));assert.equal(files.length,1);
 const old=JSON.parse(readFileSync(root+'/backups/'+files[0],'utf8'));assert.equal(old.version,2);assert.equal(old.energy.profiles[0].usualSteps,4000);
 store.restore(old);assert.equal(store.record('kept-v3-01').id,'kept-v3-01');assert.equal(store.energy.profiles().length,1);
 store.restore({...old,version:1,energy:undefined});assert.equal(store.energy.profiles().length,0);assert.equal(store.record('kept-v3-01').id,'kept-v3-01');
});
