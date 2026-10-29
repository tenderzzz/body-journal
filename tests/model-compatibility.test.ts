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
