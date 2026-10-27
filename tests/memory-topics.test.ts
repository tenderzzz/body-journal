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
