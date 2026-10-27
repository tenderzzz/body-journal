import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HealthStore } from '../electron/core/store';
import { FoodCatalog } from '../electron/core/nutrition';
import { normalizeSet, EMPTY_RULES, exercisePart } from '../src/shared/exercises';
import { computeStats } from '../src/shared/stats';
import type { SetEntry } from '../src/shared/types';

const base: SetEntry={exercise:'',kg:10,reps:8,sets:3,loadBasis:'total',confirmed:false};
const rebased=(input:Partial<SetEntry>,text='')=>normalizeSet({...base,...input},[],{rebase:true,text});
function setup(t:test.TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-rules-'));
 const store=new HealthStore(root,new FoodCatalog([]),path.join(root,'inbox'),false);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return {store,root};
}
function record(store:HealthStore,text:string,date='2026-10-22'){
 return store.importEnvelope({version:1,id:randomUUID(),kind:'training',text,occurredAt:`${date}T19:00:00+08:00`,timezone:'Asia/Shanghai'}).record;
}

test('dumbbell actions are single-hand even when stored as total, unless the text says total',()=>{
 assert.equal(rebased({exercise:'哑铃飞鸟',loadBasis:'total'}).loadBasis,'per_hand');
 assert.equal(rebased({exercise:'上斜哑铃卧推',loadBasis:'unknown'}).loadBasis,'per_hand');
 assert.equal(rebased({exercise:'哑铃肩推',kg:17.5,loadBasis:'unknown'}).confirmed,true);
 const explicit=rebased({exercise:'哑铃飞鸟',loadBasis:'total'},'哑铃飞鸟 10kg 3x8\n补充：这是两只哑铃总重');
 assert.equal(explicit.loadBasis,'total');
 assert.equal(explicit.basisSource,'reported');
 const trusted=normalizeSet(explicit,[]); // 展示层没有原文时信任已保存的“原文总重”
 assert.equal(trusted.loadBasis,'total');
 // 补充说明只写“总重”、没有点名哑铃时，不改变哑铃单只口径（器械总重的说明不应误挂到哑铃上）
 assert.equal(rebased({exercise:'哑铃飞鸟',loadBasis:'total'},'哑铃飞鸟 10kg 3x8\n补充：实际总重；是器械显示重量').loadBasis,'per_hand');
 // 同一句里既说含杆总重、又说“哑铃都是单只重量”时，哑铃仍按单只
 assert.equal(rebased({exercise:'上斜哑铃卧推',loadBasis:'total'},'上斜哑铃 15kg 3x12\n补充：都是含杆总重，哑铃都是单只重量').loadBasis,'per_hand');
 assert.equal(rebased({exercise:'哑铃飞鸟',loadBasis:'total'},'哑铃飞鸟 10kg 3x10\n补充：哑铃总重').loadBasis,'total');
});

test('barbell, machine and bodyweight actions keep one deterministic caliber',()=>{
 assert.equal(rebased({exercise:'深蹲',kg:60}).loadBasis,'total');
 assert.equal(rebased({exercise:'杠铃平板卧推',kg:50}).loadBasis,'total');
 assert.equal(rebased({exercise:'碎颅者',kg:20}).loadBasis,'total');
 assert.equal(rebased({exercise:'窄距推',kg:60}).exercise,'窄距卧推');
 assert.equal(rebased({exercise:'保加利亚',kg:20}).exercise,'保加利亚分腿蹲');
 assert.equal(rebased({exercise:'保加利亚分腿蹲',kg:20,loadBasis:'per_hand'}).loadBasis,'total');
 assert.equal(rebased({exercise:'交替前平举',kg:5,loadBasis:'total'}).loadBasis,'per_hand');
 assert.equal(rebased({exercise:'臂屈伸',kg:10,loadBasis:'total'}).loadBasis,'per_hand');
 assert.equal(rebased({exercise:'高位下拉',kg:67.5,equipment:'器械',loadBasis:'total'}).loadBasis,'machine');
 assert.equal(rebased({exercise:'下斜卷腹',kg:null,loadBasis:'bodyweight'}).loadBasis,'bodyweight');
});

test('reverse fly splits into dumbbell, barbell and machine names',()=>{
 assert.equal(rebased({exercise:'哑铃反向飞鸟（单手）',loadBasis:'per_hand'}).exercise,'俯身哑铃反向飞鸟');
 assert.equal(rebased({exercise:'反向飞鸟',kg:30,loadBasis:'total'}).exercise,'器械反向飞鸟');
 assert.equal(rebased({exercise:'反向飞鸟',kg:30,loadBasis:'total'}).loadBasis,'machine');
 assert.equal(rebased({exercise:'杠铃反向飞鸟',kg:40,loadBasis:'total'}).exercise,'杠铃反向飞鸟');
 assert.equal(rebased({exercise:'杠铃反向飞鸟',kg:40,loadBasis:'total'}).loadBasis,'total');
});

test('lateral raise merges into dumbbell fly and stats show a single baseline',t=>{
 const {store}=setup(t);
 record(store,'肩：\n哑铃飞鸟 10kg 3x12\n哑铃侧平举 10kg 3x15\n哑铃侧平举 7.5kg 3x12');
 const stats=computeStats(store.records());
 assert.deepEqual(Object.keys(stats.exercises),['哑铃飞鸟']);
 assert.equal(new Set(stats.exercises['哑铃飞鸟'].map(r=>r.baseline)).size,1);
 assert.equal(stats.exercises['哑铃飞鸟'].reduce((n,r)=>n+r.sets,0),9);
 assert.ok(stats.exercises['哑铃飞鸟'].every(r=>r.basis==='per_hand'));
});

test('archive hides an action from stats, basis override rewrites records, both are revertible',t=>{
 const {store}=setup(t);
 record(store,'胸：\n哑铃飞鸟 10kg 3x12\n哑铃飞鸟 12.5kg 3x10');
 assert.equal(computeStats(store.records()).exercises['哑铃飞鸟'].length,2);
 store.saveExerciseRules({archived:['哑铃飞鸟'],overrides:{}});
 assert.equal(computeStats(store.records(),'Asia/Shanghai',{rules:store.exerciseRules()}).exercises['哑铃飞鸟'],undefined);
 store.saveExerciseRules({archived:[],overrides:{哑铃飞鸟:'total'}});
 const rows=computeStats(store.records(),'Asia/Shanghai',{rules:store.exerciseRules()}).exercises['哑铃飞鸟'];
 assert.ok(rows.every(r=>r.basis==='total'));
 store.saveExerciseRules({archived:[],overrides:{}});
 assert.ok(computeStats(store.records(),'Asia/Shanghai',{rules:store.exerciseRules()}).exercises['哑铃飞鸟'].every(r=>r.basis==='per_hand'));
});

test('deleting a manual classification returns the action to the automatic rule',t=>{
 const {store}=setup(t);
 const r=record(store,'肩：\n哑铃侧平举 10kg 3x15');
 store.reclassifyExercise('哑铃侧平举','自定飞鸟');
 assert.equal(store.record(r.id).analysis!.sets![0].exercise,'自定飞鸟');
 store.deleteExerciseAlias('哑铃侧平举');
 assert.equal(store.record(r.id).analysis!.sets![0].exercise,'哑铃飞鸟');
 assert.throws(()=>store.deleteExerciseAlias('哑铃侧平举'),/不存在/);
});

test('record deletion is a reversible soft delete',t=>{
 const {store}=setup(t);
 const r=record(store,'胸：\n哑铃飞鸟 10kg 3x12');
 assert.ok(computeStats(store.records()).exercises['哑铃飞鸟']);
 store.setRecordDeleted(r.id,true);
 assert.equal(computeStats(store.records()).exercises['哑铃飞鸟'],undefined);
 assert.equal(store.record(r.id).deleted,true);
 store.setRecordDeleted(r.id,false);
 assert.ok(computeStats(store.records()).exercises['哑铃飞鸟']);
});

test('migration rewrites historical calibers and names once, keeps explicit total and backs up first',t=>{
 const {store,root}=setup(t);
 const r=record(store,'肩：\n哑铃侧平举 10kg 3x15\n哑铃反向飞鸟 15kg 3x12');
 const legacy={...r,analysis:{...r.analysis!,sets:r.analysis!.sets!.map(s=>({...s,loadBasis:'total' as const,basisSource:undefined,confirmed:false}))}};
 store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(legacy),r.id);
 store.setConfig('exerciseVersion',1);
 const changed=store.migrateExerciseRules();
 assert.ok(changed>=1);
 const migrated=store.record(r.id).analysis!.sets!;
 assert.deepEqual(migrated.map(s=>s.exercise).sort(),['哑铃飞鸟','俯身哑铃反向飞鸟'].sort());
 assert.ok(migrated.every(s=>s.loadBasis==='per_hand'));
 assert.ok(existsSync(path.join(root,'backups')));
 assert.ok(readdirSync(path.join(root,'backups')).some(f=>f.startsWith('before-v019-')));
 assert.equal(store.migrateExerciseRules(),0);
});

test('explicit total in the original note survives migration for a dumbbell action',t=>{
 const {store}=setup(t);
 const r=record(store,'背：\n哑铃划船 20kg 3x10\n补充：这是两只哑铃总重');
 assert.equal(store.record(r.id).analysis!.sets![0].loadBasis,'total');
 assert.equal(store.record(r.id).analysis!.sets![0].basisSource,'reported');
});

test('dumbbell shoulder press is seated by default and keeps explicit standing',()=>{
 const seated=rebased({exercise:'哑铃肩推',position:undefined});
 assert.equal(seated.position,'seated');
 assert.equal(rebased({exercise:'哑铃推肩',position:undefined}).position,'seated');
 assert.equal(rebased({exercise:'哑铃肩推',originalExercise:'站姿哑铃推肩',position:undefined}).position,'standing');
});

test('startup migrations are idempotent across repeated launches',t=>{
 const {store,root}=setup(t);
 record(store,'肩：\n哑铃侧平举 10kg 3x15\n哑铃推肩 17.5kg 3x12');
 store.setConfig('exerciseVersion',1);
 const backups=()=>readdirSync(path.join(root,'backups')).filter(f=>f.endsWith('.bodyjournal')).length;
 store.migrate016();store.migrateExerciseRules();store.migrateSeatedPress();
 const afterFirst=backups();
 assert.equal(store.getConfig<number>('exerciseVersion'),3);
 store.migrate016();store.migrateExerciseRules();store.migrateSeatedPress();
 store.migrate016();store.migrateExerciseRules();store.migrateSeatedPress();
 assert.equal(backups(),afterFirst);
 assert.equal(store.getConfig<number>('exerciseVersion'),3);
 const press=store.records().flatMap(r=>r.analysis?.sets??[]).find(s=>s.exercise==='哑铃肩推');
 assert.equal(press?.position,'seated');
});

test('exercises are grouped into chest, back, shoulders, legs and core',()=>{
 assert.equal(exercisePart('杠铃平板卧推'),'chest');
 assert.equal(exercisePart('上斜哑铃卧推'),'chest');
 assert.equal(exercisePart('窄距卧推'),'chest');
 assert.equal(exercisePart('高位下拉'),'back');
 assert.equal(exercisePart('俯身哑铃划船'),'back');
 assert.equal(exercisePart('哑铃弯举'),'back');
 assert.equal(exercisePart('哑铃肩推'),'shoulders');
 assert.equal(exercisePart('哑铃飞鸟'),'shoulders');
 assert.equal(exercisePart('器械反向飞鸟'),'shoulders');
 assert.equal(exercisePart('绳索面拉'),'shoulders');
 assert.equal(exercisePart('深蹲'),'legs');
 assert.equal(exercisePart('保加利亚分腿蹲'),'legs');
 assert.equal(exercisePart('器械卷腹'),'core');
 assert.equal(exercisePart('下斜卷腹'),'core');
 assert.equal(exercisePart('悬垂举腿'),'core');
 assert.equal(exercisePart('壶铃摇摆'),'other');
 assert.equal(exercisePart('新加的绳索夹胸'),'chest');
});

test('rules default to empty and computeStats works without rules argument',()=>{
 assert.deepEqual(EMPTY_RULES,{archived:[],overrides:{}});
 const set=rebased({exercise:'哑铃飞鸟'});
 assert.equal(set.loadBasis,'per_hand');
 assert.equal(normalizeSet(set,[]).loadBasis,'per_hand');
});
