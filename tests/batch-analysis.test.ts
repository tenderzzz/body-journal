import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AssistantService} from '../electron/ai/service';
import type {ChatGPTAuth,SecretStorage} from '../electron/ai/auth';
import type {NetworkFetch} from '../electron/ai/network';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {needsAnalysis} from '../src/shared/stats';
const secrets:SecretStorage={read:async()=>({}),write:async()=>{}};
const auth={accessToken:async()=>'synthetic-token'} as unknown as ChatGPTAuth;
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-batch-test-')),store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);store.setSettings({...store.getSettings(),chatgptModel:'synthetic-model'});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return store;}
function add(s:HealthStore,id:string,kind:'note'|'training'='note'){return s.importEnvelope({version:1,id,kind,occurredAt:new Date().toISOString(),timezone:'Asia/Shanghai',text:kind==='note'?'合成日记，用于队列测试':'合成训练记录'}).record;}
function response(output:unknown){return new Response([{type:'response.output_text.delta',delta:JSON.stringify(output)},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:10}}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));}
const valid=()=>response({summary:'合成分析完成',questions:[],assumptions:[]});
function service(s:HealthStore,request:NetworkFetch,emit:(e:Record<string,unknown>)=>void=()=>{}){return new AssistantService(s,auth,secrets,emit,x=>x,request);}
test('one batch processes every initial ID beyond the former ten and thirty limits, with dedupe and receipt',async t=>{
 const s=setup(t),ids=Array.from({length:35},(_,i)=>add(s,`batch-many-${i}`).id),events:Record<string,unknown>[]=[];let calls=0;
 const result=await service(s,async()=>{calls++;return valid();},e=>events.push(e)).analyze([...ids,ids[0]],{pendingOnly:true});
 assert.equal(calls,35);assert.equal(result.total,35);assert.equal(result.completed,35);assert.equal(result.failed,0);assert.deepEqual(result.remaining,[]);assert.equal(events.filter(e=>e.type==='analysis-progress').length,35);assert.equal(events.at(-1)?.type,'busy');assert.equal(events.find(e=>e.type==='analysis-complete')?.result,result);assert.ok(ids.every(id=>!needsAnalysis(s.record(id))));
});
test('an invalid record result does not block later records and retry never recharges successful ones',async t=>{
 const s=setup(t),ids=['batch-good-first','batch-invalid-middle','batch-good-last'].map(id=>add(s,id).id),calls:string[]=[];let fail=true;
 const svc=service(s,async(_url,init)=>{const p=JSON.parse(JSON.parse(String(init?.body)).input[0].content[0].text),id=p.record.id;calls.push(id);return id===ids[1]&&fail?response({questions:[]}):valid();});
 const first=await svc.analyze(ids,{pendingOnly:true});assert.equal(first.completed,2);assert.equal(first.failed,1);assert.deepEqual(first.remaining,[]);assert.equal(s.record(ids[1]).analysisPending,true);assert.match(s.record(ids[1]).analysisError??'',/summary/);assert.equal(s.record(ids[1]).revision,1);
 fail=false;const second=await svc.analyze(ids,{pendingOnly:true});assert.equal(second.completed,1);assert.equal(second.skipped,2);assert.deepEqual(calls,[ids[0],ids[1],ids[2],ids[1]]);assert.equal(s.record(ids[1]).analysisPending,false);assert.equal(s.record(ids[1]).analysisError,undefined);
});
test('analyzed needs-info records await answers instead of endlessly requeuing unchanged',async t=>{
 const s=setup(t),r=add(s,'batch-awaiting-user');let calls=0;const svc=service(s,async()=>{calls++;return response({summary:'需要补充',questions:['这句话指的是哪一天？'],assumptions:[]});});
 const result=await svc.analyze([r.id],{pendingOnly:true});assert.equal(result.completed,1);assert.equal(result.items[0].record?.status,'needs_info');assert.equal(s.record(r.id).analysisPending,false);assert.equal(needsAnalysis(s.record(r.id)),false);
 const again=await svc.analyze([r.id],{pendingOnly:true});assert.equal(again.skipped,1);assert.equal(calls,1);
});
test('a shared network or quota failure stops untouched records without automatic retries',async t=>{
 const s=setup(t),ids=['batch-network-first','batch-network-second','batch-network-third'].map(id=>add(s,id).id);let calls=0;
 const network=service(s,async()=>{calls++;throw new TypeError('fetch failed');});const r=await network.analyze(ids,{pendingOnly:true});assert.equal(calls,1);assert.equal(r.failed,1);assert.deepEqual(r.remaining,ids.slice(1));assert.equal(s.record(ids[0]).analysisPending,true);assert.equal(s.record(ids[1]).analysisAttemptedRevision,undefined);
 const quota=service(s,async()=>{calls++;return Response.json({error:{code:'insufficient_quota'}},{status:429});});const q=await quota.analyze(ids,{pendingOnly:true});assert.equal(calls,2);assert.equal(q.failed,1);assert.deepEqual(q.remaining,ids.slice(1));
});
test('cancellation between items keeps successful work and leaves the remainder uncharged',async t=>{
 const s=setup(t),ids=['batch-cancel-first','batch-cancel-second','batch-cancel-third'].map(id=>add(s,id).id);let calls=0,svc:AssistantService;
 svc=service(s,async()=>{calls++;return valid();},e=>{if(e.type==='analysis-result'&&(e.item as {status:string}).status==='completed')svc.cancel();});
 const r=await svc.analyze(ids,{pendingOnly:true});assert.equal(calls,1);assert.equal(r.completed,1);assert.equal(r.cancelled,true);assert.deepEqual(r.remaining,ids.slice(1));assert.equal(s.record(ids[0]).analysisPending,false);assert.equal(svc.isBusy(),false);
});
test('cancellation during an in-flight request retains its record and the untouched queue',async t=>{
 const s=setup(t),ids=['batch-cancel-active','batch-cancel-untouched'].map(id=>add(s,id).id);let calls=0,svc:AssistantService;
 svc=service(s,async(_url,init)=>{calls++;svc.cancel();init?.signal?.throwIfAborted();return valid();});
 const r=await svc.analyze(ids,{pendingOnly:true});assert.equal(calls,1);assert.equal(r.cancelled,true);assert.equal(r.completed,0);assert.deepEqual(r.remaining,ids);assert.equal(r.items[0].status,'cancelled');assert.equal(s.record(ids[0]).revision,1);assert.equal(s.record(ids[0]).analysisPending,true);assert.equal(s.record(ids[1]).analysisAttemptedRevision,undefined);
});
test('single explicit failure rejects after publishing a receipt; single pending failure returns the receipt',async t=>{
 const s=setup(t),r=add(s,'batch-single-error'),events:Record<string,unknown>[]=[];const svc=service(s,async()=>response({questions:[]}),e=>events.push(e));
 await assert.rejects(()=>svc.analyze([r.id]),/summary/);assert.equal((events.find(e=>e.type==='analysis-complete')?.result as {failed:number}).failed,1);
 const report=await svc.analyze([r.id],{pendingOnly:true});assert.equal(report.failed,1);assert.equal(report.total,1);
});
test('saved followups retain the original question and are sent with previous structured analysis',async t=>{
 const s=setup(t),r=add(s,'batch-followup-context','training');const old=s.applyAnalysis(r.id,{summary:'合成待确认训练',questions:['第三行是三组还是四组？'],training:{part:'chest',completion:'unknown'},sets:[]},'chatgpt',r.revision);
 const saved=s.revise(r.id,{followup:{questions:old.analysis!.questions,answer:'是三组，每组10次，单只10kg'}},old.revision);assert.equal(saved.analysisPending,true);assert.equal(saved.followups?.[0].questions[0],'第三行是三组还是四组？');
 let request:Record<string,any>|undefined;
 const svc=service(s,async(_url,init)=>{request=JSON.parse(JSON.parse(String(init?.body)).input[0].content[0].text);return response({summary:'补充已用于合成整理',questions:[],training:{part:'chest',completion:'completed'},sets:[]});});
 const result=await svc.analyze([saved.id]);assert.equal(result.completed,1);assert.equal(request!.record.followups[0].answer,'是三组，每组10次，单只10kg');assert.equal(request!.record.previousAnalysis.questions[0],'第三行是三组还是四组？');assert.equal(s.record(r.id).analysisPending,false);
});
test('legacy local needs-info and failed explicit training are discoverable without treating every AI question as pending',async t=>{
 const s=setup(t),r=add(s,'batch-local-followup','training'),updated=s.revise(r.id,{text:'卧推 50kg 3x8\n补充：今天感觉正常'},r.revision);assert.equal(needsAnalysis({...updated,analysisPending:undefined}),updated.status==='needs_info');
 const svc=service(s,async()=>{throw new TypeError('fetch failed');});await assert.rejects(()=>svc.analyze([r.id]),/网络/);assert.equal(needsAnalysis(s.record(r.id)),true);assert.ok(s.record(r.id).analysisError);
});
