import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {memoryDependency} from '../electron/core/memory';
function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-memory-reliability-'));const s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return s;}
const at=new Date(Date.now()-1000).toISOString();
const fact=(s:HealthStore,text:string,topicKey?:string)=>s.saveMemory({kind:'fact',text,topicKey,startsAt:at,expiresAt:null,sourceIds:[],active:true,confirmed:true});
test('opposite automatically extracted preferences replace one setting and retain history',t=>{
 const s=setup(t);for(const [i,text] of ['我喜欢晚上训练','我不喜欢晚上训练'].entries())s.importEnvelope({version:1,id:`preference-record-${i}`,kind:'note',occurredAt:new Date(Date.now()-2000+i*1000).toISOString(),timezone:'Asia/Shanghai',text});
 s.refreshAutomaticMemories();const prefs=s.memories().filter(m=>m.active&&!m.stale&&m.topicKey==='training.time_preference');assert.equal(prefs.length,1);assert.equal(prefs[0].text,'我不喜欢晚上训练');assert.ok(s.memoryHistory(prefs[0].id).some(h=>h.memory.text==='我喜欢晚上训练'));
 const revision=prefs[0].revision;s.refreshAutomaticMemories();assert.equal(s.memories().find(m=>m.id===prefs[0].id)!.revision,revision);
});
test('health states outrank background facts and explicit food questions keep their label within budget',t=>{
 const s=setup(t);for(let i=0;i<5;i++)fact(s,`兴趣${i}：`+'我喜欢读小说。'.repeat(50),`profile.hobby${i}`);
 const pain=s.saveMemory({kind:'state',text:'最近右膝疼痛，暂时避免深蹲',topicKey:'health.knee',startsAt:at,expiresAt:new Date(Date.now()+86400000).toISOString(),sourceIds:[],active:true,confirmed:true});
 assert.ok(s.memoryContext('training','下一次练腿').items.some(m=>m.id===pain.id));assert.ok(s.memoryContext('chat','下一次练腿').items.some(m=>m.id===pain.id));
 const food=s.saveMemory({kind:'food',text:'测试常用蛋白粉',food:{name:'测试常用蛋白粉',servingGrams:30,perServing:{kcal:120,protein:24,carbs:3,fat:1.5}},startsAt:at,expiresAt:null,sourceIds:[],active:true,confirmed:true});const result=s.memoryContext('chat','测试常用蛋白粉每勺多少热量');assert.ok(result.items.some(m=>m.id===food.id));assert.ok(result.chars<=result.budget);
});
test('failed analysis rolls back every attached memory and revision',t=>{
 const s=setup(t),r=s.importEnvelope({version:1,id:'failed-memory-analysis',kind:'meal',occurredAt:at,timezone:'Asia/Shanghai',text:'我喜欢清淡饮食'}).record;
 const before=s.memories();assert.throws(()=>s.applyAnalysis(r.id,{summary:'缺少食材',memoryChanges:[{operation:'upsert',key:'eating.taste',kind:'fact',text:r.text,evidenceQuote:r.text}]},'chatgpt',r.revision),/食材/);
 assert.equal(s.record(r.id).revision,1);assert.deepEqual(s.memories(),before);
});
test('memory changes and expiry invalidate dependent answers, including noncited context',t=>{
 const s=setup(t),m=fact(s,'我喜欢晚上训练','training.time');const message={id:'memory-dependent-answer',role:'assistant' as const,text:'建议晚上训练',createdAt:at,status:'complete' as const,sources:[],provider:'test',stale:false,memoryDependency:[memoryDependency(m)]};s.putMessage(message);
 const n=fact(s,'我不喜欢晚上训练','training.schedule.time');assert.equal(n.id,m.id);assert.ok(s.messages()[0].stale);assert.ok((n.revision??0)>(m.revision??0));
 const state=s.saveMemory({kind:'state',text:'最近睡不好',startsAt:new Date(Date.now()-86400000).toISOString(),expiresAt:new Date(Date.now()-100).toISOString(),sourceIds:[],active:true,confirmed:true});s.putMessage({...message,id:'expired-state-answer',memoryDependency:[memoryDependency(state)]});s.invalidateMemoryAnswers();assert.ok(s.messages().at(-1)!.stale);assert.ok(!s.memoryContext('chat','最近睡眠').items.some(m=>m.id===state.id));
});
test('backdated analysis retrieves the version applicable on that date',t=>{
 const s=setup(t);const old=s.saveMemory({kind:'fact',text:'我喜欢晚上训练',startsAt:'2026-09-01T00:00:00+08:00',expiresAt:null,sourceIds:[],active:true,confirmed:true});s.saveMemory({...old,text:'我不喜欢晚上训练',startsAt:'2026-10-01T00:00:00+08:00'},old.id);
 assert.equal(s.memoryContext('training','训练时间',new Date('2026-09-15T00:00:00+08:00')).items[0].text,'我喜欢晚上训练');
});
test('different health subjects are never collapsed into training time preferences',t=>{
 const s=setup(t),base={kind:'state',startsAt:at,expiresAt:null,sourceIds:[],active:true,confirmed:true};
 const knee=s.saveMemory({...base,text:'我最近晚上训练后膝盖疼痛',topicKey:'health.knee'}),shoulder=s.saveMemory({...base,text:'我最近晚上训练后肩膀疼痛',topicKey:'health.shoulder'});
 assert.notEqual(knee.id,shoulder.id);assert.equal(knee.topicKey,'health.knee');assert.equal(shoulder.topicKey,'health.shoulder');
});
test('one chat can update separate objects sharing a topic without overwriting either',t=>{
 const s=setup(t),text='我最近右膝不适，左肩也有不适',user={id:'subject-user-message',role:'user' as const,text,createdAt:at,status:'complete' as const,sources:[],provider:'test',stale:false},reply={...user,id:'subject-reply-message',role:'assistant' as const,text:'分别保留待复核的状态。'};
 s.completeChat(reply,[{operation:'upsert',key:'health.discomfort',subject:'right_knee',kind:'state',text:'右膝不适',evidenceQuote:'我最近右膝不适'},{operation:'upsert',key:'health.discomfort',subject:'left_shoulder',kind:'state',text:'左肩也有不适',evidenceQuote:'左肩也有不适'}],user,s.memories(),s.getSettings().goals);assert.equal(s.memories().filter(m=>m.topicKey==='health.discomfort').length,2);
});
test('model inferred state does not acquire a fabricated user quote',t=>{
 const s=setup(t),r=s.importEnvelope({version:1,id:'inferred-state-source',kind:'note',text:'今天比较忙',occurredAt:at,timezone:'Asia/Shanghai'}).record;
 s.applyAnalysis(r.id,{summary:'忙碌',memories:[{kind:'hypothesis',text:'可能存在恢复不足'}]},'chatgpt',r.revision);
 const m=s.memories().find(m=>m.kind==='hypothesis')!;assert.equal(m.confirmed,false);assert.deepEqual(m.evidence,[{quote:'',origin:'unknown'}]);
});
test('expired state source messages cannot bypass retrieval through chat history',t=>{
 const s=setup(t);s.saveMemory({kind:'state',text:'上周手腕不适',startsAt:'2026-09-01T00:00:00+08:00',expiresAt:'2026-09-08T00:00:00+08:00',sourceIds:[],sourceMessageIds:['expired-source-message'],active:true,confirmed:true,evidence:[{quote:'手腕不适',origin:'user',messageId:'expired-source-message'}]});assert.ok(s.retiredMemoryMessageIds().has('expired-source-message'));
});
test('editing without moving an old effective date preserves the earlier version for historical analysis',t=>{
 const s=setup(t),m=s.saveMemory({kind:'fact',text:'我喜欢晚上训练',startsAt:'2026-09-01T00:00:00+08:00',expiresAt:null,sourceIds:[],active:true,confirmed:true});s.saveMemory({...m,text:'我不喜欢晚上训练'},m.id);assert.equal(s.memoryContext('training','训练时间',new Date('2026-09-15T12:00:00+08:00')).items[0].text,'我喜欢晚上训练');
});
test('v3 upgrade backs up once and round trips versioned memory in v4 backups',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-v4-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);const m=fact(s,'我喜欢晚上训练');s.db.exec('PRAGMA user_version=3');s.close();const reopened=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);
 assert.equal(reopened.exportBundle().version,4);assert.ok(readdirSync(root+'/backups').some(f=>f.startsWith('before-reliability-v4-')));const bundle=reopened.exportBundle();reopened.restore(bundle);assert.equal(reopened.memories().find(x=>x.id===m.id)?.revision,1);reopened.close();
});
