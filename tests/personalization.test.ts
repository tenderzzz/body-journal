import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {resolveRecordDate} from '../electron/core/dates';
import {localDay,validMemory} from '../src/shared/stats';
const ref='2026-10-26T08:00:00+08:00';
function setup(t:test.TestContext){const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-personal-'));const store=new HealthStore(dir,new FoodCatalog([{id:1,description:'rice',kcal:130,protein:2.7,carbs:28,fat:.3,source:'fixture'}]),path.join(dir,'inbox'),false);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
function row(text:string,kind='training',occurredAt=ref){return {version:1,id:randomUUID(),kind,text,occurredAt,timezone:'Asia/Shanghai'};}
test('backdated dates use capture day, reject ambiguity and distinguish plans from events',()=>{
 for(const text of ['2026.10.20\n卧推 60kg 3组×8次','补记10月20日的训练','10/20 午餐：鸡肉饭']) assert.equal(localDay(resolveRecordDate(text,ref,'Asia/Shanghai')!.occurredAt),'2026-10-20');
 assert.equal(localDay(resolveRecordDate('昨天午餐：鸡肉饭',ref,'Asia/Shanghai')!.occurredAt),'2026-10-25');
 assert.equal(localDay(resolveRecordDate('12月31日\n卧推 60kg 3组×8次','2027-01-02T08:00:00+08:00','Asia/Shanghai')!.occurredAt),'2026-12-31');
 for(const text of ['计划10月28日训练','2026-02-30\n卧推','2026-10-20\n卧推\n2026-10-21\n深蹲','昨晚睡眠不好，今天精力一般','和10月20日相比今天好一些'])assert.equal(resolveRecordDate(text,ref,'Asia/Shanghai'),null);
 const correction=resolveRecordDate('2026.10.20\n卧推\n补充：这次实际是10月21日',ref,'Asia/Shanghai');assert.equal(localDay(correction!.occurredAt),'2026-10-21');
 const dst=resolveRecordDate('2026-03-08 19:30 晚餐：鸡肉饭','2026-03-09T08:00:00-04:00','America/New_York');assert.equal(dst!.occurredAt,'2026-03-08T23:30:00.000Z');
});
test('import and corrections move the record day, preserve manual dates, dedupe and undo',t=>{
 const store=setup(t),e=row('2026.10.20\n卧推 60kg 3组×8次');const r=store.importEnvelope(e).record;
 assert.equal(localDay(r.occurredAt),'2026-10-20');assert.equal(r.dateResolution?.dateOnly,true);assert.equal(r.analysis?.questions.length,0);assert.equal(store.importEnvelope(e).duplicate,true);
 const changed=store.revise(r.id,{text:r.text+'\n补充：这次实际是10月21日'},r.revision);assert.equal(localDay(changed.occurredAt),'2026-10-21');
 const manual=store.revise(r.id,{occurredAt:'2026-10-19T19:00:00+08:00'},changed.revision);assert.equal(manual.dateLocked,true);
 store.refreshPersonalization();assert.equal(localDay(store.record(r.id).occurredAt),'2026-10-19');
 assert.equal(localDay(store.undoRecord(r.id).occurredAt),'2026-10-21');
});
test('training reference memories track confirmed sets, update in place and respect manual edits or disable',t=>{
 const store=setup(t);const first=store.importEnvelope(row('卧推 60kg 3组×8次')).record;
 let m=store.memories().find(m=>m.autoCategory==='training')!;assert.ok(m);assert.match(m.text,/60kg/);assert.match(m.text,/3组/);
 const second=store.importEnvelope(row('卧推 62.5kg 3组×8次','training','2026-10-27T20:00:00+08:00')).record;
 let next=store.memories().find(x=>x.id===m.id)!;assert.match(next.text,/62.5kg/);assert.equal(next.sourceIds.length,2);
 store.revise(second.id,{deleted:true},second.revision);next=store.memories().find(x=>x.id===m.id)!;assert.match(next.text,/60kg/);assert.doesNotMatch(next.text,/62.5kg/);
 store.saveMemory({...next,active:false},m.id);store.refreshPersonalization();assert.equal(store.memories().find(x=>x.id===m.id)!.active,false);
 assert.equal(store.memories().filter(x=>x.autoCategory==='training').length,1);
 const b=store.exportBundle();store.restore(b);assert.equal(store.memories().find(x=>x.id===m.id)!.active,false);
 assert.equal(first.analysis?.sets?.[0].confirmed,true);
});
test('repeated meals form an evidence-linked template, explicit preferences are remembered without repeated approval',t=>{
 const store=setup(t);const ingredients=[{name:'鸡肉饭',foodId:1,grams:{low:180,high:220},assumption:'测试'}];
 const a=store.importEnvelope(row('鸡肉饭','meal','2026-10-20T12:00:00+08:00')).record;
 store.applyAnalysis(a.id,{summary:'测试',ingredients},'chatgpt',a.revision);assert.equal(store.memories().filter(m=>m.autoCategory==='meal').length,0);
 const b=store.importEnvelope(row('鸡肉饭','meal','2026-10-22T12:00:00+08:00')).record;store.applyAnalysis(b.id,{summary:'测试',ingredients},'chatgpt',b.revision);
 let m=store.memories().find(m=>m.autoCategory==='meal')!;assert.ok(m);assert.equal(m.sourceIds.length,2);assert.equal(m.mealTemplate?.[0].grams.low,180);assert.equal(m.kind,'habit');
 store.importEnvelope(row('我习惯每个动作做3组，每组8到12次。','note'));
 const p=store.memories().find(m=>m.autoCategory==='preference')!;assert.equal(p.confirmed,true);assert.match(p.text,/我习惯/);
 store.revise(b.id,{deleted:true},store.record(b.id).revision);m=store.memories().find(x=>x.id===m.id)!;assert.equal(validMemory(m),false);
});

test('calendar uses the profile timezone, includes empty days and excludes removed records',async()=>{
 const {recentRecordDays}=await import('../src/shared/stats');
 const r={...row('午餐','meal','2026-10-25T23:30:00-04:00'),deleted:false} as any;
 const days=recentRecordDays([r,{...r,id:randomUUID(),deleted:true}],'Asia/Shanghai',new Date('2026-10-26T00:30:00Z'));
 assert.equal(days.length,7);assert.equal(days.at(-1)!.date,'2026-10-26');assert.equal(days.at(-1)!.count,1);assert.equal(days[0].count,0);
});
test('existing dated records migrate once, preserve analysis and do not overwrite manual memory edits',t=>{
 const store=setup(t),r=store.importEnvelope(row('2026.10.20\n卧推 60kg 3组×8次')).record;
 const legacy={...r,occurredAt:ref,dateResolution:undefined,capturedAt:undefined};store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(legacy),r.id);
 assert.equal(store.refreshPersonalization(),1);assert.equal(localDay(store.record(r.id).occurredAt),'2026-10-20');assert.equal(store.record(r.id).analysis!.sets![0].kg,60);assert.equal(store.refreshPersonalization(),0);
 const same=store.importEnvelope(row('卧推 60kg 3组×8次','training','2026-10-24T15:00:00+08:00')).record;store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify({...same,text:'2026.10.24\n'+same.text}),same.id);store.refreshPersonalization();assert.equal(store.record(same.id).occurredAt,'2026-10-24T15:00:00+08:00');
 const m=store.memories().find(m=>m.autoCategory==='training')!;store.saveMemory({...m,text:'我自己整理的训练参照'},m.id);store.refreshAutomaticMemories();assert.equal(store.memories().find(x=>x.id===m.id)!.text,'我自己整理的训练参照');
 assert.equal(resolveRecordDate('10-20kg 的训练重量',ref,'Asia/Shanghai'),null);
});

test('long-term memory keeps its older source available for assistant citations',t=>{
 const store=setup(t),r=store.importEnvelope(row('卧推 60kg 3组×8次','training','2020-10-20T12:00:00+08:00')).record;
 const context=store.context('我平时的训练参照是什么');assert.ok(context.records.some(x=>x.id===r.id));assert.ok(context.memories.some(x=>x.sourceIds.includes(r.id)));
});
