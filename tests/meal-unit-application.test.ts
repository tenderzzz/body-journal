import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';

const values={kcal:{low:150,high:200},protein:{low:5,high:8},carbs:{low:20,high:30},fat:{low:3,high:5}};
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'meal-units-')),s=new HealthStore(root,new FoodCatalog([{id:123456,description:'Synthetic liquid',kcal:20,protein:0,carbs:3,fat:0,source:'synthetic fixture'}]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});const r=s.importEnvelope({version:1,id:'synthetic-unit-meal',kind:'meal',text:'合成包点六个，合成调味液',occurredAt:'2026-10-20T12:00:00+08:00',timezone:'Asia/Shanghai'}).record;return {s,r};}

test('complete model meals with counted food and per-ml liquid survive application and backup',t=>{
 const {s,r}=setup(t),saved=s.applyAnalysis(r.id,{summary:'合成混合单位餐食',questions:[],ingredients:[
  {name:'合成包点',foodId:null,grams:{low:180,high:240},amount:{low:6,high:6,unit:'serving'},assumption:'整份克重估计，非每个重量',portionSource:'estimated',nutrition:{source:'estimate',basis:'合成每100g参考',per100g:values}},
  {name:'合成调味液',catalogQuery:'Synthetic liquid',foodId:null,grams:{low:0,high:0},amount:{low:10,high:20,unit:'ml'},assumption:'保留原始毫升',nutrition:{source:'estimate',basis:'合成每100ml参考',labelBasis:{quantity:100,unit:'ml'},perBasis:values}}
 ]},'chatgpt',r.revision);
 assert.equal(saved.status,'ready');assert.equal(saved.analysisPending,false);assert.deepEqual(saved.analysis!.unmatched,[]);assert.deepEqual(saved.analysis!.macros!.kcal,{low:285,high:520});assert.equal(saved.analysis!.ingredients![0].amount!.unit,'serving');assert.equal(saved.analysis!.ingredients![1].amount!.unit,'ml');assert.equal(saved.analysis!.ingredients![1].nutrition!.source,'estimate');
 s.restore(s.exportBundle());assert.deepEqual(s.record(r.id).analysis!.macros,saved.analysis!.macros);
});

test('an unsupported liquid reports the ingredient and reason, without saving partial analysis',t=>{
 const {s,r}=setup(t);
 assert.throws(()=>s.applyAnalysis(r.id,{summary:'合成不支持单位',questions:[],ingredients:[{name:'合成调味液',foodId:null,grams:{low:0,high:0},amount:{low:10,high:20,unit:'ml'},assumption:'密度未知',nutrition:{source:'estimate',basis:'仅有每100g参考',per100g:values}}]},'chatgpt',r.revision),/合成调味液（计量单位或密度待补充）/);
 assert.equal(s.record(r.id).revision,r.revision);assert.equal(s.record(r.id).analysis,null);assert.equal(s.history(r.id).length,0);
});
