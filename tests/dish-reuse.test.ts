import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {AssistantService} from '../electron/ai/service';
import type {ChatGPTAuth} from '../electron/ai/auth';
const ingredient={name:'合成食材',foodId:null,grams:{low:100,high:120},assumption:'合成估算',portionSource:'estimated',nutrition:{source:'estimate',basis:'合成参考',per100g:{kcal:{low:100,high:150},protein:{low:5,high:7},carbs:{low:10,high:20},fat:{low:2,high:5}}}};
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'dish-reuse-')),s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);s.setSettings({...s.getSettings(),chatgptModel:'synthetic-model'});t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return s;}
function record(s:HealthStore,id:string,day:number){return s.importEnvelope({version:1,id,kind:'meal',text:'合成餐牌菌菇面一份',occurredAt:`2026-10-${day}T12:00:00+08:00`,timezone:'Asia/Shanghai'}).record;}
function seed(s:HealthStore){for(const [i,day] of [20,21].entries()){const r=record(s,`synthetic-reuse-${i}`,day);s.applyAnalysis(r.id,{summary:'合成历史餐食',questions:[],ingredients:[ingredient]},'chatgpt',r.revision);}}

test('common whole-meal reference reaches model requests once; archiving disables reuse without making a label',async t=>{
 const s=setup(t);seed(s);const r=record(s,'synthetic-next-dish',22);let prompt:any;
 const svc=new AssistantService(s,{accessToken:async()=> 'synthetic-token'} as unknown as ChatGPTAuth,{read:async()=>({}),write:async()=>{}},()=>{},x=>x,async(_url,init)=>{
  prompt=JSON.parse(JSON.parse(String(init?.body)).input[0].content[0].text);const events=[{type:'response.output_text.delta',delta:JSON.stringify({summary:'合成本餐',questions:[],ingredients:[ingredient]})},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:20}}}];return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 });
 await svc.analyze([r.id]);assert.equal(prompt.commonDish.name,'合成餐牌菌菇面');assert.equal(prompt.commonDish.sourceRecordId,'synthetic-reuse-1');assert.equal(prompt.commonDish.ingredients[0].portionSource,'estimated');assert.ok(!prompt.personalMemories.some((m:any)=>m.subject===prompt.commonDish.id));assert.deepEqual(prompt.personalFoods,[]);assert.deepEqual(s.foodPresets(),[]);assert.deepEqual(s.foodCandidates(false),[]);
 s.saveDish({id:s.commonDishes()[0].id,active:false});const next=record(s,'synthetic-archived-dish',23);await svc.analyze([next.id]);assert.equal(prompt.commonDish,undefined);
});

test('bulk same-dish associations roll back entirely when any association is invalid',t=>{
 const s=setup(t);seed(s);const before={definitions:s.dishDefinitions(),memories:s.memories(),revisions:s.db.prepare('SELECT count(*) AS n FROM revisions').get()!.n};
 assert.throws(()=>s.saveDishes([{name:'合成手动面餐',recordIds:['synthetic-reuse-0','synthetic-reuse-1']},{name:'合成无效面餐',recordIds:['synthetic-missing-meal']}]),/没有找到/);
 assert.deepEqual(s.dishDefinitions(),before.definitions);assert.deepEqual(s.memories(),before.memories);assert.equal(s.db.prepare('SELECT count(*) AS n FROM revisions').get()!.n,before.revisions);
});
