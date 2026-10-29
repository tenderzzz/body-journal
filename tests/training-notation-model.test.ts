import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {detectTrainingNotation} from '../electron/core/training-notation';
import type {MemoryChange,Message} from '../src/shared/types';

test('model upserts preserve untouched notation facets, while deactivation never revives them',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'notation-model-')),s=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});
 const seed=s.saveMemory({kind:'fact',topicKey:'recording.training_notation',text:'组数x次数，只有一个数字就是次数',startsAt:'2026-10-20T00:00:00+08:00',expiresAt:null,sourceIds:[],active:true,confirmed:true});
 function change(text:string,operation:MemoryChange['operation'],at:string){
  const user:Message={id:'synthetic-user-'+at.slice(8,10),role:'user',text,createdAt:at,status:'complete',sources:[],provider:'chatgpt',stale:false};
  const reply:Message={...user,id:'synthetic-reply-'+at.slice(8,10),role:'assistant',text:'合成回执'};
  s.completeChat(reply,[{operation,key:'recording.training_notation',targetId:seed.id,kind:'fact',text,evidenceQuote:text}],user,s.memories(),s.getSettings().goals);
 }
 change('以后按次数x组数记录','upsert','2026-10-21T00:00:00+08:00');
 let current=s.memories().find(m=>m.id===seed.id)!;assert.deepEqual(detectTrainingNotation(current.text),{setsFirst:false,singleNumberIsReps:true});assert.ok(current.evidence?.some(e=>e.quote===seed.text));assert.ok(current.evidence?.some(e=>e.quote==='以后按次数x组数记录'));
 change('停用这条训练记法','deactivate','2026-10-22T00:00:00+08:00');
 change('以后按组数x次数记录','upsert','2026-10-23T00:00:00+08:00');
 current=s.memories().find(m=>m.id===seed.id)!;assert.deepEqual(detectTrainingNotation(current.text),{setsFirst:true});assert.equal(current.evidence?.length,1);
});
