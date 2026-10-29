import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';

function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-memory-temporal-'));const s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return s;}
function train(s:HealthStore,id:string,date:string,kg:number){return s.importEnvelope({version:1,id,kind:'training',occurredAt:date+'T18:00:00+08:00',timezone:'Asia/Shanghai',text:`卧推 ${kg}kg 3x8`}).record;}
function meal(s:HealthStore,id:string,date:string,grams:number){let r=s.importEnvelope({version:1,id,kind:'meal',occurredAt:date+'T12:00:00+08:00',timezone:'Asia/Shanghai',text:`米饭 ${grams}g`}).record;return s.applyAnalysis(r.id,{summary:'合成餐食',ingredients:[{name:'米饭',foodId:null,grams:{low:grams,high:grams},assumption:'合成已知份量',nutrition:{source:'estimate',basis:'合成营养',per100g:{kcal:{low:130,high:130},protein:{low:2,high:2},carbs:{low:28,high:28},fat:{low:.3,high:.3}}}}]},'local',r.revision);}
const queryAt=(s:HealthStore,kind:'training'|'meal',date:string)=>s.memoryContext(kind,kind==='training'?'卧推':'米饭',new Date(date+'T23:00:00+08:00')).items.filter(m=>m.autoCategory===kind);

test('training references use their latest evidence date and historical queries recover the older load',t=>{
 const s=setup(t),old=train(s,'temporal-bench-old','2026-10-01',40);train(s,'temporal-bench-new','2026-10-28',80);
 const history=queryAt(s,'training','2026-10-10');assert.equal(history.length,1);assert.match(history[0].text,/40kg/);assert.ok(!history[0].sourceIds.includes('temporal-bench-new'));
 const current=queryAt(s,'training','2026-10-28');assert.match(current[0].text,/80kg/);assert.equal(current[0].startsAt,'2026-10-28T18:00:00+08:00');assert.equal(current[0].versionStartsAt,current[0].startsAt);
 assert.ok(history[0].sourceIds.includes(old.id));
});

test('repeated meal templates do not expose a later meal or its portion to historical analysis',t=>{
 const s=setup(t);meal(s,'temporal-meal-first','2026-10-01',100);meal(s,'temporal-meal-second','2026-10-02',120);meal(s,'temporal-meal-later','2026-10-28',300);
 assert.equal(queryAt(s,'meal','2026-10-01').length,0);
 const historical=queryAt(s,'meal','2026-10-10');assert.equal(historical.length,1);assert.deepEqual(historical[0].mealTemplate?.[0].grams,{low:120,high:120});assert.ok(!historical[0].sourceIds.includes('temporal-meal-later'));
 const latest=queryAt(s,'meal','2026-10-28');assert.deepEqual(latest[0].mealTemplate?.[0].grams,{low:300,high:300});assert.equal(latest[0].startsAt,'2026-10-28T12:00:00+08:00');
});

test('editing an older training source cannot move a later aggregate into an earlier date',t=>{
 const s=setup(t),old=train(s,'temporal-edited-old','2026-10-01',40);train(s,'temporal-edited-new','2026-10-28',80);
 s.revise(old.id,{text:'卧推 45kg 3x8'},old.revision);
 const history=queryAt(s,'training','2026-10-10');assert.equal(history.length,1);assert.ok(!history[0].sourceIds.includes('temporal-edited-new'));assert.doesNotMatch(history[0].text,/80kg/);
 const latest=queryAt(s,'training','2026-10-28');assert.equal(latest[0].versionStartsAt,'2026-10-28T18:00:00+08:00');assert.match(latest[0].text,/80kg/);
});

test('meal memory identity retains flavor and cooking state instead of combining different foods',t=>{
 const s=setup(t);
 for(const [i,name,state] of [[0,'测试乳清粉（香草味）','raw'],[1,'测试乳清粉（巧克力味）','raw'],[2,'测试乳清粉（香草味）','cooked']] as const){
  let r=s.importEnvelope({version:1,id:`temporal-flavor-${i}`,kind:'meal',occurredAt:`2026-10-0${i+1}T12:00:00+08:00`,timezone:'Asia/Shanghai',text:name}).record;
  s.applyAnalysis(r.id,{summary:name,ingredients:[{name,foodState:state,foodId:null,grams:{low:30,high:30},assumption:'测试',nutrition:{source:'estimate',basis:'合成测试',per100g:{kcal:{low:400,high:400},protein:{low:60,high:60},carbs:{low:20,high:20},fat:{low:10,high:10}}}}]},'local',r.revision);
 }
 assert.equal(s.memories().filter(m=>m.autoCategory==='meal').length,0);
});

test('repeated volume-based portions keep ml and remain estimates in the template',t=>{
 const s=setup(t);
 for(let i=0;i<2;i++){
  const r=s.importEnvelope({version:1,id:`temporal-volume-${i}`,kind:'meal',occurredAt:`2026-10-0${i+1}T12:00:00+08:00`,timezone:'Asia/Shanghai',text:'杏仁奶约250ml'}).record;
  s.applyAnalysis(r.id,{summary:'合成饮品',ingredients:[{name:'杏仁奶',foodId:null,grams:{low:0,high:0},amount:{low:250,high:250,unit:'ml'},portionSource:'estimated',assumption:'估计饮用量',nutrition:{source:'estimate',basis:'合成每100ml参考',labelBasis:{quantity:100,unit:'ml'},perBasis:{kcal:{low:20,high:20},protein:{low:1,high:1},carbs:{low:2,high:2},fat:{low:1,high:1}}}}]},'local',r.revision);
 }
 const template=s.memoryContext('meal','杏仁奶',new Date('2026-10-10T23:00:00+08:00')).items.find(m=>m.mealTemplate?.some(i=>i.name==='杏仁奶'))!;
 assert.ok(template);assert.match(template.text,/250–250ml（估计分量）/);assert.equal(template.mealTemplate![0].portionSource,'estimated');
});
