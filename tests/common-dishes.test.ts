import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import type {HealthRecord} from '../src/shared/types';

function setup(t:test.TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'common-dishes-'));
 const state={root,store:new HealthStore(root,new FoodCatalog([]),root+'/inbox',false)};
 t.after(()=>{state.store.close();rmSync(root,{recursive:true,force:true});});
 return state;
}
function meal(s:HealthStore,id:string,day:number,text:string,names:string[]=['合成主料'],kcal=100):HealthRecord{
 const r=s.importEnvelope({version:1,id,kind:'meal',text,occurredAt:`2026-10-${day}T12:00:00+08:00`,timezone:'Asia/Shanghai'}).record;
 s.applyAnalysis(r.id,{summary:'合成整餐估算',questions:[],assumptions:['合成数据，没有称量依据'],ingredients:names.map(name=>({name,foodId:null,grams:{low:100,high:120},assumption:'合成分量估计',portionSource:'estimated',nutrition:{source:'estimate',basis:'合成同类食物参考',per100g:{kcal:{low:kcal,high:kcal+30},protein:{low:5,high:7},carbs:{low:15,high:20},fat:{low:3,high:5}}}}))},'chatgpt',r.revision);
 return s.record(r.id);
}
function pair(s:HealthStore){
 const first=meal(s,'synthetic-dish-first',20,'合成甲餐牌南瓜云吞8个',['合成完整云吞']);
 const second=meal(s,'synthetic-dish-second',21,'合成甲餐牌，南瓜云吞八个',['合成面皮','合成馅料'],150);
 return {first,second};
}

test('same named dishes group across different ingredient decompositions without promoting estimates or changing meals',t=>{
 const {store:s}=setup(t),{first,second}=pair(s),before=JSON.stringify(s.records()),dishes=s.commonDishes();
 assert.equal(dishes.length,1);const d=dishes[0];assert.equal(d.auto,true);assert.equal(d.days,2);assert.deepEqual(new Set(d.recordIds),new Set([first.id,second.id]));
 assert.equal(d.latestRecordId,second.id);assert.deepEqual(d.macros,second.analysis!.macros);assert.deepEqual(d.template,second.analysis!.ingredients);assert.ok(d.template.every(i=>i.portionSource==='estimated'&&i.nutrition?.source==='estimate'));
 assert.equal(s.foodPresets().length,0);assert.equal(s.memories().filter(m=>m.kind==='food').length,0);assert.equal(JSON.stringify(s.records()),before);
 assert.ok(s.recordsWithDishes().every(r=>r.dishId===d.id));assert.deepEqual(s.record(first.id).analysis!.macros,first.analysis!.macros);assert.notDeepEqual(first.analysis!.macros,second.analysis!.macros);
});

test('automatic common dishes require distinct days and keep different flavors or merchants separate',t=>{
 const {store:s}=setup(t);meal(s,'synthetic-same-day-first',20,'合成甲餐牌南瓜云吞8个');meal(s,'synthetic-same-day-second',20,'合成甲餐牌南瓜云吞十个');
 assert.deepEqual(s.commonDishes(),[]);
 meal(s,'synthetic-other-flavor',21,'合成甲餐牌云吞（麻辣味）');meal(s,'synthetic-other-merchant',21,'合成乙餐牌南瓜云吞8个');
 assert.deepEqual(s.commonDishes(),[]);
});

test('explicit same-dish bindings support naming variants and persist edits, archive and restart',t=>{
 const state=setup(t),s=state.store,first=meal(s,'synthetic-bound-first',20,'合成鸡肉面（少酱）'),second=meal(s,'synthetic-bound-second',21,'合成鸡肉面（淋酱）',['合成鸡肉','合成面条'],180),before=JSON.stringify(s.records());
 const bound=s.saveDish({name:'合成鸡肉面整餐',recordIds:[first.id,second.id]});assert.equal(s.commonDishes().length,1);assert.equal(bound.id,s.commonDishes()[0].id);assert.equal(s.commonDishes()[0].auto,false);
 s.saveDish({id:bound.id,name:'合成鸡肉面常吃款',aliases:['合成面餐'],active:false});assert.equal(s.commonDishes()[0].active,false);assert.equal(s.commonDishes()[0].name,'合成鸡肉面常吃款');assert.ok(s.commonDishes()[0].aliases.includes('合成面餐'));
 s.refreshAutomaticMemories();assert.equal(s.commonDishes().filter(d=>d.active).length,0);assert.equal(s.commonDishes().length,1);assert.equal(JSON.stringify(s.records()),before);
 s.close();state.store=new HealthStore(state.root,new FoodCatalog([]),state.root+'/inbox',false);assert.equal(state.store.commonDishes()[0].active,false);state.store.saveDish({id:bound.id,active:true});assert.equal(state.store.commonDishes()[0].active,true);
});

test('common dish definitions survive backup restore and older backups clear definitions',t=>{
 const {store:s}=setup(t),{first,second}=pair(s);const d=s.saveDish({name:'合成常吃云吞',recordIds:[first.id,second.id],aliases:['合成固定餐']});
 const bundle=s.exportBundle(),expected=s.dishDefinitions();s.saveDish({id:d.id,active:false});s.restore(bundle);assert.deepEqual(s.dishDefinitions(),expected);assert.equal(s.commonDishes()[0].active,true);
 const {dishDefinitions:_omitted,...old}=structuredClone(bundle);s.restore(old);assert.deepEqual(s.dishDefinitions(),[]);assert.equal(s.commonDishes()[0].auto,true);assert.deepEqual(s.record(second.id).analysis!.macros,second.analysis!.macros);
});

test('invalid definition references and ambiguous aliases fail before backup restore or group mutation',t=>{
 const {store:s}=setup(t),{first,second}=pair(s);s.saveDish({name:'合成有效云吞',recordIds:[first.id,second.id],aliases:['合成别名']});const before={records:s.records(true),definitions:s.dishDefinitions(),memories:s.memories(),messages:s.messages(),energy:s.energy.export()};
 const damaged=s.exportBundle();damaged.dishDefinitions[0].recordIds.push('synthetic-missing-meal');assert.throws(()=>s.restore(damaged),/不存在|引用/);assert.deepEqual({records:s.records(true),definitions:s.dishDefinitions(),memories:s.memories(),messages:s.messages(),energy:s.energy.export()},before);
 const other=meal(s,'synthetic-other-dish',22,'合成蔬菜咖喱饭');const definitions=JSON.stringify(s.dishDefinitions());assert.throws(()=>s.saveDish({name:'合成新菜',recordIds:[other.id],aliases:['合成别名']}),/多个分组/);assert.equal(JSON.stringify(s.dishDefinitions()),definitions);
});

test('historical common dish views use only templates and estimates available by that date',t=>{
 const {store:s}=setup(t);const first=meal(s,'synthetic-history-first',20,'合成南瓜包子六个',undefined,100),second=meal(s,'synthetic-history-second',21,'合成南瓜包子八个',undefined,150),future=meal(s,'synthetic-history-future',22,'合成南瓜包子十个',['合成大份包点'],300);
 assert.deepEqual(s.commonDishes(new Date('2026-10-20T23:00:00+08:00')),[]);const old=s.commonDishes(new Date('2026-10-21T23:00:00+08:00'))[0];assert.equal(old.latestRecordId,second.id);assert.deepEqual(old.macros,second.analysis!.macros);assert.deepEqual(new Set(old.recordIds),new Set([first.id,second.id]));assert.ok(!old.recordIds.includes(future.id));assert.equal(s.commonDishes()[0].latestRecordId,future.id);
});

test('dish ingredients stay nested while questions or a new followup await analysis',t=>{
 const {store:s}=setup(t),{first,second}=pair(s);
 const next=s.applyAnalysis(second.id,{...second.analysis,questions:['这一餐有没有剩下？']},'chatgpt',second.revision);
 assert.equal(s.commonDishes().length,1);assert.ok(s.commonDishes()[0].recordIds.includes(next.id));assert.deepEqual(s.foodCandidates(false),[]);
 s.revise(next.id,{followup:{answer:'吃完了，辅菜量比较少',questions:next.analysis!.questions}},next.revision);
 const dish=s.commonDishes()[0];assert.ok(dish.recordIds.includes(second.id));assert.equal(dish.latestRecordId,first.id);assert.deepEqual(s.foodCandidates(false),[]);
});

test('optional dish brands survive edits, both backup formats and restart without changing meal estimates',t=>{
 const state=setup(t),s=state.store;pair(s);const before=JSON.stringify(s.records()),id=s.commonDishes()[0].id;
 s.saveDish({id,brand:'  合成甲店  '});assert.equal(s.commonDishes()[0].brand,'合成甲店');
 s.saveDish({id,active:false});assert.equal(s.commonDishes()[0].brand,'合成甲店');s.saveDish({id,active:true});
 const bundle=s.exportBundle(),definitions=s.dishDefinitions();s.saveDish({id,brand:''});assert.equal(s.commonDishes()[0].brand,undefined);
 s.restore(bundle);assert.deepEqual(s.dishDefinitions(),definitions);assert.equal(s.commonDishes()[0].brand,'合成甲店');
 const backupRoot=mkdtempSync(path.join(tmpdir(),'dish-brand-backup-'));t.after(()=>rmSync(backupRoot,{recursive:true,force:true}));const file=path.join(backupRoot,'brand.bodyjournal');
 s.backup(file);s.saveDish({id,brand:'合成乙店'});s.restoreFile(file);assert.equal(s.commonDishes()[0].brand,'合成甲店');
 assert.equal(JSON.stringify(s.records()),before);s.close();state.store=new HealthStore(state.root,new FoodCatalog([]),state.root+'/inbox',false);
 assert.equal(state.store.commonDishes()[0].brand,'合成甲店');state.store.saveDish({id,brand:''});assert.equal(state.store.commonDishes()[0].brand,undefined);
 assert.throws(()=>state.store.saveDish({id,brand:'长'.repeat(101)}));assert.equal(state.store.commonDishes()[0].brand,undefined);
});

test('same-named meals may belong to different brands and remain separate',t=>{
 const {store:s}=setup(t),first=meal(s,'brand-a-meal',20,'合成鸡肉饭'),second=meal(s,'brand-b-meal',21,'合成鸡肉饭'),before=JSON.stringify(s.records());
 const a=s.saveDish({name:'合成鸡肉饭',brand:'合成甲店',aliases:[],recordIds:[first.id]}),b=s.saveDish({name:'合成鸡肉饭',brand:'合成乙店',aliases:[],recordIds:[second.id]});
 assert.notEqual(a.id,b.id);assert.equal(s.commonDishes().length,2);assert.deepEqual(s.commonDishes().find(d=>d.id===a.id)!.recordIds,[first.id]);assert.deepEqual(s.commonDishes().find(d=>d.id===b.id)!.recordIds,[second.id]);
 assert.throws(()=>s.saveDish({id:b.id,brand:'合成甲店'}),/多个分组/);assert.equal(JSON.stringify(s.records()),before);
});

test('recurring pots with ingredient and serving descriptions become common dishes without changing meal nutrition',t=>{
 const {store:s}=setup(t);
 const first=meal(s,'synthetic-recurring-pot-first',20,'合成麻辣香锅，一碗米饭，有青菜和鸡肉',['合成青菜','合成鸡肉'],100);
 const second=meal(s,'synthetic-recurring-pot-second',21,'合成麻辣香锅，按称一斤，有蔬菜、鹌鹑蛋、鸡胸肉，加一碗米饭',['合成蔬菜','合成鹌鹑蛋','合成鸡胸肉'],160),before=JSON.stringify(s.records());
 const dishes=s.commonDishes();assert.equal(dishes.length,1);assert.equal(dishes[0].name,'合成麻辣香锅');assert.equal(dishes[0].days,2);assert.deepEqual(dishes[0].recordIds,[first.id,second.id]);assert.deepEqual(dishes[0].template,second.analysis!.ingredients);assert.deepEqual(dishes[0].macros,second.analysis!.macros);assert.deepEqual(s.foodCandidates(false),[]);assert.equal(JSON.stringify(s.records()),before);
});

test('dish components shared by unrelated meals do not return as standalone food suggestions',t=>{
 const {store:s}=setup(t);
 meal(s,'shared-dish-1',20,'合成甲店鸡排荞麦面',['合成玉米粒（熟）']);
 meal(s,'shared-dish-2',21,'合成甲店鸡排荞麦面',['合成玉米粒（熟）']);
 for(const [id,day,title] of [['shared-side-1',22,'合成乙店牛肉碗'],['shared-side-2',23,'依旧合成蔬菜拼盘']] as const){
  const r=meal(s,id,day,title,['合成玉米粒（熟）']);
  s.applyAnalysis(id,{...r.analysis,ingredients:r.analysis!.ingredients!.map(i=>({...i,role:'component',compositionGroup:'synthetic-sides'}))},'chatgpt',r.revision);
 }
 const state=()=>JSON.stringify([s.records(),s.memories(),s.dishDefinitions(),s.ignoredFoodCandidates()]),before=state();
 assert.equal(s.commonDishes().length,1);assert.equal(s.foodCandidates().find(c=>c.name==='合成玉米粒（熟）')!.meals,4);
 assert.deepEqual(s.foodCandidates(false),[]);
 assert.equal(state(),before);
});

test('standalone suggestions count independent uses rather than components from other meals',t=>{
 const {store:s}=setup(t);
 const names=['合成零食','合成配菜','合成烹调油','合成旧配菜','合成重复拆分'];
 for(const [id,day,title] of [['independent-first',20,'合成甲店便当'],['independent-second',21,'合成乙店沙拉']] as const){
  const r=meal(s,id,day,title,names);
  s.applyAnalysis(id,{...r.analysis,ingredients:r.analysis!.ingredients!.map((i,index)=>({...i,...(index===0?{role:'whole_dish' as const,compositionGroup:'synthetic-duplicate'}:index===1?{role:'component' as const}:index===2?{role:'added_fat' as const}:index===3?{compositionGroup:'synthetic-legacy-dish'}:{role:'component' as const,compositionGroup:'synthetic-duplicate'})}))},'chatgpt',r.revision);
 }
 // One independent serving must not combine with two component uses to reach the threshold.
 const side=meal(s,'independent-once',22,'单独吃合成配菜',['合成配菜']);
 s.applyAnalysis(side.id,{...side.analysis,ingredients:side.analysis!.ingredients!.map(i=>({...i,role:'whole_dish'}))},'chatgpt',side.revision);
 assert.deepEqual(s.foodCandidates(false).map(c=>[c.name,c.meals]),[['合成零食',2]]);
});

test('legacy component names remain owned by a common dish after its latest ingredients change or it is archived',t=>{
 const state=setup(t),s=state.store;
 meal(s,'legacy-dish-1',20,'合成甲店鸡肉面',['合成旧配菜']);
 meal(s,'legacy-dish-2',21,'合成甲店鸡肉面',['合成新配菜']);
 meal(s,'legacy-other-1',22,'合成乙店便当',['合成旧配菜']);
 meal(s,'legacy-other-2',23,'合成丙店沙拉',['合成旧配菜']);
 const dish=s.commonDishes()[0];assert.equal(dish.template[0].name,'合成新配菜');
 assert.deepEqual(s.foodCandidates(false),[]);
 s.saveDish({id:dish.id,active:false});assert.deepEqual(s.foodCandidates(false),[]);
 s.close();state.store=new HealthStore(state.root,new FoodCatalog([]),state.root+'/inbox',false);
 assert.deepEqual(state.store.foodCandidates(false),[]);
 assert.deepEqual(state.store.ignoredFoodCandidates(),[]);
});
