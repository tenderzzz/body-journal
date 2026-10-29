import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTraining,localRecordStatus} from '../electron/core/parser';
import {detectTrainingNotation,isTrainingNotationLine,expandInlineWeightGroups,mergeTrainingNotation} from '../electron/core/training-notation';
import {inferSession,strengthDurationMinutes} from '../src/shared/exercises';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
const at='2026-10-20T18:00:00+08:00';
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-notation-')),store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return store;}
function row(text:string,occurredAt=at){return {version:1,id:randomUUID(),kind:'training',occurredAt,timezone:'Asia/Shanghai',text};}

test('explicit notation declarations work through followup prefixes, without treating questions as confirmation',()=>{
 assert.deepEqual(detectTrainingNotation('补充：组数x次数，只有一个数字就是1组x次数'),{setsFirst:true,singleNumberIsReps:true});
 assert.deepEqual(detectTrainingNotation('以后按次数×组数记录；单个数字表示次数'),{setsFirst:false,singleNumberIsReps:true});
 assert.deepEqual(detectTrainingNotation('是组数x次数吗？只有一个数字就是1组x次数？'),{});
 assert.equal(isTrainingNotationLine('补充：组数x次数，只有一个数字就是1组x次数'),true);
 assert.equal(isTrainingNotationLine('卧推 30kg 3x8'),false);
});

test('a rhetorical question after declarative supplement clauses does not undo their explicit convention',()=>{
 const note='补充：我的记录习惯是组数x次数，只有一个数字就是1组x次数，为什么这次还在问我？';
 assert.deepEqual(detectTrainingNotation(note),{setsFirst:true,singleNumberIsReps:true});assert.equal(isTrainingNotationLine(note),true);
 const a=parseTraining('卧推 28kg 10 38kg 7 48kg 2x6+5\n'+note)!;
 assert.equal(a.questions.length,0);assert.deepEqual(a.sets!.map(s=>[s.kg,s.sets,s.reps]),[[28,1,10],[38,1,7],[48,2,6],[48,1,5]]);
 assert.deepEqual(detectTrainingNotation('是不是组数x次数？'),{});
 assert.deepEqual(detectTrainingNotation('只有一个数字就是次数吗，能否解释一下？'),{});
 assert.deepEqual(detectTrainingNotation('组数x次数，还是次数x组数？'),{});
});

test('confirmed single-number notation parses inline weights into separate rows and exact set arithmetic',()=>{
 const text='卧推 24kg 11 34kg 8 44kg 2x7+6+5\n补充：组数x次数，只有一个数字就是1组x次数';
 const a=parseTraining(text)!;
 assert.deepEqual(a.sets!.map(s=>[s.kg,s.sets,s.reps]),[[24,1,11],[34,1,8],[44,2,7],[44,1,6],[44,1,5]]);
 assert.equal(a.questions.length,0);assert.equal(a.sets!.reduce((n,s)=>n+s.sets,0),6);assert.equal(a.sets!.reduce((n,s)=>n+s.sets*s.reps,0),44);
 assert.ok(a.assumptions.some(s=>s.includes('已明确确认')));
 assert.equal(localRecordStatus({kind:'training',text,body:null}).status,'ready');
});

test('a passed convention applies to later logs, but naked numbers remain ambiguous without it',()=>{
 const text='卧推 32kg 9';
 const ambiguous=parseTraining(text)!;assert.equal(ambiguous.sets!.length,0);assert.ok(ambiguous.questions.length);assert.equal(localRecordStatus({kind:'training',text,body:null}).status,'needs_info');
 assert.deepEqual(parseTraining(text,{singleNumberIsReps:true})!.sets!.map(s=>[s.kg,s.sets,s.reps]),[[32,1,9]]);
 assert.deepEqual(parseTraining('卧推 32kg 9次')!.sets!.map(s=>[s.kg,s.sets,s.reps]),[[32,1,9]]);
});

test('explicit word units override multiplication convention and later declarations override earlier ones',()=>{
 assert.deepEqual(parseTraining('卧推 32kg 9x2',{setsFirst:false})!.sets!.map(s=>[s.sets,s.reps]),[[2,9]]);
 assert.deepEqual(parseTraining('卧推 32kg 2组x9次',{setsFirst:false})!.sets!.map(s=>[s.sets,s.reps]),[[2,9]]);
 const a=parseTraining('卧推 32kg 3x7\n补充：组数x次数',{setsFirst:false})!;assert.deepEqual(a.sets!.map(s=>[s.sets,s.reps]),[[3,7]]);
 assert.deepEqual(detectTrainingNotation('只有一个数字就是次数；只有一个数字不是次数'),{singleNumberIsReps:false});
});

test('inline continuity never invents weights from an earlier line or mislabels another action',()=>{
 const a=parseTraining('卧推 32kg 9\n卧推 10\n11',{singleNumberIsReps:true})!;
 assert.deepEqual(a.sets!.map(s=>[s.kg,s.reps]),[[32,9],[null,10]]);assert.equal(a.sets![1].confirmed,false);assert.ok(a.questions.length);
 assert.equal(expandInlineWeightGroups('卧推 32kg 9 哑铃划船 18kg 12').length,1);
 const unconfirmed=parseTraining('卧推 24kg 11 34kg 8 44kg 2x7+6+5')!;assert.ok(unconfirmed.questions.length);assert.ok(unconfirmed.sets!.every(s=>s.kg===44));
});

test('strength duration uses the latest explicit correction, independently of mixed running',()=>{
 const text='卧推 32kg 3x8\n力量训练65分钟\n跑步4km 配速6分/公里 用时24分钟\n补充：实际力量训练42分钟';
 const a=parseTraining(text)!;assert.equal(a.training!.durationMinutes,42);assert.equal(a.run!.minutes,24);assert.equal(a.run!.km,4);
 assert.equal(inferSession(text,a.sets).durationMinutes,42);
 assert.equal(strengthDurationMinutes('力量训练65分钟\n补充：实际40分钟'),40);
 assert.equal(strengthDurationMinutes('力量训练65分钟\n补充：跑步实际40分钟'),65);
 assert.equal(strengthDurationMinutes('力量训练65分钟\n下次力量训练40分钟'),65);
 assert.equal(strengthDurationMinutes('下次力量训练30分钟'),undefined);
 assert.equal(strengthDurationMinutes('补充：计划力量训练30分钟'),undefined);
 assert.equal(strengthDurationMinutes('跑步4km用时24分钟\n补充：实际40分钟'),undefined);
});

test('a saved supplement creates an evidenced convention reused by later training, never by earlier logs',t=>{
 const store=setup(t),initial=store.importEnvelope(row('卧推 28kg 9')).record;
 assert.equal(initial.status,'needs_info');
 const answer='我的记录习惯是组数x次数，只有一个数字就是1组x次数，为什么这次还在问我？';
 const updated=store.revise(initial.id,{followup:{answer,questions:initial.analysis!.questions}},initial.revision);
 assert.equal(updated.status,'ready');assert.deepEqual(updated.analysis!.sets!.map(s=>[s.kg,s.sets,s.reps]),[[28,1,9]]);
 const memory=store.memories().find(m=>m.topicKey==='recording.training_notation')!;
 assert.ok(memory?.confirmed);assert.deepEqual(detectTrainingNotation(memory.text),{setsFirst:true,singleNumberIsReps:true});
 assert.equal(memory.evidence?.[0].quote,'我的记录习惯是组数x次数，只有一个数字就是1组x次数');assert.ok(updated.text.includes(memory.evidence![0].quote));
 assert.equal(memory.evidence?.[0].recordRevision,updated.revision);
 const later=store.importEnvelope(row('卧推 33kg 8','2026-10-21T18:00:00+08:00')).record;
 assert.equal(later.status,'ready');assert.equal(later.analysis!.sets![0].reps,8);
 const earlier=store.importEnvelope(row('卧推 25kg 10','2026-10-19T18:00:00+08:00')).record;
 assert.equal(earlier.status,'needs_info');assert.equal(earlier.analysis!.sets!.length,0);
});

test('unanswered notation and preference questions never become confirmed automatic memories',t=>{
 const store=setup(t);
 for(const text of ['组数x次数？','只有一个数字就是次数?','组数x次数，还是次数x组数？','我喜欢晚上训练吗？'])store.importEnvelope(row(text));
 assert.equal(store.memories().filter(m=>m.autoCategory==='preference').length,0);
});

test('legacy notation repair preserves raw text and undo history, backs up and runs only once',t=>{
 const store=setup(t),r=store.importEnvelope(row('卧推 23kg 10 33kg 8 43kg 2x6+5')).record;
 const raw=r.text+'\n\n补充：组数x次数，只有一个数字就是1组x次数';
 const legacy={...r,text:raw,revision:5};
 store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(legacy),r.id);
 assert.equal(store.migrateTrainingNotationParsing(),1);
 assert.ok(readdirSync(path.join(store.root,'backups')).some(name=>name.startsWith('before-training-notation-')));
 const fixed=store.record(r.id);assert.equal(fixed.text,raw);assert.equal(fixed.status,'ready');assert.equal(fixed.revision,6);
 assert.deepEqual(fixed.analysis!.sets!.map(s=>[s.kg,s.sets,s.reps]),[[23,1,10],[33,1,8],[43,2,6],[43,1,5]]);
 assert.equal(store.migrateTrainingNotationParsing(),0);assert.equal(store.record(r.id).revision,6);
 const undone=store.undoRecord(r.id);assert.equal(undone.text,raw);assert.equal(undone.status,legacy.status);assert.deepEqual(undone.analysis?.sets,legacy.analysis?.sets);
});

test('partial record convention corrections retain the other facet with separate source evidence',t=>{
 const store=setup(t),first=store.importEnvelope(row('以后按组数x次数记录，只有一个数字就是1组x次数')).record;
 const second=store.importEnvelope(row('以后按次数x组数记录','2026-10-21T18:00:00+08:00')).record;
 let m=store.memories().find(m=>m.topicKey==='recording.training_notation')!;
 assert.deepEqual(detectTrainingNotation(m.text),{setsFirst:false,singleNumberIsReps:true});
 assert.deepEqual(new Set(m.evidence?.map(e=>e.recordId)),new Set([first.id,second.id]));
 for(const e of m.evidence??[])assert.ok(store.record(e.recordId!).text.includes(e.quote));
 const third=store.importEnvelope(row('以后单个数字不是次数','2026-10-22T18:00:00+08:00')).record;
 m=store.memories().find(x=>x.id===m.id)!;
 assert.deepEqual(detectTrainingNotation(m.text),{setsFirst:false,singleNumberIsReps:false});
 assert.deepEqual(new Set(m.sourceIds),new Set([second.id,third.id]));
 store.revise(third.id,{deleted:true},third.revision);
 assert.deepEqual(detectTrainingNotation(store.memories().find(m=>m.topicKey==='recording.training_notation')!.text),{setsFirst:false,singleNumberIsReps:true});
});

test('manual notation replacement forms a cutoff, and deactivated conventions never return through automatic refresh',t=>{
 const store=setup(t);store.importEnvelope(row('组数x次数，只有一个数字就是1组x次数'));
 let m=store.memories().find(m=>m.topicKey==='recording.training_notation')!;
 m=store.saveMemory({...m,text:'以后按组数x次数记录',startsAt:'2026-10-21T18:00:00+08:00',evidence:[{quote:'以后按组数x次数记录',origin:'user',at:'2026-10-21T18:00:00+08:00'}]},m.id);
 store.importEnvelope(row('以后按次数x组数记录','2026-10-22T18:00:00+08:00'));
 m=store.memories().find(x=>x.id===m.id)!;assert.deepEqual(detectTrainingNotation(m.text),{setsFirst:false});
 store.refreshAutomaticMemories();m=store.memories().find(x=>x.id===m.id)!;assert.deepEqual(detectTrainingNotation(m.text),{setsFirst:false});
 store.saveMemory({...m,active:false},m.id);
 store.importEnvelope(row('单个数字表示次数','2026-10-23T18:00:00+08:00'));
 store.refreshAutomaticMemories();assert.equal(store.memories().find(x=>x.id===m.id)!.active,false);
});

test('pure convention merge keeps sourced untouched facets and never reuses inactive or stale facts',()=>{
 const old={text:'组数x次数，单个数字表示次数',evidence:[{quote:'组数x次数，单个数字表示次数',origin:'user' as const,messageId:randomUUID()}]},next={text:'次数x组数',evidence:[{quote:'以后按次数x组数记录',origin:'user' as const,messageId:randomUUID()}]};
 const merged=mergeTrainingNotation(old,next);assert.deepEqual(detectTrainingNotation(merged.text),{setsFirst:false,singleNumberIsReps:true});assert.deepEqual(new Set(merged.evidence),new Set([...old.evidence,...next.evidence]));
 assert.deepEqual(detectTrainingNotation(mergeTrainingNotation({...old,active:false},next).text),{setsFirst:false});
 assert.deepEqual(detectTrainingNotation(mergeTrainingNotation({...old,stale:true},next).text),{setsFirst:false});
});
