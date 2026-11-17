import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeExerciseName,normalizeSet,baselineKey,groupedSets} from '../src/shared/exercises';
import {computeStats} from '../src/shared/stats';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {parseTraining} from '../electron/core/parser';
import type {SetEntry} from '../src/shared/types';

const row=(exercise:string,patch:Partial<SetEntry>={}):SetEntry=>({exercise,kg:60,sets:3,reps:8,loadBasis:'total',confirmed:false,...patch});

test('common shorthand, word order and typography resolve to the same exercise without manual aliases',()=>{
 for(const names of [
  ['深蹲','杠铃深蹲','杠铃后蹲','后蹲','杠铃背蹲',' 杠铃　深蹲 ','槓鈴深蹲','杠铃·深蹲'],
  ['杠铃平板卧推','杠铃卧推','平板杠铃卧推','卧推'],
  ['上斜哑铃卧推','哑铃上斜卧推','哑铃上斜'],
  ['俯身杠铃划船','杠铃俯身划船'],
  ['俯身哑铃划船','哑铃俯身划船'],
  ['绳索三头下压','绳索三头肌下压','三头绳索下压'],
  ['高位下拉','器械高位下拉'],['腿屈伸','器械腿屈伸']
 ])assert.equal(new Set(names.map(normalizeExerciseName)).size,1,names.join(' / '));
 const sets=['深蹲','杠铃深蹲','杠铃后蹲'].map(name=>normalizeSet(row(name,{classificationNeeded:true})));
 assert.ok(sets.every(s=>s.exercise==='深蹲'&&!s.classificationNeeded&&s.confirmed));
 assert.equal(new Set(sets.map(s=>s.exerciseId)).size,1);assert.equal(new Set(sets.map(baselineKey)).size,1);
 assert.equal(groupedSets(sets).length,1);
});

test('real squat variants and structured equipment evidence keep distinct identities',()=>{
 const names=['深蹲','哑铃深蹲','壶铃深蹲','史密斯深蹲','杠铃前蹲','自重深蹲','高脚杯深蹲','相扑深蹲','深蹲跳','单腿深蹲'];
 assert.equal(new Set(names.map(name=>normalizeSet(row(name)).exerciseId)).size,names.length);
 assert.equal(normalizeSet(row('深蹲',{equipment:'哑铃'})).exercise,'哑铃深蹲');
 assert.equal(normalizeSet(row('深蹲',{equipment:'史密斯机'})).exercise,'史密斯深蹲');
 assert.equal(normalizeSet(row('深蹲（前蹲）')).exercise,'杠铃前蹲');
 assert.equal(normalizeSet(row('深蹲（哑铃）')).exercise,'哑铃深蹲');
 const bodyweight=normalizeSet(row('深蹲',{loadBasis:'bodyweight',kg:null}));
 assert.equal(bodyweight.exercise,'自重深蹲');assert.equal(bodyweight.loadBasis,'bodyweight');assert.equal(bodyweight.kg,null);
 assert.equal(normalizeSet(row('深蹲',{notes:'今天没有用史密斯机'})).exercise,'深蹲');
 assert.equal(normalizeSet(row('深蹲（器械未知）')).classificationNeeded,true);
 assert.equal(normalizeSet(row('俯身划船',{classificationNeeded:true})).classificationNeeded,true);
 const first=normalizeSet(row('杠铃深蹲',{equipmentId:'合成深蹲架A'})),second=normalizeSet(row('深蹲',{equipmentId:'合成深蹲架B'}));
 assert.notEqual(baselineKey(first),baselineKey(second));
});

test('explicit user classifications and manual load decisions take precedence',()=>{
 const custom=normalizeSet(row('深蹲'),[{raw:'深蹲',name:'我的特殊深蹲'}]);assert.equal(custom.exercise,'我的特殊深蹲');assert.equal(custom.exerciseManuallyClassified,true);
 const knownManual=normalizeSet(row('杠铃深蹲',{exerciseManuallyClassified:true}));assert.equal(knownManual.exercise,'杠铃深蹲');
 const preference=[{raw:'深蹲',name:'杠铃深蹲'}];
 assert.equal(normalizeSet(row('深蹲（器械未知）'),preference).classificationNeeded,true);
 for(const name of ['深蹲','杠铃深蹲','杠铃后蹲']){
  const preferred=normalizeSet(row(name),preference);assert.equal(preferred.exercise,'杠铃深蹲');
  assert.equal(normalizeSet(preferred).exercise,'杠铃深蹲');
 }
 const manual=normalizeSet(row('杠铃深蹲',{loadBasis:'unknown',basisSource:'manual'}),[],{rules:{archived:[],overrides:{深蹲:'total'}},rebase:true});
 assert.equal(manual.loadBasis,'unknown');assert.equal(manual.basisSource,'manual');
 const legacyRule=normalizeSet(row('深蹲'),[],{rules:{archived:[],overrides:{杠铃深蹲:'unknown'}},rebase:true});assert.equal(legacyRule.loadBasis,'unknown');
});

test('parsing synonymous squat names needs no classification confirmation and preserves all sets',()=>{
 const a=parseTraining('腿：\n深蹲 60kg 3x8\n杠铃深蹲 65kg 2x6')!;
 assert.deepEqual(a.questions,[]);assert.equal(a.sets!.length,2);assert.ok(a.sets!.every(s=>s.exercise==='深蹲'&&s.confirmed&&!s.classificationNeeded));
 assert.deepEqual(a.sets!.map(s=>[s.kg,s.sets,s.reps]),[[60,3,8],[65,2,6]]);
});

test('legacy split rows merge in trends and training memories through restart and backup without rewriting source records',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-exercise-names-'));
 let store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const ids:string[]=[];
 for(const [i,name] of ['深蹲','杠铃深蹲'].entries()){
  const record=store.importEnvelope({version:1,id:'synthetic-squat-'+i,kind:'training',dateLocked:true,occurredAt:`2026-10-${20+i}T12:00:00+08:00`,timezone:'Asia/Shanghai',text:`腿：\n${name} ${60+5*i}kg 3x8`}).record;
  // Persist pre-fix representations including the stale automatic review flag.
  const set={...record.analysis!.sets![0],exercise:name,originalExercise:name,exerciseId:'legacy-'+i,classificationNeeded:true,confirmed:false,equipment:i?'杠铃':undefined};
  store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify({...record,analysis:{...record.analysis!,sets:[set]}}),record.id);ids.push(record.id);
 }
 const source=JSON.stringify(store.records()),volumes=[60*3*8,65*3*8];
 function check(){
  const stats=computeStats(store.records());assert.deepEqual(Object.keys(stats.exercises),['深蹲']);
  const rows=stats.exercises['深蹲'];assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.baseline)).size,1);
  assert.deepEqual(rows.map(r=>r.volume),volumes);assert.ok(rows.every(r=>r.basis==='total'));
  store.refreshPersonalization();
  const refs=store.memories().filter(m=>m.autoCategory==='training'&&m.active&&!m.stale);
  assert.equal(refs.length,1);assert.deepEqual(new Set(refs[0].sourceIds),new Set(ids));assert.match(refs[0].text,/深蹲：杠铃 · 报告总重/);
  assert.equal(JSON.stringify(store.records()),source);
 }
 check();const backup=store.exportBundle();store.close();store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);check();store.restore(backup);check();
 const rules={archived:['杠铃深蹲'],overrides:{}};
 assert.deepEqual(Object.keys(computeStats(store.records(),'Asia/Shanghai',{rules}).exercises),[]);
 assert.equal(JSON.stringify(store.records()),source);
});
