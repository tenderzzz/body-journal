import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {addDays,ENERGY_MODEL_VERSION,LEGACY_ENERGY_MODEL_VERSION} from '../src/shared/energy';
import {energyBackupSchema} from '../electron/core/energy-validation';
const now=new Date('2026-10-29T22:00:00+08:00');
const profile={effectiveDate:'2026-09-01',age:30,heightCm:180,sex:'male',activity:'seated',strideCm:72,strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:30,runPerWeek:2,runPace:360,generalAdult:true};
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-fixed-baseline-'));const s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});s.energy.saveProfile(profile,now);s.importEnvelope({version:1,id:'fixed-weight',kind:'body',occurredAt:'2026-09-01T08:00:00+08:00',timezone:'Asia/Shanghai',text:'合成体重',body:{weightKg:80}});return s;}
function save(s:HealthStore,date:string,steps:number){s.energy.saveDay({date,steps,stepsScope:'nonTraining',stepCoverage:'full',mealComplete:false,activityComplete:true},now);return s.energy.day(date);}
function initialHistory(s:HealthStore){for(let i=0;i<7;i++)save(s,addDays('2026-09-24',i),3000);}
function legacy(s:HealthStore){const p=s.energy.profiles()[0];delete p.baselineAnchor;s.db.prepare('UPDATE energy_profiles SET doc=? WHERE id=?').run(JSON.stringify(p),p.id);}

test('a saved baseline retains a sustained increase while the rolling history becomes a suggestion',t=>{
 const s=setup(t);initialHistory(s);s.energy.saveProfile({...profile,effectiveDate:'2026-10-01'},now);
 const first=save(s,'2026-10-01',8000);
 for(let i=1;i<28;i++)save(s,addDays('2026-10-01',i),8000);
 const last=s.energy.day('2026-10-28');
 assert.equal(first.walking?.referenceSteps,3000);assert.equal(last.walking?.referenceSteps,3000);
 assert.deepEqual(last.walking?.correction,{low:144,high:144});assert.deepEqual(first.expenditure,last.expenditure);
 assert.equal(s.energy.view({date:'2026-10-28'},now).suggestedUsualSteps,8000);
 assert.equal(last.modelVersion,ENERGY_MODEL_VERSION);
});

test('the first calculation profile can anchor already-confirmed historical step records',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-first-anchor-')),s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});
 initialHistory(s);
 const p=s.energy.saveProfile({...profile,effectiveDate:'2026-10-01'},now);
 assert.equal(p.baselineAnchor?.references.seated.method,'history');assert.deepEqual(p.baselineAnchor?.references.seated.steps,{low:3000,high:3000});
});

test('migration fixes today while preserving both old history and today’s old estimate',t=>{
 const s=setup(t);legacy(s);initialHistory(s);
 for(let i=0;i<29;i++)save(s,addDays('2026-10-01',i),8000);
 const past=s.energy.day('2026-10-01'),today=s.energy.day('2026-10-29');
 assert.equal(past.modelVersion,LEGACY_ENERGY_MODEL_VERSION);
 assert.equal(s.energy.migrateFixedBaselines(now),1);assert.equal(s.energy.migrateFixedBaselines(now),0);
 assert.deepEqual(s.energy.day('2026-10-01'),past);
 const migrated=s.energy.day('2026-10-29');assert.deepEqual(migrated.expenditure,today.expenditure);
 assert.equal(migrated.walking?.referenceSteps,today.walking?.referenceSteps);assert.equal(migrated.modelVersion,ENERGY_MODEL_VERSION);
});

test('changed historical inputs warn without silently moving the saved reference; backup retains it',t=>{
 const s=setup(t);initialHistory(s);const p=s.energy.saveProfile({...profile,effectiveDate:'2026-10-01'},now);
 save(s,'2026-10-01',8000);save(s,'2026-09-24',12000);
 assert.equal(s.energy.day('2026-10-01').walking?.referenceSteps,3000);
 assert.match(s.energy.day('2026-10-01').assumptions.join(' '),/历史核对资料已有变化/);
 const backup=energyBackupSchema.parse(s.energy.export());s.energy.restore(backup);
 assert.deepEqual(s.energy.profiles().find(x=>x.id===p.id)?.baselineAnchor,p.baselineAnchor);
 const bad=structuredClone(backup);bad.profiles[1].baselineAnchor!.references.seated.dates=['2026-10-02'];
 assert.throws(()=>s.energy.validateBackup(bad),/未来/);
});

test('App and formula estimates are available separately and only the selected source enters totals',t=>{
 const s=setup(t);let r=s.importEnvelope({version:1,id:'fixed-run',kind:'training',occurredAt:'2026-10-29T18:00:00+08:00',timezone:'Asia/Shanghai',text:'跑步已完成'}).record;
 r=s.applyAnalysis(r.id,{summary:'合成跑步',questions:[],assumptions:[],run:{km:5,minutes:30,paceSecondsPerKm:360,completion:'completed',activeKcal:350}},'local',r.revision);
 const day=s.energy.day('2026-10-29'),w=day.workouts[0];assert.equal(w.comparison?.selected,'app');assert.equal(w.comparison?.app.reportedKcal,350);assert.ok(w.comparison?.formula);
 assert.deepEqual(w.extra,w.comparison!.app.extra);
 assert.equal(day.expenditure!.low,day.dailyBaseline!.low+w.extra.low);
 assert.equal(day.expenditure!.high,day.dailyBaseline!.high+w.extra.high);
 r=s.applyAnalysis(r.id,{summary:'未知口径',questions:[],assumptions:[],run:{km:5,minutes:30,paceSecondsPerKm:360,completion:'completed',reportedKcal:380,calorieLabel:'消耗'}},'local',r.revision);
 const unknown=s.energy.day('2026-10-29').workouts[0];assert.equal(unknown.comparison?.selected,'formula');assert.equal(unknown.comparison?.app.method,'app-unknown');assert.equal(unknown.comparison?.app.extra,null);assert.deepEqual(unknown.extra,unknown.comparison?.formula);
});

test('dependency hashes retain the old evidence behind a fixed baseline beyond the rolling window',t=>{
 const s=setup(t);initialHistory(s);s.energy.saveProfile({...profile,effectiveDate:'2026-10-01'},now);
 const before=s.energy.hash('2026-11-29','2026-11-29');
 save(s,'2026-09-24',12000);
 assert.notEqual(s.energy.hash('2026-11-29','2026-11-29'),before);
});

test('weekly checking counts daily weight medians and never turns missing intake days into zero',t=>{
 const s=setup(t);for(const [i,kg] of [80,82,81].entries())s.importEnvelope({version:1,id:`weekly-weight-${i}`,kind:'body',occurredAt:`2026-10-2${7+i}T08:00:00+08:00`,timezone:'Asia/Shanghai',text:'合成体重',body:{weightKg:kg}});
 const weeks=s.energy.trendWeeks('2026-10-29'),last=weeks.at(-1)!;
 assert.equal(last.weightDays,3);assert.equal(last.weightMedian,81);assert.equal(last.intakeMean,null);assert.equal(last.intakeDays,0);assert.equal(last.mealCompleteDays,0);
});
