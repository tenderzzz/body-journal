import test from 'node:test';
import assert from 'node:assert/strict';
import {dishIdentityKey,dishNameInfo,dishRecordKey,groupDishRecords,matchDish,primaryDishName,stableDishId,dishAliasKey} from '../src/shared/dishes';
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

test('natural wrappers, reordered preparation notes and small spelling differences reuse a dish',()=>{
 const definitions=[{id:'dish-natural',name:'合成香煎鸡排荞麦面轻食',aliases:['合成香煎鸡排荞麦面轻食（淋了沙拉酱，鸡排没有鸡皮）']}];
 for(const text of ['依旧是合成香煎鸡排荞麦面轻食（鸡排没有皮，淋沙拉酱）','今天午餐吃了合成香煎鸡排荞麦面轻食一份（照常）','合成香煎鸡扒荞麦面轻食（感觉之前估计的分量有点多，辅菜不多）'])assert.equal(matchDish(text,definitions)?.id,'dish-natural',text);
 const records=[record('natural-a',definitions[0].aliases[0]),record('natural-b','依旧是合成香煎鸡排荞麦面轻食（鸡排没有皮，淋沙拉酱）','21'),record('natural-c','合成香煎鸡扒荞麦面轻食（照常）','22')];
 assert.equal(groupDishRecords(records).length,1);
});

test('tolerant matches preserve conflicting recipes, merchants and ambiguity',()=>{
 const definitions=[{id:'dish-shrimp',name:'合成甲餐牌鲜虾蟹籽云吞（原味）',aliases:[]}];
 assert.equal(matchDish('合成甲餐牌鲜虾蟹子馄饨十个（只有醋）',definitions)?.id,'dish-shrimp');
 for(const text of ['合成乙餐牌鲜虾蟹籽云吞（原味）','合成甲餐牌鲜肉蟹籽云吞（原味）','合成甲餐牌鲜虾蟹籽云吞（麻辣味）'])assert.equal(matchDish(text,definitions),undefined,text);
 for(const [a,b] of [['合成鸡肉面（另加鸡蛋）','合成鸡肉面'],['合成鸡肉面（原味）','合成鸡肉面（酸菜味）'],['合成香煎鸡胸面','合成香煎鸡腿面']])assert.equal(matchDish(a,[{id:'different',name:b}]),undefined,a);
 assert.equal(matchDish('合成香煎鸡扒荞麦面',[{id:'a',name:'合成香煎鸡排荞麦面'},{id:'b',name:'合成香煎鸡扒荞麦面（少酱）'}])?.id,'b');
 assert.equal(matchDish('合成香煎鸡扒荞麦面',[{id:'a',name:'合成香煎鸡排荞麦面（去皮）'},{id:'b',name:'合成香煎鸡排荞麦面（带皮）'}]),undefined);
});

test('brand tags disambiguate named meals and preserve unknown-brand ambiguity',()=>{
 const definitions=[{id:'brand-a',name:'合成鸡肉面',brand:'合成甲店'},{id:'brand-b',name:'合成鸡肉面',brand:'合成乙店'}];
 assert.equal(matchDish('合成甲店 合成鸡肉面一份',definitions)?.id,'brand-a');
 assert.equal(matchDish('合成乙店的合成鸡肉面（照常）',definitions)?.id,'brand-b');
 assert.equal(matchDish('合成鸡肉面',definitions),undefined);assert.equal(matchDish('合成甲店和合成乙店的合成鸡肉面',definitions),undefined);
 assert.equal(matchDish('合成丙店 合成鸡肉面',definitions),undefined);
 const prefix=[{id:'short',name:'合成鸡肉面',brand:'合成甲店'},{id:'long',name:'合成鸡肉面',brand:'合成甲店精选'}];
 assert.equal(matchDish('合成甲店精选 合成鸡肉面',prefix)?.id,'long');
 assert.notEqual(stableDishId('合成鸡肉面','合成甲店'),stableDishId('合成鸡肉面','合成乙店'));
});

test('named pots group by dish title while portions, ingredient lists and accompanying rice vary',()=>{
 const texts=[
  '合成麻辣香锅，一碗米饭，生菜娃娃菜，还有几个鹌鹑蛋和鸡肉，按斤称重',
  '合成麻辣香锅，按称一斤，有蔬菜若干，5个鹌鹑蛋，鸡胸肉，加一碗米饭',
  '合成麻辣香锅，有蔬菜、豆腐，米饭只吃一半',
  '合成麻辣香锅',
 ];
 for(const text of texts)assert.equal(primaryDishName(text),'合成麻辣香锅',text);
 const records=texts.map((text,index)=>record(`synthetic-pot-${index}`,text,String(20+index))),before=JSON.stringify(records);
 const groups=groupDishRecords(records);assert.equal(groups.length,1);assert.equal(groups[0].name,'合成麻辣香锅');assert.equal(groups[0].records.length,4);assert.equal(JSON.stringify(records),before);
 assert.equal(primaryDishName('合成鸡肉饭，分量约300g，配菜是蔬菜'),'合成鸡肉饭');
 assert.equal(matchDish(texts[1],[{id:'pot-template',name:'合成麻辣香锅'}])?.id,'pot-template');
});

test('dish-title extraction preserves merchants, unrelated extras and explicit record binding keys',()=>{
 assert.equal(primaryDishName('合成甲餐牌，鲜虾云吞十个'),'合成甲餐牌,鲜虾云吞');
 for(const text of ['合成麻辣香锅，另加一杯奶茶','合成麻辣香锅，有蔬菜，另加一个鸡蛋','合成麻辣香锅➕一杯咖啡'])assert.equal(groupDishRecords([record('synthetic-pot-extra',text)]).length,0,text);
 const oldText='合成麻辣香锅，一碗米饭，生菜和鸡肉';
 assert.equal(dishRecordKey(oldText),stableDishId(oldText.normalize('NFKC')));
 assert.notEqual(dishAliasKey('合成香锅，有青菜和鸡肉'),dishAliasKey('合成香锅，有豆腐和牛肉'));
 assert.notEqual(primaryDishName('合成云吞，含鲜虾馅'),primaryDishName('合成云吞，含鲜肉馅'));
 const definitions=[{id:'bound-pot',name:'合成已确认午餐',recordIds:['synthetic-old-binding'],recordKeys:{'synthetic-old-binding':stableDishId(oldText.normalize('NFKC'))}}];
 assert.equal(matchDish(record('synthetic-old-binding',oldText),definitions)?.id,'bound-pot');
 const a=record('synthetic-pot-merchant-a','合成甲餐牌麻辣香锅，有蔬菜，加一碗米饭'),b=record('synthetic-pot-merchant-b','合成乙餐牌麻辣香锅，有蔬菜，加一碗米饭','21');assert.equal(groupDishRecords([a,b]).length,2);
});

test('a trailing light-meal category matches the same named dish in both directions and retains recipe and merchant distinctions',()=>{
 const base='香煎鸡排荞麦面',labelled=base+'轻食';
 for(const [name,text] of [[labelled,base],[base,labelled],[labelled+'（鸡排没有皮）','晚餐：一份'+base+'（无皮）']] as const){
  assert.equal(matchDish(text,[{id:'same-light-meal',name}])?.id,'same-light-meal');
 }
 const records=[record('light-meal-labelled',labelled,'20'),record('light-meal-short',base,'21')];
 const before=JSON.stringify(records),groups=groupDishRecords(records);
 assert.equal(groups.length,1);assert.deepEqual(groups[0].records.map(r=>r.id),records.map(r=>r.id));
 assert.equal(JSON.stringify(records),before);
 assert.equal(dishRecordKey(records[0]),stableDishId(labelled));
 assert.equal(dishAliasKey(labelled),dishIdentityKey(labelled));
 for(const different of ['香煎鸡腿荞麦面轻食','香煎鸡排荞麦面低脂轻食','香煎鸡排荞麦面轻食（另加鸡蛋）'])
  assert.equal(matchDish(different,[{id:'same-light-meal',name:base}]),undefined,different);
 assert.equal(matchDish(base+'轻食（带皮）',[{id:'skinless-light-meal',name:base+'（去皮）'}]),undefined);
 const brands=[{id:'brand-a',name:base,brand:'合成甲店'},{id:'brand-b',name:labelled,brand:'合成乙店'}];
 assert.equal(matchDish('合成甲店 '+labelled,brands)?.id,'brand-a');
 assert.equal(matchDish('合成乙店 '+base,brands)?.id,'brand-b');
 assert.equal(matchDish(base+'轻食（照常）',brands),undefined);
});
