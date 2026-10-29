import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {AssistantService} from '../electron/ai/service';
import type {ChatGPTAuth} from '../electron/ai/auth';

const stable=(v:unknown)=>JSON.parse(JSON.stringify(v));
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'meal-followup-')),s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);s.setSettings({...s.getSettings(),chatgptModel:'synthetic-model'});t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return s;}
const ingredient={name:'合成测试米饭',foodId:null,grams:{low:140,high:180},assumption:'合成分量估算',nutrition:{source:'estimate',basis:'合成同类食物',per100g:{kcal:{low:110,high:130},protein:{low:2,high:3},carbs:{low:24,high:28},fat:{low:0.2,high:0.4}}}};
function meal(s:HealthStore,id='synthetic-meal-followup') {const r=s.importEnvelope({version:1,id,kind:'meal',text:'合成测试米饭',occurredAt:'2026-10-20T12:00:00+08:00',timezone:'Asia/Shanghai'}).record;return s.applyAnalysis(r.id,{summary:'合成上一版估算',questions:['是否吃完？'],ingredients:[ingredient]},'chatgpt',r.revision);}

test('meal supplements retain the complete successful estimate across failure, another answer and backup',t=>{
 const s=setup(t),r=meal(s);let saved=s.revise(r.id,{followup:{answer:'吃完了',questions:r.analysis!.questions}},r.revision);
 assert.equal(saved.analysis,null);assert.deepEqual(saved.followups?.at(-1)?.previousAnalysis?.ingredients,stable(r.analysis?.ingredients));assert.deepEqual(saved.followups?.at(-1)?.previousAnalysis?.macros,r.analysis?.macros);
 s.markAnalysisFailure(saved.id,saved.revision,'合成超时');saved=s.revise(saved.id,{followup:{answer:'米饭是一小碗',questions:[]}},saved.revision);
 assert.deepEqual(saved.followups?.at(-1)?.previousAnalysis?.ingredients,stable(r.analysis?.ingredients));
 s.restore(s.exportBundle());assert.deepEqual(s.record(saved.id).followups?.at(-1)?.previousAnalysis?.ingredients,stable(r.analysis?.ingredients));
});

test('meal followup request reuses ingredient estimates once and excludes unrelated meal history',async t=>{
 const s=setup(t),r=meal(s);meal(s,'synthetic-unrelated-meal');const saved=s.revise(r.id,{followup:{answer:'吃完了',questions:r.analysis!.questions}},r.revision);let prompt:any;
 const svc=new AssistantService(s,{accessToken:async()=> 'synthetic-token'} as unknown as ChatGPTAuth,{read:async()=>({}),write:async()=>{}},()=>{},x=>x,async(_url,init)=>{
  prompt=JSON.parse(JSON.parse(String(init?.body)).input[0].content[0].text);
  const result={summary:'合成补充完成',questions:[],ingredients:[ingredient]};return new Response([{type:'response.output_text.delta',delta:JSON.stringify(result)},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:20}}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 });
 await svc.analyze([saved.id]);assert.deepEqual(prompt.record.previousIngredients,stable(r.analysis!.ingredients));assert.equal(prompt.record.previousAnalysis.ingredients,undefined);assert.equal(prompt.record.followups[0].previousAnalysis,undefined);assert.deepEqual(prompt.mealHistory,[]);assert.equal(s.record(r.id).status,'ready');
});

test('legacy missing meal context is restored from matching revision without treating it as a current result',t=>{
 const s=setup(t),r=meal(s),saved=s.revise(r.id,{followup:{answer:'吃完了',questions:r.analysis!.questions}},r.revision);
 saved.followups![0].previousAnalysis={questions:r.analysis!.questions};s.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(saved),saved.id);
 assert.equal(s.migrateMealFollowupContext(),1);const repaired=s.record(r.id);assert.equal(repaired.text,saved.text);assert.equal(repaired.analysis,null);assert.equal(repaired.analysisPending,true);assert.deepEqual(repaired.followups![0].previousAnalysis?.ingredients,stable(r.analysis?.ingredients));assert.equal(s.migrateMealFollowupContext(),0);
});
