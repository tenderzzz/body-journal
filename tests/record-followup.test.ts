import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';

function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'record-followup-'));const s=new HealthStore(root,new FoodCatalog([]),path.join(root,'inbox'),false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return s;}
function training(s:HealthStore){return s.importEnvelope({version:1,id:'synthetic-duration-record',kind:'training',text:'卧推32kg 3x8\n力量训练65分钟',occurredAt:'2026-10-20T19:00:00+08:00',timezone:'Asia/Shanghai'}).record;}

test('an explicit followup duration supersedes only the earlier duration correction',t=>{
 const s=setup(t);let r=training(s);r=s.updateActivity({id:r.id,revision:r.revision,trainingMinutes:55,run:{activeKcal:210}});
 r=s.revise(r.id,{followup:{answer:'更正：实际力量训练42分钟',questions:[]}},r.revision);
 assert.equal(r.analysis?.training?.durationMinutes,42);assert.equal(r.analysis?.activityOverrides?.training?.durationMinutes,42);assert.equal(r.analysis?.run?.activeKcal,210);
 r=s.applyAnalysis(r.id,{summary:'合成重新分析',questions:[],training:{part:'chest',completion:'completed',durationMinutes:65}},'chatgpt',r.revision);
 assert.equal(r.analysis?.training?.durationMinutes,42);assert.equal(r.analysis?.run?.activeKcal,210);
 r=s.revise(r.id,{followup:{answer:'下次力量训练30分钟',questions:[]}},r.revision);assert.equal(r.analysis?.training?.durationMinutes,42);
});

test('followup metadata and failed status survive backup; malformed followups are rejected before restore',t=>{
 const s=setup(t);let r=training(s);r=s.revise(r.id,{followup:{answer:'今天感觉正常',questions:['恢复情况如何？']}},r.revision);s.markAnalysisFailure(r.id,r.revision,'合成网络失败');
 const before=s.record(r.id),bundle=s.exportBundle();s.restore(bundle);assert.deepEqual(s.record(r.id),before);
 const damaged=structuredClone(bundle),row=(damaged.tables.records as {id:string;doc:string}[]).find(x=>x.id===r.id)!;const doc=JSON.parse(row.doc);doc.followups[0].answer=null;row.doc=JSON.stringify(doc);
 assert.throws(()=>s.restore(damaged));assert.deepEqual(s.record(r.id),before);
});

test('a followup can correct the record date without losing the original text',t=>{
 const s=setup(t),r=training(s),next=s.revise(r.id,{followup:{answer:'更正：这是2026年10月19日的训练',questions:[]}},r.revision);
 assert.equal(next.occurredAt.slice(0,10),'2026-10-19');assert.ok(next.text.startsWith(r.text+'\n\n补充：'));assert.equal(next.followups?.length,1);
});
