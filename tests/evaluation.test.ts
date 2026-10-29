import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {evaluateDataset,EVALUATION_EXAMPLE} from '../src/shared/evaluation';

const dataset=(samples:unknown[],comparison?:unknown)=>({format:'bodyjournal-evaluation',version:1,samples,...(comparison?{comparison}:{})});
test('offline evaluation compares known references and reports synthetic example honestly',()=>{
  const r=evaluateDataset(EVALUATION_EXAMPLE),candidate=r.models.find(m=>m.label==='candidate')!;
  assert.equal(r.synthetic,true);assert.equal(r.samples,3);assert.equal(r.references.kcal,2);
  assert.equal(candidate.kcal.mae.samples,2);assert.equal(candidate.kcal.mae.missing,1);
  assert.equal(candidate.kcal.mae.value,2.5);assert.equal(candidate.food.exactMatch.value,1);
  assert.equal(candidate.kcal.coverage.value,1);assert.equal(candidate.kcal.repeatStdDev.samples,3);
  assert.equal(r.comparison!.deltas.kcalMae.samples,2);assert.equal(r.comparison!.deltas.kcalMae.value,-52.5);
});
test('unknown references and omitted predictions never become zero; real zero remains evaluable',()=>{
  const r=evaluateDataset(dataset([
    {id:'zero',reference:{kcal:0,protein:0,foodIds:[]},predictions:[{kcal:0,protein:0,foodIds:[],questions:0}]},
    {id:'unknown',predictions:[{kcal:500}]},
    {id:'missing-prediction',reference:{kcal:100},predictions:[{questions:1}]},
  ]));
  const m=r.models[0];assert.equal(m.kcal.mae.value,0);assert.equal(m.kcal.mae.samples,1);assert.equal(m.kcal.mae.missing,2);
  assert.equal(m.protein.mae.samples,1);assert.equal(m.food.exactMatch.value,1);
  assert.equal(m.protein.repeatStdDev.value,null);assert.equal(m.questions.value,.5);
});
test('repeats measure variability without allowing repeat-heavy samples to dominate error',()=>{
  const r=evaluateDataset(dataset([
    {id:'many-repeats',reference:{kcal:100,protein:10},predictions:[{kcal:90,protein:8},{kcal:110,protein:12},{kcal:100,protein:10}]},
    {id:'one-run',reference:{kcal:100,protein:10},predictions:[{kcal:200,protein:20}]},
  ])).models[0];
  assert.equal(r.kcal.mae.value,(20/3+100)/2);assert.equal(r.kcal.mae.samples,2);assert.equal(r.kcal.mae.observations,4);
  assert.equal(r.kcal.repeatStdDev.samples,1);assert.ok(Math.abs(r.kcal.repeatStdDev.value!-Math.sqrt(200/3))<1e-10);
  assert.equal(r.kcal.width.value,0);
});
test('identity comparison detects missing and invented products, preserving flavor distinctions',()=>{
  const r=evaluateDataset(dataset([{id:'products',reference:{foodIds:['whey-vanilla','milk']},predictions:[{foodIds:['whey-chocolate','milk','oil']}]}])).models[0];
  assert.equal(r.food.exactMatch.value,0);assert.equal(r.food.precision.value,1/3);assert.equal(r.food.recall.value,.5);
});
test('baseline differences are paired on the same samples and metric availability',()=>{
  const r=evaluateDataset(dataset([
    {id:'both',reference:{kcal:100,protein:10},predictions:[{label:'old',kcal:150,protein:20},{label:'new',kcal:110,protein:11}]},
    {id:'old-only',reference:{kcal:100},predictions:[{label:'old',kcal:1000}]},
    {id:'no-new-kcal',reference:{kcal:100},predictions:[{label:'old',kcal:150},{label:'new',questions:0}]},
  ],{baseline:'old',candidate:'new'}));
  assert.equal(r.comparison!.deltas.kcalMae.value,-40);assert.equal(r.comparison!.deltas.kcalMae.samples,1);
  assert.equal(r.comparison!.deltas.kcalMae.missing,1);assert.equal(r.comparison!.deltas.proteinMae.value,-9);
});
test('malformed, duplicate and non-finite evaluation data are refused',()=>{
  const s={id:'a',predictions:[{kcal:100}]};
  assert.throws(()=>evaluateDataset(dataset([s,s])),/样本编号/);
  assert.throws(()=>evaluateDataset(dataset([{id:'a',predictions:[{kcal:{low:100,high:99}}]}])),/下限/);
  assert.throws(()=>evaluateDataset(dataset([{id:'a',predictions:[{kcal:NaN}]}])));
  assert.throws(()=>evaluateDataset(dataset([{id:'a',predictions:[{foodIds:['x','x']}]}])),/重复/);
  assert.throws(()=>evaluateDataset(dataset([s],{baseline:'same',candidate:'same'})),/比较/);
  assert.throws(()=>evaluateDataset({...dataset([s]),path:'/private/data'}));
});
test('CLI reads only explicitly supplied data and returns an offline JSON report',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-evaluation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'synthetic.json');writeFileSync(file,JSON.stringify(EVALUATION_EXAMPLE));
  const result=spawnSync(process.execPath,['scripts/evaluate.mjs',file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).synthetic,true);
  const missing=spawnSync(process.execPath,['scripts/evaluate.mjs'],{encoding:'utf8'});assert.equal(missing.status,1);assert.match(missing.stderr,/用法/);
});
