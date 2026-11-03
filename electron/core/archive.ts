import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, readSync, writeSync, fsyncSync, mkdirSync, existsSync, statSync, lstatSync, realpathSync, renameSync, rmSync, readFileSync, writeFileSync, copyFileSync, statfsSync, chmodSync } from 'node:fs';
import path from 'node:path';

// Only these schemas can be materialized from an archive. Archive SQL is never executed.
export const VAULT_TABLES:Record<string,string> = {
  records:'id TEXT PRIMARY KEY, doc TEXT NOT NULL, fingerprint TEXT NOT NULL',
  revisions:'seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, at TEXT NOT NULL',
  memories:'id TEXT PRIMARY KEY, doc TEXT NOT NULL',
  messages:'id TEXT PRIMARY KEY, doc TEXT NOT NULL',
  config:'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  usage:'id TEXT PRIMARY KEY, month TEXT NOT NULL, provider TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL',
  energy_profiles:'id TEXT PRIMARY KEY, doc TEXT NOT NULL',
  energy_targets:'id TEXT PRIMARY KEY, doc TEXT NOT NULL',
  energy_days:'id TEXT PRIMARY KEY, doc TEXT NOT NULL',
  energy_proposals:'id TEXT PRIMARY KEY, doc TEXT NOT NULL',
  memory_episodes:'id TEXT PRIMARY KEY, doc TEXT NOT NULL',
};
const CHUNK_SIZE=1024*1024;
const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const allowedFile=/^(raw\/[a-zA-Z0-9_-]+\.json|attachments\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.(jpeg|png|webp|gif))$/;

export function durableJson(file:string,value:unknown){
  const tmp=file+'.tmp';
  const fd=openSync(tmp,'w',0o600);
  try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,file);
  syncDirectory(path.dirname(file));
}
function syncDirectory(dir:string){const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function digestFile(file:string){
  const fd=openSync(file,'r'),buffer=Buffer.alloc(CHUNK_SIZE),digest=createHash('sha256');
  try{let count:number;while((count=readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,count));}
  finally{closeSync(fd);}
  return digest.digest('hex');
}
function safeFile(root:string,relative:string){
  if(!allowedFile.test(relative))throw new Error('备份包含无效文件路径');
  return path.join(root,relative);
}
function *vaultFiles(db:DatabaseSync,root:string):Generator<{relative:string;expected?:string}>{
  const seen=new Set<string>();
  for(const row of db.prepare('SELECT doc FROM records').iterate()){
    const r=JSON.parse(String(row.doc));
    for(const a of r.attachments??[]){
      safeFile(root,a.file);
      if(!seen.has(a.file)){seen.add(a.file);yield {relative:a.file,expected:a.sha256};}
    }
    const raw=`raw/${r.id}.json`;
    if(existsSync(safeFile(root,raw)))yield {relative:raw};
  }
}
export function ensureSpace(dir:string,bytes:number){
  const fs=statfsSync(dir);
  if(Number(fs.bavail)*Number(fs.bsize)<bytes+64*1024*1024)throw new Error('磁盘空间不足，档案尚未切换。请释放空间后重试。');
}
export function isArchive(file:string){
  const fd=openSync(file,'r'),header=Buffer.alloc(16);
  try{readSync(fd,header,0,16,0);}finally{closeSync(fd);}
  return header.toString()==='SQLite format 3\0';
}

/** Bounded memory: at most one row and one 1 MiB file chunk at a time. */
export function writeArchive(db:DatabaseSync,root:string,destination:string){
  mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  const tmp=destination+'.'+randomUUID()+'.tmp';
  const archive=new DatabaseSync(tmp);chmodSync(tmp,0o600);
  const manifest=createHash('sha256');
  let inReadTransaction=false;
  try{
    archive.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE rows(seq INTEGER PRIMARY KEY,table_name TEXT NOT NULL,json TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE TABLE files(path TEXT PRIMARY KEY,size INTEGER NOT NULL,sha256 TEXT NOT NULL,chunks INTEGER NOT NULL);
      CREATE TABLE chunks(path TEXT NOT NULL,seq INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(path,seq));`);
    const meta=archive.prepare('INSERT INTO meta VALUES(?,?)');
    meta.run('format','bodyjournal-backup');meta.run('version','5');
    meta.run('databaseVersion',String(db.prepare('PRAGMA user_version').get()!.user_version));
    meta.run('createdAt',new Date().toISOString());
    if(!db.isTransaction){db.exec('BEGIN');inReadTransaction=true;}
    let estimated=statSync(path.join(root,'health.sqlite')).size*2;
    for(const entry of vaultFiles(db,root))estimated+=statSync(safeFile(root,entry.relative)).size*1.1;
    ensureSpace(path.dirname(destination),estimated);
    archive.exec('BEGIN');
    const insert=archive.prepare('INSERT INTO rows(table_name,json,sha256) VALUES(?,?,?)');
    for(const table of Object.keys(VAULT_TABLES)){
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
      for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()){
        const json=JSON.stringify(row),digest=hash(json);
        insert.run(table,json,digest);manifest.update(JSON.stringify([table,digest]));
      }
    }
    const chunk=archive.prepare('INSERT INTO chunks VALUES(?,?,?)');
    const file=archive.prepare('INSERT INTO files VALUES(?,?,?,?)');
    for(const entry of vaultFiles(db,root)){
      const full=safeFile(root,entry.relative);
      if(lstatSync(full).isSymbolicLink()||!realpathSync(full).startsWith(realpathSync(root)+path.sep))throw new Error('不接受档案之外的附件');
      const fd=openSync(full,'r'),digest=createHash('sha256'),buffer=Buffer.alloc(CHUNK_SIZE);
      let size=0,seq=0;
      try{
        let count:number;
        while((count=readSync(fd,buffer,0,buffer.length,null))>0){
          const bytes=buffer.subarray(0,count);digest.update(bytes);size+=count;chunk.run(entry.relative,seq++,bytes);
        }
      }finally{closeSync(fd);}
      const sha=digest.digest('hex');
      if(entry.expected&&sha!==entry.expected)throw new Error('图片校验失败，未生成完整备份');
      file.run(entry.relative,size,sha,seq);manifest.update(JSON.stringify([entry.relative,size,sha,seq]));
    }
    meta.run('manifest',manifest.digest('hex'));
    archive.exec('COMMIT');
    if(archive.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new Error('备份数据库完整性校验失败');
    archive.close();
    verifyArchive(tmp);
    const fd=openSync(tmp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(tmp,destination);syncDirectory(path.dirname(destination));
  }catch(e){try{archive.close();}catch{}rmSync(tmp,{force:true});throw e;}
  finally{if(inReadTransaction)db.exec('COMMIT');}
}

function visitArchive(file:string,onRow?:(table:string,row:Record<string,any>)=>void,onFile?:(relative:string,chunks:Iterable<Buffer>)=>void){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new Error('备份数据库完整性校验失败');
    const get=(key:string)=>db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
    if(get('format')!=='bodyjournal-backup'||get('version')!=='5'||Number(get('databaseVersion'))>6)throw new Error('备份格式不支持，请检查应用版本');
    const digest=createHash('sha256');
    for(const entry of db.prepare('SELECT * FROM rows ORDER BY seq').iterate()){
      const table=String(entry.table_name),json=String(entry.json),sha=hash(json);
      if(!Object.hasOwn(VAULT_TABLES,table)||sha!==entry.sha256)throw new Error('备份数据表校验失败');
      digest.update(JSON.stringify([table,sha]));onRow?.(table,JSON.parse(json));
    }
    let expectedChunks=0;
    for(const entry of db.prepare('SELECT * FROM files ORDER BY rowid').iterate()){
      const relative=String(entry.path);safeFile('.',relative);
      const fileDigest=createHash('sha256');let size=0,count=0;
      function *chunks(){
        for(const c of db.prepare('SELECT seq,data FROM chunks WHERE path=? ORDER BY seq').iterate(relative)){
          const bytes=Buffer.from(c.data as Uint8Array);
          if(Number(c.seq)!==count++||bytes.length>CHUNK_SIZE)throw new Error('备份文件分块损坏');
          fileDigest.update(bytes);size+=bytes.length;yield bytes;
        }
      }
      if(onFile)onFile(relative,chunks());else for(const _ of chunks()){ /* Validate without materializing. */ }
      if(size!==Number(entry.size)||count!==Number(entry.chunks)||fileDigest.digest('hex')!==entry.sha256)throw new Error('备份文件校验失败');
      expectedChunks+=count;digest.update(JSON.stringify([relative,size,String(entry.sha256),count]));
    }
    if(Number(db.prepare('SELECT count(*) AS n FROM chunks').get()!.n)!==expectedChunks||digest.digest('hex')!==get('manifest'))throw new Error('备份清单校验失败');
    return Number(get('databaseVersion'));
  }finally{db.close();}
}
export function verifyArchive(file:string){return visitArchive(file);}
export function extractArchive(file:string,stage:string){
  mkdirSync(stage,{recursive:true,mode:0o700});ensureSpace(stage,statSync(file).size*1.2);
  const db=new DatabaseSync(path.join(stage,'health.sqlite'));
  try{
    for(const [table,columns] of Object.entries(VAULT_TABLES))db.exec(`CREATE TABLE ${table}(${columns})`);
    db.exec('BEGIN');
    const version=visitArchive(file,(table,row)=>{
      const keys=Object.keys(row),allowed=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>String(c.name));
      if(keys.some(k=>!allowed.includes(k)))throw new Error('备份数据表包含未知字段');
      db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
    },(relative,chunks)=>{
      const full=safeFile(stage,relative);mkdirSync(path.dirname(full),{recursive:true,mode:0o700});
      const fd=openSync(full,'wx',0o600);try{for(const bytes of chunks){let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);}fsyncSync(fd);}finally{closeSync(fd);}
    });
    db.exec(`PRAGMA user_version=${version}; COMMIT;`);
  }finally{db.close();}
}

/** Preserve the old database format before HealthStore performs its first write. */
export function beforeUpgrade(root:string){
  const source=path.join(root,'health.sqlite');if(!existsSync(source))return;
  const db=new DatabaseSync(source,{readOnly:true});
  let snapshot:string|undefined;
  try{
    const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if(version>6)throw new Error('档案由更高版本创建，请升级应用后再打开。');
    if(version===0||version===6)return;
    snapshot=root+'-before-v061-'+Date.now()+'-'+randomUUID().slice(0,8);
    mkdirSync(snapshot,{mode:0o700});
    let size=statSync(source).size*2;for(const f of vaultFiles(db,root))size+=statSync(safeFile(root,f.relative)).size;
    ensureSpace(snapshot,size);
    db.prepare('VACUUM INTO ?').run(path.join(snapshot,'health.sqlite'));
    const frozen=new DatabaseSync(path.join(snapshot,'health.sqlite'),{readOnly:true});
    try{
      const files:{path:string;size:number;sha256:string}[]=[];
      for(const f of vaultFiles(frozen,root)){
        const dest=safeFile(snapshot,f.relative);mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});copyFileSync(safeFile(root,f.relative),dest);
        const bytes=readFileSync(dest),sha=hash(bytes);if(f.expected&&sha!==f.expected)throw new Error('升级前附件校验失败');
        files.push({path:f.relative,size:bytes.length,sha256:sha});
      }
      if(frozen.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new Error('升级前数据库校验失败');
      durableJson(path.join(snapshot,'rollback.json'),{version,createdAt:new Date().toISOString(),databaseSha256:digestFile(path.join(snapshot,'health.sqlite')),files});
    }finally{frozen.close();}
  }catch(e){if(snapshot)rmSync(snapshot,{recursive:true,force:true});throw e;}finally{db.close();}
}

export function recoverSwap(root:string){
  const marker=root+'.restore.json';if(!existsSync(marker))return;
  const {previous,stage}=JSON.parse(readFileSync(marker,'utf8'));
  // Restrict recovery to directories created beside this exact vault.
  if(typeof previous!=='string'||typeof stage!=='string'||!previous.startsWith(root+'.previous-')||!stage.startsWith(root+'.staged-')||path.dirname(previous)!==path.dirname(root)||path.dirname(stage)!==path.dirname(root))throw new Error('恢复标记损坏，请保留档案并检查回退目录');
  if(!existsSync(root)&&existsSync(previous))renameSync(previous,root);
  if(!existsSync(root))throw new Error('恢复尚未完成，请保留临时档案和回退目录');
  rmSync(marker);syncDirectory(path.dirname(root));
}
export function switchVault(root:string,stage:string){
  const previous=root+'.previous-'+randomUUID();
  durableJson(root+'.restore.json',{previous,stage});
  try{renameSync(root,previous);renameSync(stage,root);syncDirectory(path.dirname(root));rmSync(root+'.restore.json');}
  catch(e){recoverSwap(root);throw e;}
  return previous;
}
