import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {AssistantService} from '../electron/ai/service';
import type {Message} from '../src/shared/types';
import {queryPeriod,periodBounds,temporalScope} from '../electron/core/recall';
import {localDay} from '../src/shared/stats';

function setup(t:test.TestContext){
  const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-v06-recall-'));
  const store=new HealthStore(path.join(dir,'vault'),new FoodCatalog([]),'inbox',false);
  store.setSettings({...store.getSettings(),chatgptModel:'test-model',deepseekBudget:20});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;
}
function statement(store:HealthStore,text:string,at:string){
  const user:Message={id:crypto.randomUUID(),role:'user',text,createdAt:at,status:'complete',sources:[],provider:'test',stale:false};store.putMessage(user);
  store.completeChat({...user,id:crypto.randomUUID(),role:'assistant',text:'已记下'},[{operation:'upsert',key:'training.duration',kind:'fact',text,evidenceQuote:text}],user,store.memories(),store.getSettings().goals);
  return user;
}
function openAI(value:unknown){return new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(value)})}\n\ndata: ${JSON.stringify({type:'response.completed',response:{usage:{input_tokens:10,output_tokens:10}}})}\n\n`);}
test('corrected source words cannot reenter a current request through memorySources',async t=>{
  const store=setup(t),now=Date.now();
  statement(store,'以后每次训练最多60分钟',new Date(now-86400000).toISOString());
  statement(store,'更正，以后每次训练最多45分钟',new Date(now-1000).toISOString());
  let request='';
  const service=new AssistantService(store,{accessToken:async()=>'test'} as any,{read:async()=>({}),write:async()=>{}},()=>{},x=>x,async(_url,init)=>{request=String(init?.body);return openAI({answerMarkdown:'按45分钟安排。',memoryChanges:[]});});
  await service.chat('今天训练安排多久？');
  assert.ok(request.includes('45分钟'));assert.ok(!request.includes('60分钟'));
});

test('explicit date query finds an old backfilled workout beyond 160 recent records and tracks undo/delete',t=>{
  const store=setup(t),target=store.importEnvelope({version:1,id:crypto.randomUUID(),kind:'training',text:'肩：\n哑铃肩推 12kg 3x10',occurredAt:'2026-06-10T18:00:00+08:00',dateLocked:true,timezone:'Asia/Shanghai'}).record;
  for(let i=0;i<170;i++)store.importEnvelope({version:1,id:crypto.randomUUID(),kind:'note',text:'合成近期笔记',occurredAt:'2026-10-20T12:00:00+08:00',timezone:'Asia/Shanghai'});
  const at=new Date('2026-11-02T12:00:00+08:00');
  let c=store.context('6月10日肩推做了几组？','chat',at);assert.equal(c.records.length,1);assert.equal(c.records[0].id,target.id);assert.equal(c.stats.exercises['哑铃肩推'][0].sets,3);
  const changed=store.revise(target.id,{occurredAt:'2026-06-11T18:00:00+08:00'},1);
  assert.equal(store.context('2026-06-10训练','chat',at).records.length,0);
  assert.equal(store.context('2026-06-11训练','chat',at).records.length,1);
  store.undoRecord(changed.id);store.setRecordDeleted(target.id,true);assert.equal(store.context('2026-06-10训练','chat',at).records.length,0);
});
test('date range uses local calendar boundaries across daylight saving and asks on ambiguity',()=>{
  const zone='America/New_York',now=new Date('2026-11-04T12:00:00Z');
  const q=queryPeriod('2026-11-01训练',zone,now),b=periodBounds(q.period!,zone);
  assert.equal((b.until-b.from)/3600000,24);assert.equal(localDay(new Date(b.from).toISOString(),zone),'2026-11-01');
  assert.ok(queryPeriod('6月10日和6月11日训练','Asia/Shanghai',now).clarification);
  assert.ok(queryPeriod('2026-02-30训练','Asia/Shanghai',now).clarification);
  assert.equal(queryPeriod('上周训练','Asia/Shanghai',new Date('2026-11-02T04:00:00Z')).period!.from,'2026-10-26');
});
test('this-week agreement bridges a new conversation, fades later, and remains available when asked about that week',t=>{
  const store=setup(t),monday='2026-11-02T10:00:00+08:00';
  statement(store,'这周赶课程，训练最多40分钟',new Date(monday).toISOString());
  store.setConfig('conversationStart','2026-11-03T00:00:00+08:00');
  const next=store.context('那今天肩怎么练？','chat',new Date('2026-11-03T12:00:00+08:00'));
  assert.ok(JSON.stringify(next).includes('40分钟'));assert.equal(next.episodes[0].detail,'original');
  assert.equal(store.context('今天肩怎么练？','chat',new Date('2026-11-23T12:00:00+08:00')).memories.length,0);
  const old=store.context('上次赶课程那周怎么安排训练？','chat',new Date('2026-11-23T12:00:00+08:00'));
  assert.ok(JSON.stringify(old).includes('40分钟'));assert.equal(old.query.period!.from,'2026-11-02');assert.equal(old.stats.exercises['哑铃肩推'],undefined);
  assert.equal(temporalScope('这周最多40分钟',monday,'Asia/Shanghai').expiresAt,'2026-11-08T20:00:00.000Z');
});
test('recent conversation topics survive 20 unrelated turns, ambiguity asks, and recall never changes semantic revisions',t=>{
  const store=setup(t),now=Date.now();statement(store,'以后每次训练最多45分钟',new Date(now-86400000).toISOString());
  for(let i=0;i<30;i++)store.putMessage({id:crypto.randomUUID(),role:'user',text:'合成其他对话 '+i,createdAt:new Date(now-1000+i).toISOString(),status:'complete',sources:[],provider:'test',stale:false});
  store.setConfig('conversationStart',new Date(now).toISOString());
  const before=JSON.stringify(store.memories()),c=store.context('那肩怎么练？');assert.ok(JSON.stringify(c.memories).includes('45分钟'));
  store.context('那肩怎么练？');assert.equal(JSON.stringify(store.memories()),before);
  store.putMessage({id:crypto.randomUUID(),role:'user',text:'我今天晚餐只吃一份饭',createdAt:new Date(now).toISOString(),status:'complete',sources:[],provider:'test',stale:false});
  assert.ok(store.context('那今天呢？').clarification);
});
test('historical report is anchored in the event month and cannot become a current health state',t=>{
  const store=setup(t),user:Message={id:crypto.randomUUID(),role:'user',text:'我上个月那周睡得很少',createdAt:'2026-11-02T04:00:00Z',status:'complete',sources:[],provider:'test',stale:false};store.putMessage(user);
  store.completeChat({...user,id:crypto.randomUUID(),role:'assistant',text:'保留日期'},[{operation:'upsert',key:'health.sleep',kind:'state',text:'上个月睡得少',evidenceQuote:user.text}],user,store.memories(),store.getSettings().goals);
  const m=store.memories()[0];assert.ok(m.startsAt<'2026-11-01');assert.ok(m.expiresAt!<'2026-11-02');
  assert.ok(!JSON.stringify(store.context('今天训练怎么安排？','chat',new Date('2026-11-03T04:00:00Z'))).includes('我上个月那周睡得很少'));
});
test('independent busy periods strengthen a low-risk pattern, repeated source does not',t=>{
  const store=setup(t);
  for(const [i,day] of ['2026-10-19','2026-10-20','2026-10-28'].entries()){
    const m:Message={id:'busy-episode-'+i,role:'user',text:'我今天赶课，训练最多40分钟',createdAt:day+'T04:00:00Z',status:'complete',sources:[],provider:'test',stale:false};store.putMessage(m);store.putMessage(m);
  }
  const c=store.context('今天怎么训练？','chat',new Date('2026-11-02T04:00:00Z'));
  assert.equal(c.observedPatterns.length,1);assert.equal(c.observedPatterns[0].independentDays,3);assert.equal(c.observedPatterns[0].periods,2);
});
test('both transports receive current evidence only and malformed optional candidates keep the answer',async t=>{
  for(const provider of ['chatgpt','deepseek'] as const){
    const store=setup(t),now=Date.now();store.setSettings({...store.getSettings(),provider});
    statement(store,'以后每次训练最多60分钟',new Date(now-86400000).toISOString());statement(store,'更正，以后每次训练最多45分钟',new Date(now-1000).toISOString());
    let calls=0,request='';const service=new AssistantService(store,{accessToken:async()=>'test'} as any,{read:async()=>({deepseekKey:'synthetic-key'}),write:async()=>{}},()=>{},x=>x,async(_url,init)=>{
      calls++;request=String(init?.body);const result={answerMarkdown:'按45分钟安排。',memoryChanges:[],episodeCandidates:[{quote:12},{quote:'不在原文中的内容'}]};
      return provider==='chatgpt'?openAI(result):new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(result)}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}})}\n\ndata: [DONE]\n\n`);
    });
    assert.equal(await service.chat('今天怎么训练？'),'按45分钟安排。');assert.equal(calls,1);assert.ok(!request.includes('60分钟'));
    const reply=store.messages().at(-1)!;assert.ok(reply.contextReceipt);assert.equal(reply.contextReceipt!.promptVersion,'recall-v061-1');
  }
});

test('expired temporary words cannot bypass recall through record text and scoped state falls back to the durable rule',t=>{
  const store=setup(t),now=new Date('2026-11-03T04:00:00Z');
  statement(store,'以后每次训练最多60分钟','2026-10-01T04:00:00Z');
  statement(store,'这周训练最多40分钟','2026-11-02T04:00:00Z');
  assert.ok(store.context('今天训练怎么安排？','chat',now).memories.some(m=>m.text.includes('40分钟')));
  assert.ok(!store.context('今天训练怎么安排？','chat',now).memories.some(m=>m.text.includes('60分钟')));
  store.importEnvelope({version:1,id:crypto.randomUUID(),kind:'note',text:'这周赶课训练最多40分钟',occurredAt:'2026-11-02T04:00:00Z',timezone:'Asia/Shanghai',dateLocked:true});
  const later=store.context('今天训练怎么安排？','chat',new Date('2026-11-23T04:00:00Z'));
  assert.ok(later.memories.some(m=>m.text.includes('60分钟')));assert.ok(!JSON.stringify(later).includes('40分钟'));
});
test('deactivated sources cannot return through episodes or a record summary',t=>{
  const store=setup(t);statement(store,'以后每次训练最多45分钟',new Date(Date.now()-1000).toISOString());
  const memory=store.memories()[0];store.saveMemory({...memory,active:false},memory.id);
  const c=store.context('今天训练怎么安排？');assert.equal(c.memories.length,0);assert.ok(!JSON.stringify(c).includes('45分钟'));
});
test('a historical answer depends on its historical memory version and does not expire with today',async t=>{
  const store=setup(t),now=Date.now(),past=new Date(now-4*86400000).toISOString();
  statement(store,'以后每次训练最多60分钟',past);statement(store,'更正，以后每次训练最多45分钟',new Date(now-86400000).toISOString());
  let payload='';const service=new AssistantService(store,{accessToken:async()=>'test'} as any,{read:async()=>({}),write:async()=>{}},()=>{},x=>x,async(_url,init)=>{payload=String(init?.body);return openAI({answerMarkdown:'当时的约定是最多60分钟。',memoryChanges:[]});});
  await service.chat(localDay(past,'Asia/Shanghai')+'当时训练时长约定是多少？');
  assert.ok(payload.includes('60分钟'));assert.ok(!payload.includes('45分钟'));
  store.invalidateMemoryAnswers();assert.equal(store.messages().at(-1)!.stale,false);
});
test('unfinished questions remain questions across sessions, and an explicit resolution closes them',t=>{
  const store=setup(t),at=new Date(Date.now()-1000).toISOString();
  const put=(text:string)=>store.putMessage({id:crypto.randomUUID(),role:'user',text,createdAt:at,status:'complete',sources:[],provider:'test',stale:false});
  put('肩部训练如何安排？');store.setConfig('conversationStart',new Date().toISOString());
  let c=store.context('那肩怎么练？');assert.equal(c.episodes[0].status,'open');assert.equal(c.memories.length,0);
  put('这个问题已经解决了');c=store.context('那肩怎么练？');assert.equal(c.episodes.length,0);assert.ok(!JSON.stringify(c.conversation).includes('肩部训练如何安排'));
  put('肩部训练如何安排？');put('腿部训练怎么安排？');assert.ok(store.context('那今天呢？').clarification);
});
