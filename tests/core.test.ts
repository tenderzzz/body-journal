import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FoodCatalog } from '../electron/core/nutrition';
import { HealthStore, sha256 } from '../electron/core/store';
import { parseTraining, splitHistorical } from '../electron/core/parser';
import { computeStats, localDay, validMemory } from '../src/shared/stats';
import { envelopeSchema } from '../electron/core/validation';
import type { Envelope, Food } from '../src/shared/types';

const foods:Food[]=[{id:1,description:'Test rice',kcal:130,protein:2.7,carbs:28,fat:.3,source:'test fixture'},{id:2,description:'Test egg',kcal:155,protein:13,carbs:1.1,fat:11,source:'test fixture'}];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGqoAAAAASUVORK5CYII=','base64');
function setup(t:test.TestContext){const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-test-'));const inbox=path.join(dir,'inbox');mkdirSync(inbox);const store=new HealthStore(path.join(dir,'vault'),new FoodCatalog(foods),inbox,false);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir,inbox};}
function envelope(changes:Partial<Envelope>={}):Envelope{return {version:1,id:randomUUID(),kind:'note',occurredAt:'2026-10-22T20:00:00+08:00',timezone:'Asia/Shanghai',text:'今天精力一般',...changes};}

test('iCloud records import exactly once, incomplete JSON and attachments retry later',t=>{
 const {store,inbox}=setup(t);const e=envelope({kind:'meal',attachments:[{name:'lunch.png',path:'lunch.png',sha256:sha256(png)}]});
 writeFileSync(path.join(inbox,'meal.json'),'{"version":');assert.equal(store.scanInbox().pending,1);assert.equal(store.records().length,0);
 writeFileSync(path.join(inbox,'meal.json'),JSON.stringify(e));assert.equal(store.scanInbox().pending,1);
 writeFileSync(path.join(inbox,'lunch.png'),png);assert.equal(store.scanInbox().imported,1);assert.equal(store.scanInbox().imported,0);assert.equal(store.records().length,1);
 assert.equal(store.attachmentData(e.id,0),`data:image/png;base64,${png.toString('base64')}`);
 writeFileSync(path.join(inbox,'meal.json'),JSON.stringify({...e,text:'changed'}));assert.match(store.scanInbox().errors[0],/同一个记录编号/);
});
test('capture supports inline images with wrapped base64 and quote/newline text',t=>{const {store}=setup(t);const e=envelope({kind:'meal',text:'“鸡肉”\n他说 "半碗"',imageBase64:png.toString('base64').match(/.{1,40}/g)!.join('\n')});const r=store.importEnvelope(e).record;assert.equal(r.text,e.text);assert.equal(r.attachments.length,1);});
test('Shortcut encoded text round-trips Unicode, quotes and newlines; malformed encoding is rejected',t=>{const {store}=setup(t);const value='睡眠 7 小时\n他说 "半碗饭" 🍚';const encoded=Buffer.from(value).toString('base64');const r=store.importEnvelope({...envelope(),textBase64:encoded,imageBase64:''}).record;assert.equal(r.text,value);assert.throws(()=>store.importEnvelope({...envelope(),textBase64:'@@@@'}));assert.throws(()=>store.importEnvelope({...envelope(),textBase64:'/w=='}));});
test('training feelings do not make explicit sets ambiguous; load basis stays comparable',()=>{const a=parseTraining('哑铃划船 单手 20kg 3组×10次\n感受：最后一组比较吃力');assert.equal(a!.questions.length,0);assert.equal(a!.sets![0].exercise,'哑铃划船');assert.equal(a!.sets![0].loadBasis,'per_hand');assert.match(a!.sets![0].effort!,/吃力/);});
test('external paths, symlinks, invalid units and missing timezone fail before import',t=>{
 const {store,inbox,dir}=setup(t);writeFileSync(path.join(dir,'outside.png'),png);symlinkSync(path.join(dir,'outside.png'),path.join(inbox,'link.png'));
 for(const file of ['../outside.png','/etc/passwd','link.png'])assert.throws(()=>store.importEnvelope(envelope({attachments:[{name:'x',path:file}]}),inbox));
 assert.throws(()=>envelopeSchema.parse(envelope({occurredAt:'2026-10-24T12:00:00'})));
 assert.throws(()=>store.importEnvelope(envelope({kind:'body',body:{weightKg:-2}})));assert.equal(store.records().length,0);
});
test('body values preserve units, timezone and real observed gaps',t=>{
 const {store}=setup(t);const a=store.importEnvelope(envelope({kind:'body',text:'体重 144斤，腰围 81cm',occurredAt:'2026-10-22T23:30:00-04:00',timezone:'America/New_York'})).record;
 assert.equal(a.body?.weightKg,72);assert.equal(a.body?.waistCm,81);assert.equal(localDay(a.occurredAt,'Asia/Shanghai'),'2026-10-23');
 store.importEnvelope(envelope({kind:'body',body:{weightKg:71.8},occurredAt:'2026-10-26T08:00:00+08:00'}));const s=computeStats(store.records());assert.equal(s.measurements.length,2);assert.equal(s.measurements[1].waistCm,undefined);
});
test('training parser applies single-hand dumbbell rule, converts pounds and refuses ambiguous set notation',()=>{
 assert.deepEqual(parseTraining('卧推 60kg 3×8')!.sets!.map(s=>[s.sets,s.reps]),[[3,8]]);
 assert.equal(parseTraining('哑铃划船 20kg 3组×10次')!.sets![0].confirmed,true);
 assert.equal(parseTraining('哑铃划船 20kg 3组×10次')!.sets![0].loadBasis,'per_hand');
 assert.equal(parseTraining('卧推 100lb 3组×8次')!.sets![0].kg,45.359);
 assert.deepEqual(parseTraining('卧推 60kg 8次×3组')!.sets!.map(s=>[s.kg,s.reps,s.sets]),[[60,8,3]]);
 assert.equal(parseTraining('跑步 5km 30分钟')!.run!.km,5);
});
test('historical date headers split records and reject ambiguous or nonexistent dates',()=>{
 assert.equal(splitHistorical('2026-10-20\n卧推 60kg 3组×8次\n2026/10/22\n深蹲 80kg 3组×6次').length,2);
 assert.throws(()=>splitHistorical('卧推 60kg 3组×8次'),/日期/);assert.throws(()=>splitHistorical('2026-02-30\n卧推'),/不存在/);
});
test('revision, undo and deletion preserve originals, invalidate old evidence and avoid reimport',t=>{
 const {store}=setup(t);const e=envelope({kind:'training',text:'卧推 60kg 3组×8次'});const r=store.importEnvelope(e).record;const msg={id:randomUUID(),role:'assistant' as const,text:'之前的回答',createdAt:new Date().toISOString(),status:'complete' as const,sources:[{id:r.id,revision:r.revision}],provider:'test',stale:false};store.putMessage(msg);
 const hypothesis=store.saveMemory({kind:'hypothesis',text:'待验证的训练变化',startsAt:e.occurredAt,expiresAt:null,sourceIds:[r.id],active:true,confirmed:false});
 const edited=store.revise(r.id,{text:'卧推 65kg 3组×8次'},1);assert.equal(computeStats(store.records()).exercises['杠铃平板卧推'][0].volume,1560);assert.equal(store.messages()[0].stale,true);assert.equal(store.memories().find(m=>m.id===hypothesis.id)!.stale,true);
 assert.equal(JSON.parse(readFileSync(path.join(store.root,'raw',`${r.id}.json`),'utf8')).text,e.text);
 assert.throws(()=>store.revise(r.id,{text:'旧页面编辑'},1),/已变化/);const undo=store.undoRecord(r.id);assert.equal(undo.text,e.text);assert.equal(undo.revision,3);
 store.revise(r.id,{deleted:true},undo.revision);assert.equal(store.records().length,0);assert.equal(store.importEnvelope(e).duplicate,true);assert.equal(store.records().length,0);
});
test('analysis finishing after an edit cannot overwrite new records',t=>{const {store}=setup(t);const r=store.importEnvelope(envelope()).record;store.revise(r.id,{text:'更正：今天精力很好'},1);assert.throws(()=>store.applyAnalysis(r.id,{summary:'old',questions:[],assumptions:[]},'chatgpt',1),/未覆盖/);assert.equal(store.record(r.id).text,'更正：今天精力很好');});
test('nutrition ranges calculate locally and unmatched food never becomes zero intake',t=>{
 const {store}=setup(t);const r=store.importEnvelope(envelope({kind:'meal'})).record;
 const result=store.applyAnalysis(r.id,{summary:'估算',questions:[],assumptions:['米饭的实际食用量'],ingredients:[{name:'米饭',foodId:1,grams:{low:100,high:200},assumption:'份量不确定'},{name:'鸡蛋',foodId:2,grams:{low:50,high:50},assumption:'约一枚'},{name:'未知酱汁',foodId:null,grams:{low:10,high:20},assumption:'未知配方'}]},'local',1);
 assert.deepEqual(result.analysis!.macros!.kcal,{low:207.5,high:337.5});assert.deepEqual(result.analysis!.macros!.protein,{low:9.2,high:11.9});assert.deepEqual(result.analysis!.unmatched,['未知酱汁']);
 store.importEnvelope(envelope({kind:'meal',occurredAt:'2026-10-23T12:00:00+08:00'}));const s=computeStats(store.records());assert.equal(s.nutrition.length,2);assert.equal(s.nutrition[1].estimated,0);assert.equal(s.nutrition[0].meals,1);assert.equal(s.nutrition[0].unmatched,1);
});
test('memory is bounded by dates and editable with undo',t=>{const {store}=setup(t);const m=store.saveMemory({kind:'state',text:'这周学习忙',startsAt:'2026-10-20T00:00:00+08:00',expiresAt:'2026-10-25T00:00:00+08:00',sourceIds:[],active:true,confirmed:true});assert.equal(validMemory(m,new Date('2026-10-24T12:00:00+08:00')),true);assert.equal(validMemory(m,new Date('2026-10-26T12:00:00+08:00')),false);store.saveMemory({...m,text:'这周安排放松了'},m.id);assert.equal(store.undoMemory(m.id).text,m.text);assert.throws(()=>store.saveMemory({...m,kind:'fact',confirmed:false}),/确认/);});
test('complete backup restores records, original images, revisions, conversations, memories; no credentials',t=>{
 const {store,dir}=setup(t);const e=envelope({kind:'meal',imageBase64:png.toString('base64')});const r=store.importEnvelope(e).record;store.revise(r.id,{text:'补充：米饭剩一半'},1);store.saveMemory({kind:'fact',text:'吃食堂',startsAt:e.occurredAt,expiresAt:null,sourceIds:[],active:true,confirmed:true});store.putMessage({id:randomUUID(),role:'user',text:'最近怎么样',createdAt:e.occurredAt,status:'complete',sources:[],provider:'chatgpt',stale:false});
 const bundle=store.exportBundle();assert.equal(JSON.stringify(bundle).includes('access_token'),false);const second=new HealthStore(path.join(dir,'restored'),new FoodCatalog(foods),path.join(dir,'new-inbox'),false);try{second.restore(bundle);assert.deepEqual(second.records(),store.records());assert.equal(second.attachmentData(r.id,0),store.attachmentData(r.id,0));assert.deepEqual(second.memories(),store.memories());assert.equal(second.messages().length,1);assert.equal(second.history(r.id).length,1);assert.equal(second.getSettings().inbox,path.join(dir,'new-inbox'));}finally{second.close();}
 const damaged=structuredClone(bundle);damaged.files[0].base64='corrupted';assert.throws(()=>store.restore(damaged),/校验/);assert.equal(store.attachmentData(r.id,0),`data:image/png;base64,${png.toString('base64')}`);
});
test('budget reserves before requests, keeps uncertain spend and refuses exhausted budgets',t=>{const {store}=setup(t);store.setSettings({...store.getSettings(),deepseekBudget:1});const id=store.reserveUsage('deepseek',.8);assert.throws(()=>store.reserveUsage('deepseek',.3),/预算不足/);store.failUsage(id);assert.equal(store.usage().uncertain,true);store.finishUsage(id,100,200,.1);assert.equal(store.usage().cost,.1);assert.equal(store.usage().uncertain,false);});
test('mixed timezone timestamps sort by actual instant, not ISO text',t=>{const {store}=setup(t);const later=store.importEnvelope(envelope({kind:'body',body:{weightKg:72},occurredAt:'2026-10-20T23:30:00-04:00'})).record;const earlier=store.importEnvelope(envelope({kind:'body',body:{weightKg:71},occurredAt:'2026-10-21T08:00:00+08:00'})).record;assert.equal(store.records()[0].id,later.id);assert.equal(computeStats(store.records()).measurements[0].id,earlier.id);});
test('rejects nonexistent calendar dates and waits for incomplete image content',t=>{const {store}=setup(t);assert.throws(()=>store.importEnvelope(envelope({occurredAt:'2026-02-30T12:00:00+08:00'})));assert.throws(()=>store.importEnvelope(envelope({kind:'meal',imageBase64:png.subarray(0,30).toString('base64')})),/尚未同步完整/);assert.equal(store.records().length,0);});
test('invalid memory from model does not partially commit record analysis',t=>{const {store}=setup(t);const r=store.importEnvelope(envelope()).record;assert.throws(()=>store.applyAnalysis(r.id,{summary:'近期忙碌',questions:[],assumptions:[],memories:[{kind:'state',text:'忙碌',expiresAt:'2026-10-01T00:00:00+08:00'}]},'chatgpt',1));assert.equal(store.record(r.id).revision,1);assert.equal(store.record(r.id).analysis,null);});
test('malformed revision backup is rejected before changing current state',t=>{const {store}=setup(t);const r=store.importEnvelope(envelope()).record;store.revise(r.id,{text:'更正内容'},1);const b=store.exportBundle();(b.tables.revisions[0] as {doc:string}).doc='broken json';assert.throws(()=>store.restore(b));assert.equal(store.record(r.id).revision,2);assert.equal(store.history(r.id)[0].record!==undefined,true);});


test('legacy Shortcut missing time recovers with provenance, unchanged original and stable dedupe',t=>{
 const {store,inbox}=setup(t);
 const e={version:1,id:'-2777069',kind:'training',occurredAt:'',timezone:'Asia/Shanghai',textBase64:Buffer.from('卧推 60kg 3组×8次').toString('base64'),imageBase64:''};
 const file=path.join(inbox,`${e.id}.health.json`);const original=JSON.stringify(e);writeFileSync(file,original);
 const saved=new Date('2026-10-25T02:32:47Z');utimesSync(file,saved,saved);
 assert.equal(store.scanInbox().imported,1);assert.equal(store.syncState.errors.length,0);
 const r=store.record(e.id);assert.equal(r.occurredAt,saved.toISOString());assert.equal(r.timeSource,'file_modified');
 assert.equal(r.text,'卧推 60kg 3组×8次');assert.equal(readFileSync(file,'utf8'),original);
 const raw=JSON.parse(readFileSync(path.join(store.root,'raw',`${r.id}.json`),'utf8'));assert.equal(raw.occurredAt,'');assert.equal(raw.timeRecovery.usedAt,saved.toISOString());
 assert.equal(store.context('全部').records[0].timeSource,'file_modified');
 utimesSync(file,new Date(),new Date());assert.equal(store.scanInbox().imported,0);assert.equal(store.syncState.errors.length,0);assert.equal(store.record(r.id).occurredAt,saved.toISOString());
 const edited=store.revise(r.id,{text:'卧推 65kg 3组×8次'},1);assert.equal(edited.timeSource,'file_modified');
 const confirmed=store.revise(r.id,{occurredAt:'2026-10-24T12:00:00+08:00'},edited.revision);assert.equal(confirmed.timeSource,undefined);
 assert.equal(store.scanInbox().imported,0);assert.equal(store.record(r.id).occurredAt,confirmed.occurredAt);assert.equal(store.undoRecord(r.id).timeSource,'file_modified');
});
test('missing timestamp recovery is restricted to the exact legacy Shortcut envelope',t=>{
 const {store,inbox}=setup(t);const e={version:1,id:'-1234567',kind:'note',occurredAt:'',timezone:'Asia/Shanghai',textBase64:Buffer.from('测试').toString('base64'),imageBase64:''};
 assert.throws(()=>store.importEnvelope(e));
 for(const [name,data] of [['unknown.json',e],['-7654321.health.json',e],['-1234567.health.json',{...e,occurredAt:'bad date'}],['-1234568.health.json',{...e,id:'-1234568',textBase64:undefined,text:'test'}]] as const)writeFileSync(path.join(inbox,name),JSON.stringify(data));
 assert.equal(store.scanInbox().imported,0);assert.equal(store.syncState.errors.length,4);
});

test('nutrition includes label and estimated foods once, scales portions and sums the day',t=>{
 const {store}=setup(t);const r=store.importEnvelope(envelope({kind:'meal'})).record;
 const ingredients=[{name:'米饭',foodId:1,grams:{low:100,high:100},assumption:'测试份量'},
 {name:'包装食品',foodId:2,grams:{low:30,high:30},assumption:'标签优先，不能与食材库重复计入',nutrition:{source:'label',basis:'测试标签：每100g，能量单位kcal',per100g:{kcal:{low:400,high:400},protein:{low:80,high:80},carbs:{low:10,high:10},fat:{low:4,high:4}}}},
 {name:'混合酱汁',foodId:null,grams:{low:20,high:40},assumption:'测试估算',nutrition:{source:'estimate',basis:'测试同类配方范围',per100g:{kcal:{low:200,high:300},protein:{low:2,high:4},carbs:{low:10,high:20},fat:{low:16,high:24}}}}];
 const a=store.applyAnalysis(r.id,{summary:'已包含估算',questions:['分量可以再确认'],assumptions:[],ingredients},'chatgpt',1);
 assert.deepEqual(a.analysis!.macros!.kcal,{low:290,high:370});assert.deepEqual(a.analysis!.macros!.protein,{low:27.1,high:28.3});assert.deepEqual(a.analysis!.macros!.carbs,{low:33,high:39});assert.deepEqual(a.analysis!.macros!.fat,{low:4.7,high:11.1});assert.deepEqual(a.analysis!.unmatched,[]);assert.deepEqual(a.analysis!.estimatedFoods,['混合酱汁']);assert.equal(a.status,'needs_info');
 const second=store.importEnvelope(envelope({kind:'meal'})).record;store.applyAnalysis(second.id,{summary:'第二餐',questions:[],assumptions:[],ingredients:[ingredients[0]]},'local',1);
 let day=computeStats(store.records()).nutrition[0];assert.deepEqual(day.kcal,{low:420,high:500});assert.equal(day.estimatedItems,1);assert.equal(day.estimated,2);
 ingredients[1].grams={low:60,high:60};store.applyAnalysis(r.id,{summary:'改分量',questions:[],assumptions:[],ingredients},'local',a.revision);
 day=computeStats(store.records()).nutrition[0];assert.deepEqual(day.kcal,{low:540,high:620});
 const bundle=store.exportBundle();store.restore(bundle);assert.deepEqual(store.record(r.id).analysis!.ingredients![1].nutrition,ingredients[1].nutrition);
});
test('new AI meal analyses cannot silently omit ingredients with no nutrition estimate',t=>{
 const {store}=setup(t);const r=store.importEnvelope(envelope({kind:'meal'})).record;
 const a={summary:'缺少估算',questions:[],assumptions:[],ingredients:[{name:'未知混合菜',foodId:null,grams:{low:100,high:150},assumption:'估计分量'}]};
 assert.throws(()=>store.applyAnalysis(r.id,a,'chatgpt',1),/估算/);assert.equal(store.record(r.id).revision,1);
 assert.throws(()=>store.applyAnalysis(r.id,{...a,ingredients:[{...a.ingredients[0],nutrition:{source:'estimate',basis:'',per100g:{kcal:{low:-1,high:900},protein:{low:1,high:1},carbs:{low:1,high:1},fat:{low:1,high:1}}}}]},'local',1));
 const legacy=store.applyAnalysis(r.id,a,'local',1);assert.equal(legacy.analysis!.macros,null);assert.equal(legacy.status,'pending');
});
