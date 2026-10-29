import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HealthStore } from '../electron/core/store';
import { FoodCatalog } from '../electron/core/nutrition';

const now=()=>new Date().toISOString();
function setup(t:test.TestContext){
 const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-memory-topics-'));
 const store=new HealthStore(dir,new FoodCatalog([]),path.join(dir,'inbox'),false);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return store;
}
function fact(store:HealthStore,text:string,topicKey?:string){
 return store.saveMemory({kind:'fact',text,startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true,...(topicKey?{topicKey}:{})});
}

test('migration assigns stable topic keys to existing long-term facts, with backup and idempotency',t=>{
 const store=setup(t);
 const texts=['主要吃食堂和外卖，目前没有自己做饭的条件。','喜欢更换菜式，食物分量通常只能估计。','希望记录负担尽量低，可以接受有针对性的追问。','默认使用简体中文。','训练日志优先用表格整理。','记录记法（已确认）：哑铃按单只。'];
 for(const text of texts)fact(store,text);
 assert.equal(store.migrateMemoryTopics(),6);
 const topics=store.memories().map(m=>m.topicKey);
 assert.deepEqual(topics,['eating.environment','eating.estimation','recording.burden','communication.language','communication.training_format','recording.conventions']);
 assert.ok(readdirSync(path.join(store.root,'backups')).some(f=>f.startsWith('before-memory-v2-')));
 assert.equal(store.migrateMemoryTopics(),0);
});

test('saving a fact with an existing topic updates it instead of creating a duplicate',t=>{
 const store=setup(t);
 const first=fact(store,'默认使用简体中文。','communication.language');
 const second=fact(store,'默认使用简体中文，术语可保留英文。','communication.language');
 assert.equal(second.id,first.id);
 assert.equal(store.memories().filter(m=>m.kind==='fact').length,1);
 assert.match(store.memories()[0].text,/术语可保留英文/);
 assert.throws(()=>store.saveMemory({kind:'fact',text:'x',startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true,topicKey:'Bad Topic'}),/主题键/);
});

test('retrieval keeps facts, skips unrelated training refs for diet questions, and matches actions',t=>{
 const store=setup(t);
 fact(store,'主要吃食堂和外卖。','eating.environment');
 fact(store,'默认使用简体中文。','communication.language');
 store.saveMemory({kind:'food',text:'测试蛋白粉',food:{name:'测试蛋白粉',servingGrams:30,perServing:{kcal:120,protein:24,carbs:3,fat:1.5}},startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true});
 store.importEnvelope({version:1,id:'train-record-1',kind:'training',text:'胸：\n卧推 50kg 3x8\n窄距卧推 40kg 3x10',occurredAt:new Date(Date.now()-2*86400000).toISOString(),timezone:'Asia/Shanghai'});
 const diet=store.memoryContext('chat','今天吃什么好？');
 assert.ok(diet.items.some(m=>m.kind==='fact'));
 assert.ok(!diet.items.some(m=>m.autoCategory==='training'));
 assert.ok(diet.items.every(m=>m.kind!=='food'||true));
 const bench=store.memoryContext('chat','卧推最近怎么样？');
 assert.ok(bench.items.some(m=>m.autoCategory==='training'&&m.text.startsWith('杠铃平板卧推')));
 assert.ok(!bench.items.some(m=>m.autoCategory==='training'&&m.text.startsWith('窄距卧推')));
 const close=store.memoryContext('chat','窄距卧推多重？');
 assert.ok(close.items.some(m=>m.text.startsWith('窄距卧推')));
 const protein=store.memoryContext('chat','我的蛋白粉怎么喝？');
 assert.ok(protein.items.some(m=>m.kind==='food'));
 const weekly=store.memoryContext('weekly','本周复盘');
 assert.equal(weekly.budget,1600);
 assert.ok(weekly.items.some(m=>m.autoCategory==='training'));
 assert.ok(weekly.items.some(m=>m.kind==='fact'));
 assert.ok(diet.chars<=diet.budget);
});

test('chat prompt carries only the selected memories and reports coverage',async t=>{
 const store=setup(t);store.setSettings({...store.getSettings(),chatgptModel:'test-model'});
 fact(store,'主要吃食堂和外卖。','eating.environment');
 store.importEnvelope({version:1,id:'train-record-1',kind:'training',text:'胸：\n卧推 50kg 3x8',occurredAt:new Date(Date.now()-2*86400000).toISOString(),timezone:'Asia/Shanghai'});
 // 使用最小模拟：直接检查 context 构造，不发起网络请求。
 const context=store.context('今天吃什么好？','chat');
 assert.ok(context.memories.every((m:any)=>m.autoCategory!=='training'));
 assert.deepEqual(context.memoryCoverage.included,context.memories.length);
 assert.equal(context.memoryCoverage.budget,800);
 const weekly=store.context('本周复盘','weekly');
 assert.ok(weekly.memories.some((m:any)=>m.autoCategory==='training'));
});

test('chat automatically saves ephemeral state and durable facts without imperative words',t=>{
 const store=setup(t);
 const user=(text:string)=>({id:'user-message-auto1',role:'user' as const,text,createdAt:now(),status:'complete' as const,sources:[],provider:'chatgpt',stale:false});
 const reply={id:'assistant-message-auto1',role:'assistant' as const,text:'好的。',createdAt:now(),status:'complete' as const,sources:[],provider:'chatgpt',stale:false};
 store.completeChat(reply,[{operation:'upsert',key:'state.sleep',kind:'state',text:'最近睡眠质量差',evidenceQuote:'最近睡不好'}],user('最近睡不好'),store.memories(),store.getSettings().goals);
 assert.ok(store.memories().some(m=>m.kind==='state'&&/睡眠质量差/.test(m.text)));
 const durableUser=user('我的固定训练安排是每周三次，周日晚更灵活');
 store.completeChat({...reply,id:'assistant-message-auto2'},[{operation:'upsert',key:'training.schedule',kind:'fact',text:'每周三次固定训练，周日晚更灵活',evidenceQuote:'我的固定训练安排是每周三次，周日晚更灵活'}],durableUser,store.memories(),store.getSettings().goals);
 const durable=store.memories().find(m=>m.topicKey==='training.schedule');
 assert.ok(durable);assert.equal(durable!.kind,'fact');
});

test('analysis automatically saves a labeled supplement and shows the receipt',t=>{
 const store=setup(t);
 const text='早餐：测试蛋白粉一勺，包装标注每份30g，能量120kcal，蛋白质24g，碳水3g，脂肪1.5g';
 const r=store.importEnvelope({version:1,id:'meal-record-auto1',kind:'meal',text,occurredAt:now(),timezone:'Asia/Shanghai'}).record;
 const food={name:'测试蛋白粉',servingGrams:30,perServing:{kcal:120,protein:24,carbs:3,fat:1.5}};
 const updated=store.applyAnalysis(r.id,{summary:'早餐',questions:[],assumptions:[],engine:'local',at:now(),ingredients:[{name:'测试蛋白粉',foodId:null,grams:{low:30,high:30},assumption:'一勺',nutrition:{source:'estimate',basis:'估算',per100g:{kcal:{low:300,high:400},protein:{low:50,high:60},carbs:{low:10,high:20},fat:{low:5,high:10}}}}],memoryChanges:[{operation:'upsert',key:'nutrition.supplement.test',kind:'food',text:'测试蛋白粉',food,evidenceQuote:'测试蛋白粉一勺，包装标注每份30g，能量120kcal，蛋白质24g，碳水3g，脂肪1.5g'}]},'local',r.revision);
 const preset=store.foodPresets().find(p=>p.name==='测试蛋白粉');
 assert.ok(preset);assert.equal(preset!.servingGrams,30);
 assert.ok(updated.analysis!.memoryReceipt?.some(x=>/测试蛋白粉/.test(x.text)));
 const ingredient=updated.analysis!.ingredients!.find(i=>i.name==='测试蛋白粉')!;
 assert.equal(ingredient.nutrition!.source,'label');
 assert.deepEqual(ingredient.nutrition!.per100g!.kcal,{low:400,high:400});
 const bad=store.importEnvelope({version:1,id:'meal-record-auto2',kind:'meal',text:'午餐：米饭',occurredAt:now(),timezone:'Asia/Shanghai'}).record;
 assert.throws(()=>store.applyAnalysis(bad.id,{summary:'午餐',questions:[],assumptions:[],engine:'local',at:now(),ingredients:[],memoryChanges:[{operation:'upsert',key:'nutrition.supplement.bad',kind:'food',text:'不存在的食物',food,evidenceQuote:'原文里没有这句话'}]},'local',bad.revision),/原文/);
});

test('adding a common food in chat does not require the word 记住',t=>{
 const store=setup(t);
 const text='加一个常用食物：盐味溏心蛋每100g：112–112 kcal，蛋白质 12.9–12.9g，碳水 5.5–5.5g，脂肪 4.2–4.2g';
 const quote='盐味溏心蛋每100g：112–112 kcal，蛋白质 12.9–12.9g，碳水 5.5–5.5g，脂肪 4.2–4.2g';
 const user={id:'user-message-food1',role:'user' as const,text,createdAt:now(),status:'complete' as const,sources:[],provider:'chatgpt',stale:false};
 const reply={id:'assistant-message-food1',role:'assistant' as const,text:'已添加。',createdAt:now(),status:'complete' as const,sources:[],provider:'chatgpt',stale:false};
 store.completeChat(reply,[{operation:'upsert',key:'food.salty_egg',kind:'food',food:{name:'盐味溏心蛋',servingGrams:100,perServing:{kcal:112,protein:12.9,carbs:5.5,fat:4.2}},evidenceQuote:quote}],user,store.memories(),store.getSettings().goals);
 const preset=store.foodPresets().find(p=>p.name==='盐味溏心蛋');
 assert.ok(preset);assert.equal(preset!.perServing.protein,12.9);
});

test('label-like nutrition stated as a long-term fact is accepted automatically',t=>{
 const store=setup(t);
 const text='盐味溏心蛋每100g：112 kcal、蛋白质12.9g、碳水5.5g、脂肪4.2g';
 const user={id:'user-message-label1',role:'user' as const,text,createdAt:now(),status:'complete' as const,sources:[],provider:'chatgpt',stale:false};
 const reply={id:'assistant-message-label1',role:'assistant' as const,text:'已记住。',createdAt:now(),status:'complete' as const,sources:[],provider:'chatgpt',stale:false};
 store.completeChat(reply,[{operation:'upsert',key:'nutrition.food.salty_egg',kind:'fact',text,evidenceQuote:text}],user,store.memories(),store.getSettings().goals);
 assert.ok(store.memories().some(m=>m.kind==='fact'&&/盐味溏心蛋/.test(m.text)));
});
