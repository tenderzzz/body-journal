import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {foodCandidatePreset} from '../src/shared/food';
import type {FoodPreset,Ingredient} from '../src/shared/types';
const now=()=>new Date().toISOString();
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-nutrition-v4-'));const s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return s;}
const nutrition={source:'estimate' as const,basis:'合成测试估算',per100g:{kcal:{low:400,high:400},protein:{low:20,high:20},carbs:{low:30,high:30},fat:{low:10,high:10}}};
const ingredient=(name:string,over:Partial<Ingredient>={}):Ingredient=>({name,foodId:null,grams:{low:100,high:100},assumption:'合成测试',nutrition,...over});
function meal(s:HealthStore,text='测试餐食',at=now()){return s.importEnvelope({version:1,kind:'meal',id:crypto.randomUUID(),occurredAt:at,timezone:'Asia/Shanghai',text}).record;}
function food(s:HealthStore,preset:FoodPreset){s.saveMemory({kind:'food',text:preset.name,food:preset,startsAt:new Date(Date.now()-86400000).toISOString(),expiresAt:null,sourceIds:[],active:true,confirmed:true});}
function analyze(s:HealthStore,id:string,ingredients:Ingredient[],revision:number,manual=false){return s.applyAnalysis(id,{summary:'测试分析',questions:[],assumptions:[],ingredients},manual?'local':'chatgpt',revision,manual);}
test('store uses exact product presets and protects this-meal explicit label priority',t=>{
 const s=setup(t);food(s,{name:'香草乳清粉',brand:'测试营养',servingGrams:100,perServing:{kcal:350,protein:70,carbs:10,fat:5}});
 let r=meal(s,'本次香草乳清粉每100g 300kcal，蛋白质60g，碳水10g，脂肪3g');
 r=analyze(s,r.id,[ingredient('香草乳清粉')],r.revision);assert.equal(r.analysis!.macros!.kcal.low,350);
 r=analyze(s,r.id,[ingredient('香草乳清粉',{nutrition:{source:'label',provenance:'current',labelEvidence:r.text,basis:'本次包装',per100g:{kcal:{low:300,high:300},protein:{low:60,high:60},carbs:{low:10,high:10},fat:{low:3,high:3}}}})],r.revision);assert.equal(r.analysis!.macros!.kcal.low,300);
 const unrelated=meal(s);const result=analyze(s,unrelated.id,[ingredient('测试营养花生酱')],unrelated.revision);assert.equal(result.analysis!.macros!.kcal.low,400);
});
test('ml labels and consumption fractions survive store recalculation and backup restore',t=>{
 const s=setup(t);food(s,{name:'测试饮料',labelBasis:{quantity:100,unit:'ml'},perServing:{kcal:40,protein:3,carbs:5,fat:1}});
 let r=meal(s);const drink=ingredient('测试饮料',{grams:{low:0,high:0},amount:{low:250,high:250,unit:'ml'},consumedFraction:{low:.5,high:.75}});
 r=analyze(s,r.id,[drink],r.revision);assert.deepEqual(r.analysis!.macros!.kcal,{low:50,high:75});assert.equal(r.analysis!.ingredients![0].nutrition!.per100g,undefined);
 const bundle=s.exportBundle();s.restore(bundle);r=s.record(r.id);
 r=analyze(s,r.id,[drink],r.revision);assert.deepEqual(r.analysis!.ingredients![0].amount,{low:250,high:250,unit:'ml'});assert.deepEqual(r.analysis!.macros!.kcal,{low:50,high:75});
});
test('manual new item without its own nutrition can resolve an exact saved ml product',t=>{
 const s=setup(t);food(s,{name:'测试饮料',labelBasis:{quantity:100,unit:'ml'},perServing:{kcal:40,protein:3,carbs:5,fat:1}});
 const r=meal(s);const added=ingredient('测试饮料',{nutrition:undefined,grams:{low:0,high:0},amount:{low:250,high:250,unit:'ml'}});
 const result=analyze(s,r.id,[added],r.revision,true);assert.deepEqual(result.analysis!.macros!.kcal,{low:100,high:100});assert.equal(result.analysis!.ingredients![0].userCorrected,true);assert.equal(result.analysis!.ingredients![0].nutrition!.provenance,'preset');
});
test('manual portions and label corrections retain identity across raw text edits and reordered reanalysis',t=>{
 const s=setup(t);let r=meal(s,'午餐两项');r=analyze(s,r.id,[ingredient('测试主食'),ingredient('测试肉类')],r.revision);
 const corrections=r.analysis!.ingredients!.map(i=>i.name==='测试主食'?{...i,grams:{low:60,high:60},consumedFraction:{low:.5,high:.5},portionSource:'measured' as const}:i);
 r=analyze(s,r.id,corrections,r.revision,true);r=s.revise(r.id,{text:'午餐两项，补充说明'},r.revision);
 r=analyze(s,r.id,[ingredient('测试肉类'),ingredient('测试主食')],r.revision);
 const main=r.analysis!.ingredients!.find(i=>i.name==='测试主食')!;assert.deepEqual(main.grams,{low:60,high:60});assert.equal(main.portionSource,'measured');assert.deepEqual(main.consumedFraction,{low:.5,high:.5});
 assert.equal(r.analysis!.macros!.kcal.low,520);
});
test('repeated estimates stay estimates when proposed as a saved common food',t=>{
 const s=setup(t);for(const date of ['2026-10-20T12:00:00+08:00','2026-10-21T12:00:00+08:00']){const r=meal(s,'测试三明治',date);analyze(s,r.id,[ingredient('测试三明治')],r.revision);}
 const c=s.foodCandidates().find(c=>c.name==='测试三明治')!;assert.equal(c.source,'estimate');const p=foodCandidatePreset(c);assert.equal(p.nutritionSource,'estimate');food(s,p);
 const r=meal(s);const result=analyze(s,r.id,[ingredient('测试三明治')],r.revision);assert.equal(result.analysis!.ingredients![0].nutrition!.source,'estimate');assert.equal(result.analysis!.ingredients![0].portionSource,undefined);
});
test('model cannot turn its estimate into an actual weighed measurement without the users evidence',t=>{
 const s=setup(t);const r=meal(s,'测试餐食');const result=analyze(s,r.id,[ingredient('测试食物',{portionSource:'measured',portionEvidence:'实际称量100g'})],r.revision);
 assert.equal(result.analysis!.ingredients![0].portionSource,'estimated');
 const weighed=meal(s,'测试食物实际称量100g');const confirmed=analyze(s,weighed.id,[ingredient('测试食物',{portionSource:'measured',portionEvidence:'实际称量100g'})],weighed.revision);
 assert.equal(confirmed.analysis!.ingredients![0].portionSource,'measured');
});
test('historical meals never use a later product label revision',t=>{
 const s=setup(t),base={kind:'food',text:'测试食品',startsAt:'2026-09-01T00:00:00+08:00',expiresAt:null,sourceIds:[],active:true,confirmed:true,food:{name:'测试食品',servingGrams:100,perServing:{kcal:400,protein:20,carbs:30,fat:10}}};
 const saved=s.saveMemory(base);s.saveMemory({...base,startsAt:'2026-10-20T00:00:00+08:00',food:{...base.food,perServing:{...base.food.perServing,kcal:600}}},saved.id);
 const r=meal(s,'历史餐食','2026-10-10T12:00:00+08:00');const result=analyze(s,r.id,[ingredient('测试食品')],r.revision);assert.equal(result.analysis!.macros!.kcal.low,400);
});
test('manual removal remains removed after text edits, reanalysis and backup restore',t=>{
 const s=setup(t);let r=meal(s);r=analyze(s,r.id,[ingredient('测试主食'),ingredient('测试酱汁')],r.revision);r=analyze(s,r.id,[r.analysis!.ingredients![0]],r.revision,true);assert.equal(r.analysis!.excludedIngredientIdentities?.length,1);
 r=s.revise(r.id,{text:'补充这餐吃完了'},r.revision);s.restore(s.exportBundle());r=s.record(r.id);r=analyze(s,r.id,[ingredient('测试酱汁'),ingredient('测试主食')],r.revision);assert.deepEqual(r.analysis!.ingredients!.map(i=>i.name),['测试主食']);
});
test('this-meal nutrition corrections remove superseded preset source claims',t=>{
 const s=setup(t);food(s,{name:'测试食品',servingGrams:100,perServing:{kcal:350,protein:70,carbs:10,fat:5}});let r=meal(s);r=analyze(s,r.id,[ingredient('测试食品')],r.revision);
 assert.equal(r.analysis!.assumptions.filter(a=>a.includes('常用食物')).length,1);
 const edited={...r.analysis!,ingredients:r.analysis!.ingredients!.map(i=>({...i,nutrition:{...nutrition,provenance:'manual' as const}}))};
 r=s.applyAnalysis(r.id,edited,'local',r.revision,true);assert.equal(r.analysis!.macros!.kcal.low,400);assert.ok(!r.analysis!.assumptions.some(a=>a.includes('常用食物')));
});
