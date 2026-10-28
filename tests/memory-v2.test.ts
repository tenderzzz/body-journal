import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HealthStore } from '../electron/core/store';
import { FoodCatalog } from '../electron/core/nutrition';
import { AssistantService } from '../electron/ai/service';
import type { ChatGPTAuth, SecretStorage } from '../electron/ai/auth';
import type { Analysis } from '../src/shared/types';
import { matchFoodPreset } from '../src/shared/food';

const now=()=>new Date().toISOString();
const preset=(over:Record<string,unknown>={})=>({name:'测试蛋白粉',brand:'ExampleWhey 巧克力味',servingGrams:30,perServing:{kcal:120,protein:24,carbs:3,fat:1.5},...over});
function setup(t:test.TestContext){
 const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-memory2-'));
 const store=new HealthStore(dir,new FoodCatalog([]),path.join(dir,'inbox'),false);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return store;
}
function meal(store:HealthStore,text:string,occurredAt='2026-10-20T12:00:00+08:00'){return store.importEnvelope({version:1,id:randomUUID(),kind:'meal',text,occurredAt,timezone:'Asia/Shanghai'}).record;}
function analyzed(store:HealthStore,id:string,ingredients:Analysis['ingredients'],revision:number){
 return store.applyAnalysis(id,{summary:'测试餐食',questions:[],assumptions:[],engine:'local',at:now(),ingredients},'local',revision);
}
function service(store:HealthStore){const auth={accessToken:async()=>'token'} as ChatGPTAuth,secrets:SecretStorage={read:async()=>({}),write:async()=>{}};return new AssistantService(store,auth,secrets,()=>{});}
function sse(output:unknown,usage={input_tokens:10,output_tokens:10}){const events=[{type:'response.output_text.delta',delta:JSON.stringify(output)},{type:'response.completed',response:{usage}}];const text=events.map(e=>`data: ${JSON.stringify(e)}\r\n\r\n`).join('');const data=new TextEncoder().encode(text);return new Response(new ReadableStream({start(c){c.enqueue(data);c.close();}}));}

test('common food presets are stored once and cannot silently duplicate',t=>{
 const store=setup(t);
 const saved=store.saveMemory({kind:'food',text:'测试蛋白粉',food:preset(),startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true});
 assert.equal(saved.kind,'food');
 assert.equal(store.foodPresets().length,1);
 assert.throws(()=>store.saveMemory({kind:'food',text:'另一条',food:preset(),startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true}),/同名/);
 const manual={kind:'fact' as const,text:'我不吃香菜',startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true};
 store.saveMemory(manual);
 assert.throws(()=>store.saveMemory(manual),/相同内容/);
});

test('meal analysis uses the label nutrition of a known supplement instead of model estimates',t=>{
 const store=setup(t);
 store.saveMemory({kind:'food',text:'测试蛋白粉',food:preset(),startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true});
 const r=meal(store,'训练后：测试蛋白粉一勺，加牛奶200ml');
 const updated=analyzed(store,r.id,[{name:'测试蛋白粉',foodId:null,grams:{low:30,high:30},assumption:'一勺',nutrition:{source:'estimate',basis:'模型猜测',per100g:{kcal:{low:300,high:400},protein:{low:50,high:60},carbs:{low:10,high:20},fat:{low:5,high:10}}}},{name:'牛奶',foodId:null,grams:{low:200,high:200},assumption:'一杯',nutrition:{source:'estimate',basis:'估算',per100g:{kcal:{low:60,high:70},protein:{low:3,high:4},carbs:{low:4,high:5},fat:{low:3,high:4}}}}],r.revision);
 const powder=updated.analysis!.ingredients!.find(i=>i.name==='测试蛋白粉')!;
 assert.equal(powder.nutrition!.source,'label');
 assert.deepEqual(powder.nutrition!.per100g.kcal,{low:400,high:400});
 assert.deepEqual(powder.nutrition!.per100g.protein,{low:80,high:80});
 assert.match(powder.nutrition!.basis,/个人常用食物/);
 assert.ok(updated.analysis!.assumptions.some(a=>a.includes('常用食物“测试蛋白粉”')));
 assert.deepEqual(updated.analysis!.macros!.protein,{low:30,high:32});
});

test('chat can remember a supplement from explicit label numbers, and rejects invented numbers',async t=>{
 const store=setup(t);store.setSettings({...store.getSettings(),chatgptModel:'test-model'});const svc=service(store);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const quote='记住我的蛋白粉是测试蛋白粉，每份30g，能量120kcal，蛋白质24g，碳水3g，脂肪1.5g';
 globalThis.fetch=async()=>sse({answerMarkdown:'已记住。',memoryChanges:[{operation:'upsert',key:'supplement.whey',kind:'food',food:preset(),evidenceQuote:quote}]});
 await svc.chat(quote);
 const foods=store.memories().filter(m=>m.kind==='food');
 assert.equal(foods.length,1);assert.equal(foods[0].food!.servingGrams,30);assert.match(foods[0].text!,/测试蛋白粉/);
 const bad=quote; // 模型声称 999kcal，但原话里没有这个数字
 globalThis.fetch=async()=>sse({answerMarkdown:'已记住。',memoryChanges:[{operation:'upsert',key:'supplement.whey',kind:'food',food:preset({perServing:{kcal:999,protein:24,carbs:3,fat:1.5}}),evidenceQuote:bad}]});
 await assert.rejects(()=>svc.chat(bad),/原话/);
 assert.equal(store.memories().filter(m=>m.kind==='food').length,1);
});

test('repeated ingredients become candidates only, are excluded once saved, and brands match labels',t=>{
 const store=setup(t);
 const presetFood={name:'测试蛋白粉',brand:'ExampleWhey 巧克力味',servingGrams:100,perServing:{kcal:380,protein:80,carbs:6,fat:3}};
 assert.ok(matchFoodPreset([presetFood],'ExampleWhey 巧克力味'));
 assert.ok(matchFoodPreset([presetFood],'测试蛋白粉'));
 const add=(date:string,text:string,name:string,source:'label'|'estimate')=>{const r=meal(store,text,date);return analyzed(store,r.id,[{name,foodId:null,grams:{low:100,high:120},assumption:'一份',nutrition:{source,basis:'测试',per100g:{kcal:{low:280,high:300},protein:{low:15,high:16},carbs:{low:20,high:22},fat:{low:14,high:16}}}}],r.revision);};
 add('2026-10-20T12:00:00+08:00','午餐：测试三明治','测试三明治','estimate');
 add('2026-10-21T12:00:00+08:00','午餐：测试三明治','测试三明治','estimate');
 add('2026-10-22T12:00:00+08:00','午餐：白米饭','白米饭（熟）','label');
 add('2026-10-23T12:00:00+08:00','午餐：白米饭','白米饭（熟）','label');
 const candidates=store.foodCandidates();
 assert.equal(candidates.length,2);
 const bun=candidates.find(c=>c.name==='测试三明治')!;
 assert.equal(bun.meals,2);assert.equal(bun.days,2);assert.equal(bun.source,'estimate');assert.deepEqual(bun.latestGrams,{low:100,high:120});
 const rice=candidates.find(c=>c.name==='白米饭（熟）')!;
 assert.equal(rice.source,'label');
 store.saveMemory({kind:'food',text:'测试三明治',food:{name:'测试三明治',servingGrams:110,perServing:{kcal:319,protein:17.1,carbs:23.1,fat:16.5}},startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true});
 assert.ok(!store.foodCandidates().some(c=>c.name==='测试三明治'));
 store.ignoreFoodCandidate('白米饭（熟）');
 assert.ok(!store.foodCandidates().some(c=>c.name==='白米饭（熟）'));
 assert.deepEqual(store.ignoredFoodCandidates(),['白米饭（熟）']);
});

test('same meal copied from a past record keeps ingredients and recalculates locally',t=>{
 const store=setup(t);
 const source=meal(store,'食堂午餐：米饭、鸡肉和青菜','2026-10-20T12:00:00+08:00');
 const ingredients:Analysis['ingredients']=[{name:'米饭',foodId:null,grams:{low:150,high:200},assumption:'一碗',nutrition:{source:'estimate',basis:'估算',per100g:{kcal:{low:116,high:116},protein:{low:2.6,high:2.6},carbs:{low:25.9,high:25.9},fat:{low:0.3,high:0.3}}}},{name:'鸡肉',foodId:null,grams:{low:100,high:120},assumption:'一份',nutrition:{source:'estimate',basis:'估算',per100g:{kcal:{low:165,high:165},protein:{low:31,high:31},carbs:{low:0,high:0},fat:{low:3.6,high:3.6}}}}];
 const sourceDone=analyzed(store,source.id,ingredients,source.revision);
 const target=meal(store,'午餐和 10 月 20 日那天一样','2026-10-22T12:00:00+08:00');
 const copied=store.applyAnalysis(target.id,{summary:'按历史记录复制',questions:[],assumptions:[],engine:'chatgpt',at:now(),copyFromRecordId:source.id,ingredients:[{name:'模型编的',foodId:null,grams:{low:1,high:1},assumption:'不该采用'}]},'chatgpt',target.revision);
 assert.deepEqual(copied.analysis!.ingredients!.map(i=>[i.name,i.grams.low,i.grams.high]),ingredients.map(i=>[i.name,i.grams.low,i.grams.high]));
 assert.deepEqual(copied.analysis!.macros,sourceDone.analysis!.macros);
 assert.equal(copied.analysis!.copiedFrom!.recordId,source.id);
 assert.match(copied.analysis!.copiedFrom!.label,/2026-10-20 午餐/);
 assert.ok(copied.analysis!.ingredients!.every(i=>i.assumption.includes('复制自')));
 assert.equal(store.record(source.id).revision,sourceDone.revision);
 assert.throws(()=>store.applyAnalysis(target.id,{summary:'x',questions:[],assumptions:[],engine:'local',at:now(),copyFromRecordId:'missing-record-id'},'local',copied.revision),/引用/);
 const training=store.importEnvelope({version:1,id:randomUUID(),kind:'training',text:'胸：\n卧推 50kg 3x8',occurredAt:'2026-10-21T19:00:00+08:00',timezone:'Asia/Shanghai'}).record;
 assert.throws(()=>store.applyAnalysis(target.id,{summary:'x',questions:[],assumptions:[],engine:'local',at:now(),copyFromRecordId:training.id},'local',copied.revision),/引用的那餐/);
});

function syntheticCopyIngredients():NonNullable<Analysis['ingredients']>{return [{name:'合成测试米饭',foodId:null,grams:{low:150,high:200},assumption:'合成测试分量',nutrition:{source:'estimate',basis:'合成测试营养',per100g:{kcal:{low:116,high:116},protein:{low:2.6,high:2.6},carbs:{low:25.9,high:25.9},fat:{low:0.3,high:0.3}}}}];}

test('copy-only meal model response copies ingredients and local nutrition without changing the source',async t=>{
 const store=setup(t);store.setSettings({...store.getSettings(),chatgptModel:'test-model'});
 const source=meal(store,'合成午餐：米饭','2026-10-20T12:00:00+08:00');
 const sourceDone=analyzed(store,source.id,syntheticCopyIngredients(),source.revision);
 const target=meal(store,'午餐和10月20日那餐一样','2026-10-22T12:00:00+08:00');
 const sourceBefore=store.record(source.id);
 const rawBefore=readFileSync(path.join(store.root,'raw',target.id+'.json'),'utf8');
 const svc=service(store),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>sse({copyFromRecordId:source.id});
 await svc.analyze([target.id]);
 const copied=store.record(target.id);
 assert.equal(copied.status,'ready');assert.ok(copied.analysis!.summary.trim());
 assert.equal(copied.text,target.text);assert.equal(copied.revision,target.revision+1);
 assert.equal(readFileSync(path.join(store.root,'raw',target.id+'.json'),'utf8'),rawBefore);
 assert.deepEqual(copied.analysis!.ingredients!.map(({name,grams,nutrition})=>({name,grams,nutrition})),sourceDone.analysis!.ingredients!.map(({name,grams,nutrition})=>({name,grams,nutrition})));
 assert.deepEqual(copied.analysis!.macros!.kcal,{low:174,high:232});
 assert.deepEqual(copied.analysis!.macros,sourceDone.analysis!.macros);
 assert.equal(copied.analysis!.copiedFrom!.recordId,source.id);
 assert.deepEqual(store.record(source.id),sourceBefore);
 store.saveMemory({kind:'food',text:'合成测试米饭当前标签',food:{name:'合成测试米饭',servingGrams:100,perServing:{kcal:200,protein:5,carbs:40,fat:2}},startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true});
 const newerTarget=meal(store,'午餐仍和10月20日那餐一样','2026-10-23T12:00:00+08:00');
 await svc.analyze([newerTarget.id]);
 const withCurrentLabel=store.record(newerTarget.id);
 assert.equal(withCurrentLabel.status,'ready');
 assert.deepEqual(withCurrentLabel.analysis!.ingredients![0].grams,sourceDone.analysis!.ingredients![0].grams);
 assert.equal(withCurrentLabel.analysis!.ingredients![0].nutrition!.source,'label');
 assert.deepEqual(withCurrentLabel.analysis!.ingredients![0].nutrition!.per100g.kcal,{low:200,high:200});
 assert.deepEqual(withCurrentLabel.analysis!.macros,{kcal:{low:300,high:400},protein:{low:7.5,high:10},carbs:{low:60,high:80},fat:{low:3,high:4}});
 assert.equal(withCurrentLabel.analysis!.copiedFrom!.recordId,source.id);
 assert.deepEqual(store.record(source.id),sourceBefore);
});

test('ordinary meal model response without summary remains rejected and leaves the target pending',async t=>{
 const store=setup(t);store.setSettings({...store.getSettings(),chatgptModel:'test-model'});
 const target=meal(store,'合成午餐：米饭'),svc=service(store),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const before=store.record(target.id);
 for(const summary of [undefined,null,42]){
  globalThis.fetch=async()=>sse({summary,ingredients:syntheticCopyIngredients(),questions:[],assumptions:[]});
  await assert.rejects(()=>svc.analyze([target.id]),error=>error instanceof Error&&/summary/.test(error.message));
  assert.deepEqual(store.record(target.id),before);assert.equal(store.history(target.id).length,0);assert.equal(target.status,'pending');
 }
});

test('invalid copy-only meal references are rejected without changing the pending target',async t=>{
 const store=setup(t);store.setSettings({...store.getSettings(),chatgptModel:'test-model'});
 const target=meal(store,'合成午餐：照旧'),unanalyzed=meal(store,'合成来源：未分析餐食');
 const removed=meal(store,'合成来源：已删除餐食');
 const removedDone=analyzed(store,removed.id,syntheticCopyIngredients(),removed.revision);store.revise(removed.id,{deleted:true},removedDone.revision);
 const training=store.importEnvelope({version:1,id:randomUUID(),kind:'training',text:'卧推50kg 3x8',occurredAt:'2026-10-20T19:00:00+08:00',timezone:'Asia/Shanghai'}).record;
 const svc=service(store),original=globalThis.fetch;let sourceId:unknown;t.after(()=>{globalThis.fetch=original;});
 const before=store.record(target.id);
 globalThis.fetch=async()=>sse({copyFromRecordId:sourceId});
 for(const [label,id] of [['malformed','bad?'],['missing','missing-record-id'],['self',target.id],['non-meal',training.id],['deleted',removed.id],['unanalyzed',unanalyzed.id]]){
  sourceId=id;await assert.rejects(()=>svc.analyze([target.id]));
  assert.deepEqual(store.record(target.id),before,label);assert.equal(store.history(target.id).length,0,label);
 }
});

test('chat conversation keeps more recent turns and recalls keyword-matched older ones',async t=>{
 const store=setup(t);store.setSettings({...store.getSettings(),chatgptModel:'test-model'});const svc=service(store);
 store.putMessage({id:randomUUID(),role:'user',text:'我买的是测试蛋白粉巧克力味',createdAt:new Date(Date.now()-1000*60*60*24*3).toISOString(),status:'complete',sources:[],provider:'chatgpt',stale:false});
 for(let i=0;i<25;i++)store.putMessage({id:randomUUID(),role:i%2?'assistant':'user',text:`普通对话 ${i}`,createdAt:new Date(Date.now()-1000*(30-i)).toISOString(),status:'complete',sources:[],provider:'chatgpt',stale:false});
 const original=globalThis.fetch;let content='';t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(_input,init)=>{const body=JSON.parse(String(init?.body));content=body.input[0].content[0].text;return sse({answerMarkdown:'好的。',memoryChanges:[]});};
 await svc.chat('蛋白粉还剩多少？');
 const payload=JSON.parse(content);
 assert.ok(payload.conversation.length>=20);
 assert.ok(payload.conversation.some((m:{text:string})=>m.text.includes('测试蛋白粉巧克力味')));
 assert.ok(!payload.conversation.some((m:{text:string})=>m.text==='普通对话 0'));
});

test('tidy removes stale auto memories, expired inferences, junk preferences and duplicates, with backup',t=>{
 const store=setup(t);
 const base={startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true};
 const put=(doc:Record<string,unknown>)=>store.db.prepare('INSERT INTO memories VALUES(?,?)').run(String(doc.id),JSON.stringify(doc));
 put({id:'stale-auto',kind:'habit',text:'旧训练参照',autoKey:'training:old',autoCategory:'training',stale:true,autoManaged:true,...base});
 put({id:'stale-state',kind:'state',text:'旧状态',stale:false,...base,expiresAt:new Date(Date.now()-86400000).toISOString()});
 put({id:'stale-hyp',kind:'hypothesis',text:'旧推断',stale:true,...base});
 put({id:'junk-pref',kind:'fact',text:'补充：单只哑铃重量、是的；自重',autoKey:'preference:x',autoCategory:'preference',stale:false,autoManaged:true,...base});
 put({id:'keep-fact',kind:'fact',text:'默认使用简体中文。',stale:false,...base});
 put({id:'dup-fact',kind:'fact',text:'默认使用 简体中文',stale:false,...base});
 put({id:'label-state',kind:'state',text:'用户提供的ExampleWhey 巧克力味营养标签：每100g能量1590kJ、蛋白质80.0g；仅适用于该产品。',stale:false,...base});
 put({id:'keep-state',kind:'state',text:'昨晚睡了8小时，今天状态不错。',stale:false,...base});
 store.saveMemory({kind:'food',text:'蛋白粉',food:{name:'测试蛋白粉',brand:'ExampleWhey 巧克力味',servingGrams:100,perServing:{kcal:380,protein:80,carbs:6,fat:3}},startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true});
 const result=store.tidyMemories();
 assert.equal(result.removed,5);
 assert.equal(result.deactivated,1);
 assert.equal(result.merged,1);
 assert.ok(readdirSync(path.join(store.root,'backups')).some(f=>f.startsWith('before-memory-tidy-')));
 assert.ok(!store.memories().some(m=>['stale-auto','stale-state','stale-hyp','junk-pref','dup-fact'].includes(m.id)));
 assert.equal(store.memories().find(m=>m.id==='label-state')!.active,false);
 assert.ok(store.memories().some(m=>m.id==='keep-fact')&&store.memories().some(m=>m.id==='keep-state'));
 const revisions=store.db.prepare("SELECT count(*) n FROM revisions WHERE entity='memory'").get()!;
 assert.ok(Number(revisions.n)>=6);
 assert.equal(store.tidyMemories().removed,0);
});

test('supplement and answer fragments are never stored as automatic preferences',t=>{
 const store=setup(t);
 store.importEnvelope({version:1,id:randomUUID(),kind:'meal',text:'早餐：鸡蛋\n补充：单只哑铃重量、是的；自重\n我习惯晚上训练',occurredAt:new Date(Date.now()-3600000).toISOString(),timezone:'Asia/Shanghai'});
 store.refreshAutomaticMemories();
 const prefs=store.memories().filter(m=>m.autoCategory==='preference');
 assert.equal(prefs.length,1);
 assert.match(prefs[0].text,/我习惯晚上训练/);
});

test('meal analysis prompt carries personal foods and recent meal history',async t=>{
 const store=setup(t);store.setSettings({...store.getSettings(),chatgptModel:'test-model',provider:'chatgpt'});
 store.saveMemory({kind:'food',text:'测试蛋白粉',food:preset(),startsAt:now(),expiresAt:null,sourceIds:[],active:true,confirmed:true});
 const old=meal(store,'10月20日午餐：米饭和鸡肉','2026-10-20T12:00:00+08:00');
 analyzed(store,old.id,[{name:'米饭',foodId:null,grams:{low:150,high:150},assumption:'一碗',nutrition:{source:'estimate',basis:'估算',per100g:{kcal:{low:116,high:116},protein:{low:2.6,high:2.6},carbs:{low:25.9,high:25.9},fat:{low:0.3,high:0.3}}}}],old.revision);
 const target=meal(store,'午餐和10月20日的午餐一样','2026-10-22T12:00:00+08:00');
 const svc=service(store);const original=globalThis.fetch;let content='',instructions='';t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(_input,init)=>{const body=JSON.parse(String(init?.body));content=body.input[0].content[0].text;instructions=body.instructions;return sse({summary:'按历史复制',questions:[],assumptions:[],engine:'chatgpt',at:now(),copyFromRecordId:old.id,ingredients:[]});};
 await svc.analyze([target.id]);
 const payload=JSON.parse(content);
 assert.ok(Array.isArray(payload.personalFoods)&&payload.personalFoods.some((f:{name:string})=>f.name==='测试蛋白粉'));
 assert.ok(Array.isArray(payload.mealHistory)&&payload.mealHistory.some((m:{id:string})=>m.id===old.id));
 assert.match(instructions,/copyFromRecordId/);
 const done=store.record(target.id);
 assert.deepEqual(done.analysis!.ingredients!.map(i=>i.name),['米饭']);
 assert.ok(done.analysis!.copiedFrom);
});
