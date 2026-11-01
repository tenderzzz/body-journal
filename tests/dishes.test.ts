import test from 'node:test';
import assert from 'node:assert/strict';
import {dishIdentityKey,dishNameInfo,dishRecordKey,groupDishRecords,matchDish,primaryDishName,stableDishId} from '../src/shared/dishes';
import type {HealthRecord} from '../src/shared/types';

function record(id:string,text:string,day='20'):HealthRecord{return {id,kind:'meal',text,occurredAt:`2026-10-${day}T12:00:00+08:00`,timezone:'Asia/Shanghai',attachments:[],body:null,analysis:{summary:'合成估算',questions:[],assumptions:[],engine:'local',at:'2026-10-20T04:00:00Z',ingredients:[],macros:{kcal:{low:300,high:500},protein:{low:15,high:25},carbs:{low:30,high:50},fat:{low:10,high:20}}},status:'ready',revision:1,createdAt:'2026-10-20T04:00:00Z',updatedAt:'2026-10-20T04:00:00Z',deleted:false,source:'synthetic fixture'};}

test('named dishes ignore count/completion and merchant punctuation, but not recipe identity',()=>{
 assert.equal(primaryDishName('合成餐牌，香菇云吞10个\n\n补充：全部吃完'), '合成餐牌,香菇云吞');
 assert.equal(dishIdentityKey(primaryDishName('合成餐牌香菇云吞十个')!),dishIdentityKey(primaryDishName('合成餐牌，香菇云吞10个')!));
 assert.equal(primaryDishName('午餐：一份合成鸡肉面（全部吃完）'),'合成鸡肉面');
 assert.equal(stableDishId(primaryDishName('合成云吞10个(原味)')!),stableDishId(primaryDishName('合成云吞十个(原味)')!));
 assert.notEqual(stableDishId('合成云吞（原味）'),stableDishId('合成云吞（麻辣味）'));
 assert.notEqual(stableDishId('甲餐牌云吞'),stableDishId('乙餐牌云吞'));
 assert.notEqual(stableDishId('合成鸡排面（去皮）'),stableDishId('合成鸡排面（带皮）'));
 assert.notEqual(stableDishId('合成谷物饭（六种谷物）'),stableDishId('合成谷物饭（三种谷物）'));
 assert.equal(primaryDishName('三杯鸡'),'三杯鸡');
 assert.notEqual(stableDishId('合成饮品3.5%脂肪'),stableDishId('合成饮品35%脂肪'));
});

test('group identity comes from the named meal rather than ingredient decomposition',()=>{
 const a=record('synthetic-dish-a','合成餐牌，香菇云吞8个'),b=record('synthetic-dish-b','合成餐牌香菇云吞八个','22');
 a.analysis!.ingredients=[{name:'合成整道云吞',foodId:null,grams:{low:200,high:300},assumption:'合成数据'}];
 b.analysis!.ingredients=[{name:'合成面皮',foodId:null,grams:{low:100,high:150},assumption:'合成数据'},{name:'合成菌菇馅',foodId:null,grams:{low:100,high:150},assumption:'合成数据'}];
 b.analysis!.macros!.kcal={low:350,high:550};const before=JSON.stringify([a,b]),groups=groupDishRecords([b,a]);
 assert.equal(groups.length,1);assert.deepEqual(groups[0].records.map(r=>r.id),[a.id,b.id]);assert.deepEqual(groups[0].records.map(r=>r.analysis!.macros!.kcal),[{low:300,high:500},{low:350,high:550}]);assert.equal(JSON.stringify([a,b]),before);
});

test('explicit record bindings and exact aliases group user-confirmed variants only',()=>{
 const a=record('synthetic-alias-a','合成鸡排面（去皮）'),b=record('synthetic-alias-b','合成鸡排荞麦轻食（无皮）','23');
 const definitions=[{id:'dish-explicit',name:'合成鸡排荞麦轻食',aliases:['合成鸡排面（去皮）'],recordIds:[b.id]}];
 assert.equal(matchDish(a,definitions)?.id,'dish-explicit');assert.equal(matchDish(b,definitions)?.id,'dish-explicit');assert.equal(matchDish('合成鸡排面（带皮）',definitions),undefined);assert.equal(groupDishRecords([a,b],definitions).length,1);
 const ambiguous=[...definitions,{id:'dish-conflict',name:'另一个合成套餐',aliases:['合成鸡排面（去皮）']}];assert.equal(matchDish(a,ambiguous),undefined);assert.equal(groupDishRecords([a],ambiguous).length,0);
 assert.equal(matchDish(b,[{...definitions[0],active:false}])?.id,'dish-explicit');assert.equal(groupDishRecords([b],[{...definitions[0],active:false}])[0].id,'dish-explicit');
});

test('unclear meals, extras and generic ingredients do not become automatic named dishes',()=>{
 for(const text of ['午餐','和昨天一样','全部吃完','今天吃了一些面','米饭','乳清蛋白粉30g','合成鸡排面➕一杯黑咖','合成鸡排面，另加一个鸡蛋'])assert.equal(groupDishRecords([record('synthetic-unclear',text)]).length,0,text);
 assert.equal(dishNameInfo('合成鸡排面➕一杯黑咖')?.hasAdditions,true);
 const extra=record('synthetic-extra','合成鸡排面➕一杯黑咖');assert.equal(groupDishRecords([extra],[{id:'dish-bundle',name:'合成午餐组合',recordIds:[extra.id]}]).length,1);
 assert.equal(groupDishRecords([{...extra,deleted:true}],[{id:'dish-bundle',name:'合成午餐组合',recordIds:[extra.id]}]).length,0);
});


test('record bindings expire when the food identity changes, but not when only count changes',()=>{
 const original=record('synthetic-bound-record','合成餐牌鲜菌云吞8个');
 const definition={id:'dish-bound',name:'合成鲜菌云吞',aliases:[],recordIds:[original.id],recordKeys:{[original.id]:dishRecordKey(original)}};
 assert.match(stableDishId('合成鲜菌云吞'),/^dish-[a-f0-9]{16}$/);
 assert.equal(matchDish(original,[definition])?.id,definition.id);
 const resized={...original,text:'合成餐牌鲜菌云吞十二个'};assert.equal(dishRecordKey(resized),dishRecordKey(original));assert.equal(matchDish(resized,[definition])?.id,definition.id);
 const replaced={...original,text:'合成餐牌咖喱鸡饭'};assert.notEqual(dishRecordKey(replaced),dishRecordKey(original));assert.equal(matchDish(replaced,[definition]),undefined);assert.notEqual(groupDishRecords([replaced],[definition])[0]?.id,definition.id);
 const blank={...original,text:''};assert.equal(matchDish(blank,[definition]),undefined);
 // An explicitly accepted alias can still match after the original binding expires.
 assert.equal(matchDish(replaced,[{...definition,aliases:['合成餐牌咖喱鸡饭']}])?.id,definition.id);
});

test('a known first-lane hash collision cannot merge distinct named dishes',()=>{
 const first='costarring饭',second='liquid饭',a=stableDishId(first),b=stableDishId(second);
 assert.equal(a.slice(5,13),b.slice(5,13));assert.notEqual(a,b);
 const groups=groupDishRecords([record('synthetic-hash-a',first),record('synthetic-hash-b',second)]);assert.equal(groups.length,2);
});
