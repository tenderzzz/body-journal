import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {sameMealDescription} from '../electron/core/meal-edit';

function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'meal-formatting-')),s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return s;}
const text='合成餐牌香菇包子六个',formatted='合成餐牌，香菇包子六个';
function meal(s:HealthStore){let r=s.importEnvelope({version:1,id:'synthetic-formatting-meal',kind:'meal',text,occurredAt:'2026-10-20T12:00:00+08:00',timezone:'Asia/Shanghai'}).record;r=s.applyAnalysis(r.id,{summary:'合成有效估算',questions:[],ingredients:[{name:'合成香菇包子',foodId:null,grams:{low:180,high:240},assumption:'合成质量估算',nutrition:{source:'estimate',basis:'合成同类参考',per100g:{kcal:{low:170,high:220},protein:{low:5,high:7},carbs:{low:25,high:35},fat:{low:3,high:6}}}}]},'chatgpt',r.revision);return s.record(r.id);}

test('only conservative formatting is equivalent; numbers, units and negation retain meaning',()=>{
 assert.equal(sameMealDescription(text,formatted),true);assert.equal(sameMealDescription(text,formatted+'。'),false);
 for(const [a,b] of [['合成食物1.0g','合成食物10g'],['合成食物1,000g','合成食物1000g'],['合成食物10ml','合成食物10g'],['不，吃米饭','不吃米饭'],['合成食物六个','合成食物八个']])assert.equal(sameMealDescription(a,b),false,`${a} / ${b}`);
});

test('a separator edit keeps the successful estimate and original revision history',t=>{
 const s=setup(t),r=meal(s),next=s.revise(r.id,{text:formatted,occurredAt:new Date(r.occurredAt).toISOString()},r.revision);
 assert.equal(next.text,formatted);assert.equal(next.revision,r.revision+1);assert.equal(next.status,'ready');assert.equal(next.analysisPending,false);assert.deepEqual(next.analysis?.macros,r.analysis?.macros);assert.deepEqual(next.analysis?.ingredients,r.analysis?.ingredients);assert.equal((s.history(r.id)[0].record as {text:string}).text,text);
 const changed=s.revise(next.id,{text:'合成餐牌，香菇包子八个'},next.revision);assert.equal(changed.analysis,null);assert.equal(changed.analysisPending,true);
});

test('legacy formatting-only failures recover only from matching successful revisions',t=>{
 const s=setup(t),r=meal(s),edited=s.revise(r.id,{text:formatted},r.revision),legacy={...edited,analysis:null,status:'pending',analysisPending:true,analysisError:'合成失败'};
 s.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(legacy),r.id);
 assert.equal(s.migrateMealFormattingEdits(),1);const restored=s.record(r.id);assert.equal(restored.text,formatted);assert.equal(restored.status,'ready');assert.equal(restored.analysisPending,false);assert.equal(restored.analysisError,undefined);assert.deepEqual(restored.analysis?.macros,r.analysis?.macros);assert.equal(s.migrateMealFormattingEdits(),0);
});
