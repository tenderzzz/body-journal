import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {AssistantService} from '../electron/ai/service';
import type {ChatGPTAuth} from '../electron/ai/auth';
const at=()=>new Date().toISOString();
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-model-compat-')),store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return store;}
function record(s:HealthStore){return s.importEnvelope({version:1,id:crypto.randomUUID(),kind:'training',occurredAt:at(),timezone:'Asia/Shanghai',text:'力量训练60分钟，已完成'}).record;}
const output=()=>({summary:'完成力量训练',training:{part:'chest',completion:'completed',durationMinutes:60,pain:null,recovery:null}});
test('model null pain and recovery mean unreported; unsupported attached operations never mutate memory or goals',t=>{
 const s=setup(t),r=record(s),m=s.saveMemory({kind:'fact',text:'原有偏好',startsAt:at(),expiresAt:null,sourceIds:[],active:true,confirmed:true}),goals=s.getSettings().goals;
 const result=s.applyAnalysis(r.id,{...output(),memoryChanges:[{operation:'delete',targetId:m.id,key:'profile.preference',text:'删除原有偏好',evidenceQuote:r.text}]},'chatgpt',r.revision);
 assert.equal(result.status,'ready');assert.equal(result.analysis?.training?.pain,undefined);assert.equal(result.analysis?.training?.recovery,undefined);assert.equal(result.analysis?.training?.durationMinutes,60);assert.ok(result.analysis?.memoryWarnings?.length);assert.deepEqual(s.memories().find(x=>x.id===m.id),JSON.parse(JSON.stringify(m)));assert.deepEqual(s.getSettings().goals,goals);
});
test('optional run nulls do not become zero, nullable food/weight fields keep their meaning',t=>{
 const s=setup(t),r=record(s);const result=s.applyAnalysis(r.id,{...output(),training:{...output().training,durationMinutes:null},run:{km:5,minutes:30,completion:'completed',activeKcal:null,totalKcal:null,sourceApp:null},sets:[{exercise:'自重俯卧撑',kg:null,reps:10,sets:3,loadBasis:'bodyweight',confirmed:true,effort:null,notes:null}]},'deepseek',r.revision);
 assert.equal(result.analysis?.run?.activeKcal,undefined);assert.equal(result.analysis?.run?.totalKcal,undefined);assert.equal(result.analysis?.sets?.[0].kg,null);assert.equal(result.analysis?.sets?.[0].notes,undefined);
});
test('manual inputs and required model fields remain strict',t=>{
 const s=setup(t),r=record(s);assert.throws(()=>s.applyAnalysis(r.id,output(),'local',r.revision));assert.throws(()=>s.applyAnalysis(r.id,{...output(),training:{...output().training,completion:null}},'chatgpt',r.revision));assert.equal(s.record(r.id).revision,r.revision);
});
test('valid model memory operations still require genuine evidence and remain atomic',t=>{
 const s=setup(t),r=record(s),before=s.memories();assert.throws(()=>s.applyAnalysis(r.id,{...output(),memoryChanges:[{operation:'upsert',key:'training.preference',kind:'fact',text:'我喜欢早晨训练',evidenceQuote:'并不存在的原话'}]},'chatgpt',r.revision),/原文/);assert.deepEqual(s.memories(),before);assert.equal(s.record(r.id).revision,r.revision);
});
test('chat retains a valid answer and shows a local notice for unsupported memory operation',async t=>{
 const s=setup(t);s.setSettings({...s.getSettings(),chatgptModel:'synthetic-model'});const goals=s.getSettings().goals,original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>new Response([{type:'response.output_text.delta',delta:JSON.stringify({answerMarkdown:'你好，今天可以先记下实际训练。',memoryChanges:[{operation:'setGoal',key:'goals.goal',text:'被猜测的目标',evidenceQuote:'你好'}]})},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:10}}}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
 const service=new AssistantService(s,{accessToken:async()=>'synthetic-token'} as ChatGPTAuth,{read:async()=>({}),write:async()=>{}},()=>{});await service.chat('你好');const reply=s.messages().at(-1)!;
 assert.equal(reply.status,'complete');assert.ok(reply.memoryWarnings?.length);assert.equal(s.memories().length,0);assert.deepEqual(s.getSettings().goals,goals);
});

const estimatedFood=()=>({name:'合成测试食物',grams:{low:50,high:50},assumption:'合成估算',nutrition:{source:'estimate',basis:'合成每100g估算',per100g:{kcal:{low:100,high:120},protein:{low:5,high:6},carbs:{low:10,high:12},fat:{low:2,high:3}}}});
function meal(s:HealthStore,text='合成测试食物50g'){return s.importEnvelope({version:1,id:crypto.randomUUID(),kind:'meal',occurredAt:at(),timezone:'Asia/Shanghai',text}).record;}

test('model meals may omit an unmatched catalogue id without losing valid nutrition',t=>{
 const s=setup(t),r=meal(s),input={summary:'合成食材估算',questions:[],ingredients:[estimatedFood()]},before=JSON.stringify(input);
 const saved=s.applyAnalysis(r.id,input,'chatgpt',r.revision);
 assert.equal(saved.status,'ready');assert.equal(saved.analysisPending,false);assert.equal(saved.analysis?.ingredients?.[0].foodId,null);assert.deepEqual(saved.analysis?.macros?.kcal,{low:50,high:60});assert.equal(JSON.stringify(input),before);
 const second=meal(s);const explicit=s.applyAnalysis(second.id,{...input,ingredients:[{...estimatedFood(),foodId:12}]},'deepseek',second.revision);assert.equal(explicit.analysis?.ingredients?.[0].foodId,12);
});

test('both model channels save a batch of label foods even when catalogue ids and redundant nutrition are omitted',async t=>{
 for(const provider of ['chatgpt','deepseek'] as const){
  const s=setup(t);s.setSettings({...s.getSettings(),provider,chatgptModel:'synthetic-model',deepseekBudget:100});
  for(const name of ['合成营养粉','合成即食蛋'])s.saveMemory({kind:'food',text:name,food:{name,servingGrams:100,perServing:{kcal:200,protein:20,carbs:10,fat:8}},startsAt:'2020-01-01T00:00:00Z',expiresAt:null,sourceIds:[],active:true,confirmed:true});
  const records=[meal(s,'合成营养粉25g'),meal(s,'合成营养粉25g，合成即食蛋80g')];let calls=0;
  const service=new AssistantService(s,{accessToken:async()=>'synthetic-token'} as ChatGPTAuth,{read:async()=>({deepseekKey:'synthetic-key'}),write:async()=>{}},()=>{},x=>x,async()=>{
   const ingredients=[{name:'合成营养粉',grams:{low:25,high:25},assumption:'原文报告份量'},...(calls++?[{name:'合成即食蛋',grams:{low:80,high:80},assumption:'原文报告份量'}]:[])];
   const text=JSON.stringify({summary:'合成常用标签餐食',questions:[],ingredients});
   const events=provider==='chatgpt'?[{type:'response.output_text.delta',delta:text},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:20}}}]:[{choices:[{delta:{content:text}}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20}},'[DONE]'];
   return new Response(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''));
  });
  const result=await service.analyze(records.map(r=>r.id),{pendingOnly:true});assert.equal(result.completed,2);assert.equal(result.failed,0);assert.equal(calls,2);
  for(const [i,r] of records.entries()){const saved=s.record(r.id);assert.equal(saved.status,'ready');assert.equal(saved.analysisPending,false);assert.equal(saved.analysisError,undefined);assert.equal(saved.analysis?.ingredients?.length,i+1);assert.ok(saved.analysis?.ingredients?.every(item=>item.foodId===null&&item.nutrition?.provenance==='preset'));assert.deepEqual(saved.analysis?.macros?.kcal,{low:i?210:50,high:i?210:50});}
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM usage WHERE provider=? AND state='complete'").get(provider)!.n,2);
 }
});

test('omitted catalogue ids never fabricate nutrition or weaken manual validation',t=>{
 const s=setup(t),r=meal(s),before=s.record(r.id),input={summary:'合成食材',questions:[],ingredients:[estimatedFood()]};
 assert.throws(()=>s.applyAnalysis(r.id,input,'local',r.revision),/foodId/);
 for(const foodId of ['12',false,0,-1])assert.throws(()=>s.applyAnalysis(r.id,{...input,ingredients:[{...estimatedFood(),foodId}]},'chatgpt',r.revision),/foodId/);
 assert.throws(()=>s.applyAnalysis(r.id,{summary:'缺少营养依据',questions:[],ingredients:[{name:'未有依据的合成食物',grams:{low:50,high:50},assumption:'没有可计算的营养'}]},'chatgpt',r.revision),/食材暂时不能合计/);
 assert.deepEqual(s.record(r.id),before);
});
