import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,existsSync,renameSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {crc32} from 'node:zlib';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {isArchive,verifyArchive,durableJson,ensureSpace} from '../electron/core/archive';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9sAAAAASUVORK5CYII=','base64');
function fixture(t:test.TestContext){
  const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-v06-archive-'));
  const store=new HealthStore(path.join(dir,'vault'),new FoodCatalog([]),path.join(dir,'inbox'),false);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store};
}
function add(store:HealthStore,image=png){return store.importEnvelope({version:1,id:crypto.randomUUID(),kind:'note',text:'合成照片记录',occurredAt:new Date().toISOString(),timezone:'Asia/Shanghai',imageBase64:image.toString('base64')}).record;}

test('v5 archive round trips all portable config, raw files, histories and images, preserving target inbox and spend',t=>{
  const {dir,store}=fixture(t),r=add(store);
  store.revise(r.id,{text:'合成更正'},1);
  store.saveExerciseRules({archived:['哑铃飞鸟'],overrides:{杠铃平板卧推:'total'}});
  store.ignoreFoodCandidate('合成食品');store.setConfig('conversationStart','2026-01-01T00:00:00Z');
  const file=path.join(dir,'archive.bodyjournal');store.backup(file);
  assert.ok(isArchive(file));assert.equal(verifyArchive(file),5);
  const target=new HealthStore(path.join(dir,'target'),new FoodCatalog([]),'target-inbox',false);
  try{
    const spend=target.reserveUsage('chatgpt',0);
    target.restoreFile(file);
    assert.deepEqual(target.record(r.id),store.record(r.id));assert.deepEqual(target.history(r.id),store.history(r.id));
    assert.deepEqual(target.exerciseRules(),store.exerciseRules());assert.deepEqual(target.ignoredFoodCandidates(),['合成食品']);
    assert.equal(target.getConfig('conversationStart'),'2026-01-01T00:00:00Z');assert.equal(target.getSettings().inbox,'target-inbox');
    assert.equal(target.db.prepare('SELECT id FROM usage WHERE id=?').get(spend)!.id,spend);
    assert.equal(target.attachmentData(r.id,0),store.attachmentData(r.id,0));
    assert.equal(readFileSync(path.join(target.root,'raw',r.id+'.json'),'utf8'),readFileSync(path.join(store.root,'raw',r.id+'.json'),'utf8'));
  }finally{target.close();}
});
test('tampered native archive is rejected without touching the live vault',t=>{
  const {dir,store}=fixture(t),r=add(store),file=path.join(dir,'damaged.bodyjournal');store.backup(file);
  const archive=new DatabaseSync(file);archive.prepare('UPDATE chunks SET data=? WHERE seq=0').run(Buffer.from('broken'));archive.close();
  assert.throws(()=>store.restoreFile(file),/校验/);assert.equal(store.record(r.id).text,r.text);assert.equal(store.attachmentData(r.id,0),`data:image/png;base64,${png.toString('base64')}`);
});
test('upgrade preserves pristine v4 snapshot before recovering interrupted requests',t=>{
  const {dir,store}=fixture(t);add(store);const spend=store.reserveUsage('chatgpt',0);
  store.db.exec('PRAGMA user_version=4');store.close();
  const upgraded=new HealthStore(store.root,new FoodCatalog([]),'inbox',false);
  try{
    const rollback=readdirSync(dir).find(n=>n.startsWith('vault-before-v06-'))!;
    assert.ok(rollback);const old=new DatabaseSync(path.join(dir,rollback,'health.sqlite'),{readOnly:true});
    assert.equal(old.prepare('PRAGMA user_version').get()!.user_version,4);
    assert.equal(old.prepare('SELECT state FROM usage WHERE id=?').get(spend)!.state,'reserved');old.close();
    assert.equal(upgraded.db.prepare('SELECT state FROM usage WHERE id=?').get(spend)!.state,'uncertain');
  }finally{upgraded.close();}
});
test('startup recovers interruption between vault directory renames and rejects insufficient space',t=>{
  const {store}=fixture(t),r=add(store),root=store.root;
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');store.close();
  const previous=root+'.previous-synthetic',stage=root+'.staged-synthetic';
  durableJson(root+'.restore.json',{previous,stage});renameSync(root,previous);
  const reopened=new HealthStore(root,new FoodCatalog([]),'inbox',false);
  try{assert.equal(reopened.record(r.id).id,r.id);assert.ok(!existsSync(root+'.restore.json'));assert.throws(()=>ensureSpace(root,Infinity),/空间不足/);}finally{reopened.close();}
});
test('more than 512 MiB of synthetic image data backs up and restores', {skip:process.env.BODYJOURNAL_LARGE_TEST!=='1'},t=>{
  const {dir,store}=fixture(t);
  // A renderable PNG with a large, valid ancillary text chunk exercises real file sizes.
  const base=readFileSync('assets/connection-test.png');
  const payload=Buffer.alloc(18*1024*1024,65);payload.write('synthetic\0');
  const type=Buffer.from('tEXt'),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(payload.length);
  for(let i=0;i<30;i++){
    payload.write(String(i).padStart(4,'0'),10);
    crc.writeUInt32BE(crc32(payload,crc32(type)));
    add(store,Buffer.concat([base.subarray(0,33),length,type,payload,crc,base.subarray(33)]));
  }
  const file=path.join(dir,'large.bodyjournal');store.backup(file);assert.ok(statSync(file).size>512*1024*1024);
  const target=new HealthStore(path.join(dir,'target'),new FoodCatalog([]),'inbox',false);
  try{target.restoreFile(file);assert.equal(target.records().length,30);for(const r of store.records())assert.deepEqual(target.record(r.id).attachments,r.attachments);}finally{target.close();}
  store.db.exec('PRAGMA user_version=4');store.close();
  const upgraded=new HealthStore(store.root,new FoodCatalog([]),'inbox',false);
  try{assert.equal(upgraded.records().length,30);assert.ok(readdirSync(dir).some(n=>n.startsWith('vault-before-v06-')));}finally{upgraded.close();}
});
