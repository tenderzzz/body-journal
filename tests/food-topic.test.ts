import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AssistantService} from '../electron/ai/service';
import type {ChatGPTAuth} from '../electron/ai/auth';
import {FoodCatalog} from '../electron/core/nutrition';
import {HealthStore} from '../electron/core/store';
import {mutationSchemas} from '../electron/core/ipc';
import {ingredient} from './fixtures/prompt-golden';

const topic='food.Dinner-Label',canonical='food.dinner_label',at='2026-10-22T19:00:00+08:00';
const preset=(name:string,protein=12)=>({name,servingGrams:100,perServing:{kcal:150,protein,carbs:10,fat:5}});
const quote=(name:string,protein=12)=>name+'每100克含150千卡、蛋白质'+protein+'克、碳水10克、脂肪5克';
const memory=(name:string)=>({kind:'food' as const,text:name,food:preset(name),topicKey:canonical,active:true,confirmed:true,sourceIds:[],startsAt:'2026-01-01T00:00:00Z',expiresAt:null});
const change=(name:string,key=topic,protein=12)=>({operation:'upsert',kind:'food',key,food:preset(name,protein),evidenceQuote:quote(name,protein)});
function echoed(value:unknown){
  const events=[{type:'response.output_text.delta',delta:JSON.stringify(value)},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:20}}}];
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
}
test('retry a failed dinner with a legacy food key, edit it through IPC and restore its history',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-food-topic-'));
  const open=(name:string)=>new HealthStore(path.join(dir,name),new FoodCatalog([]),path.join(dir,'inbox'),false);
  let store=open('original');t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const food=store.saveMemory(memory('合成豆腐')),other=store.saveMemory(memory('合成酸奶'));
  const old={...food,topicKey:topic};
  store.db.prepare('UPDATE memories SET doc=? WHERE id=?').run(JSON.stringify(old),old.id);
  store.db.prepare('INSERT INTO revisions(entity,id,doc,at) VALUES(?,?,?,?)').run('memory',old.id,JSON.stringify(old),at);
  const dinner=store.importEnvelope({id:'synthetic-dinner',version:1,kind:'meal',occurredAt:at,timezone:'Asia/Shanghai',text:'晚餐，更新常用食物：'+quote('合成豆腐',18)}).record;
  store.markAnalysisFailure(dinner.id,dinner.revision,'topicKey: 主题键格式应为 domain.aspect，例如 eating.environment');
  const archive=path.join(dir,'legacy.bodyjournal');store.backup(archive);
  const restored=open('restored');
  try{
    restored.restoreFile(archive);
    const legacyRevision=restored.undoMemory(old.id);
    assert.equal(legacyRevision.topicKey,canonical);
    assert.equal(legacyRevision.food?.name,old.food!.name);
  }finally{restored.close();}
  store.close();store=open('original');
  assert.equal(store.memories().find(m=>m.id===old.id)?.topicKey,canonical);
  store.setSettings({...store.getSettings(),chatgptModel:'synthetic-model'});
  const service=new AssistantService(store,{accessToken:async()=>'synthetic'} as ChatGPTAuth,{read:async()=>({}),write:async()=>{}},()=>{},x=>x,async()=>echoed({
    summary:'已按本餐分量估算',ingredients:[ingredient('合成豆腐',100)],memoryChanges:[change('合成豆腐',topic,18),change('合成豆腐','没有域名',18)],
  }));
  const result=await service.analyze([dinner.id],{pendingOnly:true});
  assert.equal(result.completed,1);const saved=store.record(dinner.id);
  assert.equal(saved.analysisError,undefined);assert.equal(saved.status,'ready');assert.ok(saved.analysis?.macros);
  assert.equal(saved.analysis?.memoryReceipt?.[0].id,old.id);
  assert.equal(saved.analysis?.memoryWarnings?.length,1);
  assert.equal(store.memories().find(m=>m.id===old.id)?.food?.perServing.protein,18);
  assert.deepEqual(store.memories().find(m=>m.id===other.id)?.food,other.food);
  const {id,memory:edited}=mutationSchemas['memory:save'].parse({id:old.id,memory:{...old,food:preset('合成豆腐',19)}});
  assert.equal(store.saveMemory(edited,id).topicKey,canonical);
  const {topicKey:_topic,...form}=edited;
  assert.equal(store.saveMemory(form,id).topicKey,canonical);
  assert.equal(store.memories().filter(m=>m.kind==='food').length,2);
});
test('chat accepts two distinct labelled products under one topic and rejects a malformed key without losing the answer',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-food-chat-')),s=new HealthStore(dir,new FoodCatalog([]),dir+'/inbox',false);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  s.setSettings({...s.getSettings(),chatgptModel:'synthetic-model'});
  const service=new AssistantService(s,{accessToken:async()=>'synthetic'} as ChatGPTAuth,{read:async()=>({}),write:async()=>{}},()=>{},x=>x,async()=>echoed({
    answerMarkdown:'已读到两份标签。',memoryChanges:[change('豆腐'),change('酸奶'),change('酸奶','food..invalid')],
  }));
  await service.chat('请记住两个常用食物：'+quote('豆腐')+'；'+quote('酸奶')+'。');
  const reply=s.messages().at(-1)!;
  assert.equal(reply.status,'complete');assert.equal(reply.memoryWarnings?.length,1);
  assert.deepEqual(s.memories().map(m=>[m.food?.name,m.topicKey]).sort(),[['豆腐',canonical],['酸奶',canonical]].sort());
});
