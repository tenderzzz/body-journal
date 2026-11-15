import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {todaySummary,setTodayRest} from '../electron/core/today';
import {TodayCard} from '../src/ui/TodayCard';
import type {RecordKind,TodaySummary} from '../src/shared/types';
import {ingredient} from './fixtures/prompt-golden';
const timezone='Asia/Shanghai',now=new Date('2026-10-22T21:00:00+08:00');
function fixture(t:test.TestContext){
  const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-today-')),open=()=>new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);
  const s=open();t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return {s,open};
}
function add(s:HealthStore,kind:RecordKind,id:string,at:string,text:string,kg?:number){
  return s.importEnvelope({version:1,id:'synthetic-'+id,kind,occurredAt:at+'+08:00',dateLocked:true,timezone,text,body:kg?{weightKg:kg}:undefined}).record;
}
const markup=(data:TodaySummary)=>renderToStaticMarkup(createElement(TodayCard,{data,onTarget(){},onSource(){},async onRest(){}}));

test('today includes all meals and applies the effective goal across the 04:00 boundary, without loading the archive or reviews',t=>{
  const {s}=fixture(t);
  assert.match(markup(todaySummary(s,now)),/今天还没有餐食记录 · 未设蛋白质目标/);
  s.energy.importManualTarget(2200,140,now);
  for(let i=0;i<13;i++){
    const r=add(s,'meal','meal-'+i,'2026-10-22T14:00:00','合成餐 '+i);
    s.applyAnalysis(r.id,{summary:'估计',ingredients:[ingredient('米饭',50)]},'local',r.revision);
  }
  add(s,'meal','border','2026-10-22T03:59:59','前一日加餐');
  add(s,'meal','pending','2026-10-22T04:00:00','本日餐食待估');
  s.records=()=>{throw Error('today must use scoped queries');};
  s.energy.view=()=>{throw Error('today cannot load energy detail');};
  const summary=todaySummary(s,now);
  assert.deepEqual(summary.protein,{target:140,logged:{low:65,high:65},meals:14,pending:1,pendingId:'synthetic-pending'});
  assert.match(markup(summary),/75 <small>g 待补/);
  assert.deepEqual(todaySummary(s,new Date('2026-10-22T03:59:59+08:00')).protein,{target:null,logged:null,meals:1,pending:1,pendingId:'synthetic-border'});
});
test('two nonoverlapping complete weeks use daily medians and ignore today, deleted and unverified observations',t=>{
  const {s}=fixture(t);
  for(const [i,[day,kg]] of [[8,76],[8,74],[9,75],[11,75],[15,74],[17,74],[21,73],[22,81]].entries())
    add(s,'body','weight-'+i,'2026-10-'+String(day).padStart(2,'0')+'T12:00:00','合成体重',kg);
  const summary=todaySummary(s,now);assert.equal(summary.weight.change,-1);assert.equal(summary.weight.latest?.kg,81);
  s.setRecordDeleted('synthetic-weight-6',true);assert.equal(todaySummary(s,now).weight.change,null);
  assert.match(markup(todaySummary(s,now)),/81 <small>kg<\/small>.*样本不足/);
  const old=add(s,'body','old','2026-09-01T08:00:00','旧测量',73);
  assert.equal(todaySummary(s,new Date('2026-10-04T14:00:00+08:00')).weight.latest?.date,old.occurredAt.slice(0,10));
});
test('rest persists only for the selected journal day and timezone, completion wins, plans and cardio do not advance the strength split',t=>{
  const {s,open}=fixture(t);
  add(s,'training','back','2026-10-19T18:00:00','背日\n高位下拉 40kg 3×8');
  add(s,'training','chest','2026-10-21T18:00:00','胸日\n杠铃卧推 40kg 3×8');
  add(s,'training','planned','2026-10-22T18:00:00','计划\n腿日\n深蹲 45kg 3×8');
  const initial=todaySummary(s,now);assert.equal(initial.next,'back');assert.equal(initial.reference?.id,'synthetic-back');assert.equal(initial.reference.kg,40);assert.equal(initial.completed,null);
  const count=s.records().length,hash=s.energy.hash('2026-10-01',initial.date),choice={date:initial.date,timezone,rest:true};
  setTodayRest(s,choice,now);assert.equal(s.records().length,count);assert.equal(s.energy.hash('2026-10-01',initial.date),hash);
  s.close();const reopened=open();
  try{
    assert.equal(todaySummary(reopened,now).rest,true);assert.equal(todaySummary(reopened,new Date('2026-10-23T03:59:59+08:00')).rest,true);
    const tomorrow=new Date('2026-10-23T04:00:00+08:00');assert.equal(todaySummary(reopened,tomorrow).rest,false);
    assert.throws(()=>setTodayRest(reopened,choice,tomorrow),/手记日/);
    assert.throws(()=>setTodayRest(reopened,{...choice,timezone:'UTC'},now),/时区/);
    setTodayRest(reopened,{...choice,rest:false},now);assert.equal(todaySummary(reopened,now).rest,false);setTodayRest(reopened,choice,now);
    add(reopened,'training','run','2026-10-22T19:00:00','已完成跑步5公里，用时30分钟');
    const cardio=todaySummary(reopened,now);assert.equal(cardio.completed?.part,'cardio');assert.equal(cardio.next,'back');assert.match(markup(cardio),/今天已练有氧/);
    add(reopened,'training','worked','2026-10-22T20:00:00','背日\n高位下拉 42kg 3×8');
    const done=todaySummary(reopened,now);assert.equal(done.completed?.id,'synthetic-worked');assert.equal(done.next,'shoulders');assert.match(markup(done),/今天已练背/);
  }finally{reopened.close();}
});
