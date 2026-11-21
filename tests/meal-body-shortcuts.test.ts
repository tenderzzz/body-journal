import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {InboxSync} from '../electron/core/inbox';
import {FoodCatalog} from '../electron/core/nutrition';
import {HealthStore} from '../electron/core/store';
import {computeStats} from '../src/shared/stats';
import {replayShortcut,type Shortcut} from './fixtures/shortcut-replay';

const capturedAt='2026-10-25T12:30:00+08:00';
const shortcut=(name:'记一餐'|'记身体')=>JSON.parse(readFileSync(new URL(`../shortcuts/unsigned/身体手记·${name}.json`,import.meta.url),'utf8')) as Shortcut;
// Distinct synthetic byte sequences with JPEG headers. The replay checks transfer and
// ordering, while the Apple actions handle image decoding and conversion at runtime.
const photos=Array.from({length:9},(_,i)=>Buffer.from([0xff,0xd8,0xff,0xfe,0,6,0,0,0,i,0xff,0xd9]));

function setup(t:test.TestContext){
  const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-phone-entry-')),inbox=path.join(root,'inbox');
  mkdirSync(inbox);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,inbox};
}

async function importFromInbox<T>(root:string,inbox:string,verify:(store:HealthStore)=>T){
  const store=new HealthStore(root,new FoodCatalog([]),inbox,false);
  const sync=new InboxSync(store,path.join(root,'sync.json'),()=>{});
  try{
    sync.start();
    await sync.scan();
    assert.deepEqual(store.syncState.errors,[]);
    assert.equal(store.syncState.pending,0,JSON.stringify(store.syncState.items));
    assert.equal(store.syncState.imported,1);
    return verify(store);
  }finally{await sync.stop();store.close();}
}

for(const sample of [
  {name:'camera',inputs:{menu:'拍照记餐',camera:photos[0]},count:1},
  {name:'album multi-select',inputs:{menu:'从相册选照片',album:photos.slice(0,8)},count:8},
  {name:'photo share sheet',inputs:{incoming:photos.slice(0,3)},count:3},
  {name:'text only even when an empty Text action has a value',inputs:{menu:'只记文字',emptyTextIsPresent:true},count:0},
])test('meal shortcut saves one inbox record with all '+sample.name+' inputs',async t=>{
  const {root,inbox}=setup(t),note='合成餐食：半份米饭\n补充 "少油" 🍚';
  const result=replayShortcut(shortcut('记一餐'),{...sample.inputs,capturedAt,inbox,answer:()=>note});
  assert.deepEqual(result.prompts,['Text']);
  assert.equal(result.files.length,1);
  assert.match(result.messages.at(-1)!,/已保存/);
  await importFromInbox(root,inbox,store=>{
    const rows=store.records();
    assert.equal(rows.length,1);
    const [record]=rows;
    assert.equal(record.kind,'meal');
    assert.equal(record.text,note);
    assert.equal(record.attachments.length,sample.count);
    assert.deepEqual(record.attachments.map(a=>a.name),photos.slice(0,sample.count).map((_,i)=>`photo-${i+1}.jpg`));
    for(const [i,bytes] of photos.slice(0,sample.count).entries())assert.equal(store.attachmentData(record.id,i),`data:image/jpeg;base64,${bytes.toString('base64')}`);
  });
});

test('meal shortcut stops after an empty or oversized photo selection without dropping photos',t=>{
  const {inbox}=setup(t);
  for(const album of [[],photos]){
    const result=replayShortcut(shortcut('记一餐'),{menu:'从相册选照片',album,capturedAt,inbox,answer:()=>assert.fail('unexpected prompt')});
    assert.deepEqual(result.files,[]);
    assert.equal(result.messages.length,1);
    assert.doesNotMatch(result.messages[0],/已保存/);
  }
});

test('text-only meal rejects whitespace after its only prompt without saving an empty record',t=>{
  const {inbox}=setup(t);
  const result=replayShortcut(shortcut('记一餐'),{menu:'只记文字',emptyTextIsPresent:true,capturedAt,inbox,answer:()=> ' \n\t'});
  assert.deepEqual(result.prompts,['Text']);
  assert.deepEqual(result.files,[]);
  assert.deepEqual(result.messages,['没有输入内容，记录未保存。']);
});

for(const sample of [
  {menu:'体脂率',answers:['18,5'],expected:{bodyFatPercent:18.5}},
  {menu:'体重与体脂率',answers:[74.2,18.5],expected:{weightKg:74.2,bodyFatPercent:18.5}},
  {menu:'三项都记',answers:[74.2,81,18.5],expected:{weightKg:74.2,waistCm:81,bodyFatPercent:18.5}},
  {menu:'体重与腰围',answers:[74.2,81],expected:{weightKg:74.2,waistCm:81}},
])test('body shortcut imports only the chosen measurements for '+sample.menu,async t=>{
  const {root,inbox}=setup(t);
  const result=replayShortcut(shortcut('记身体'),{menu:sample.menu,capturedAt,inbox,answer:(_,i)=>sample.answers[i]});
  assert.deepEqual(result.prompts,sample.answers.map(()=> 'Number'));
  assert.equal(result.files.length,1);
  await importFromInbox(root,inbox,store=>{
    const [record]=store.records();
    assert.equal(record.status,'ready');
    assert.equal(record.analysisPending,false);
    assert.deepEqual(record.body,sample.expected);
    assert.equal(computeStats([record]).measurements[0].bodyFatPercent,sample.expected.bodyFatPercent);
    if(sample.menu==='三项都记'){
      const edited=store.revise(record.id,{body:{...record.body,waistCm:80.5}},record.revision);
      assert.equal(edited.body?.bodyFatPercent,18.5);
      const backup=path.join(root,'synthetic.bodyjournal');
      store.backup(backup);
      store.restoreFile(backup);
      assert.deepEqual(store.record(record.id).body,{weightKg:74.2,waistCm:80.5,bodyFatPercent:18.5});
    }
  });
});

test('out-of-range body fat is rejected by both the shortcut and direct desktop input',t=>{
  const {root,inbox}=setup(t);
  const store=new HealthStore(root,new FoodCatalog([]),inbox,false);
  try{
    for(const n of [0,-1,100,180]){
      const result=replayShortcut(shortcut('记身体'),{menu:'体脂率',capturedAt,inbox,answer:()=>n});
      assert.deepEqual(result.files,[]);
      assert.match(result.messages[0],/体脂率/);
      assert.throws(()=>store.importEnvelope({version:1,id:'synthetic-fat',kind:'body',occurredAt:capturedAt,text:'',body:{bodyFatPercent:n}}),/体脂率/);
    }
  }finally{store.close();}
});
