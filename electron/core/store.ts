import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, lstatSync, realpathSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { Analysis, Attachment, Envelope, HealthRecord, Memory, Message, Settings, CoachProfile, MemoryChange, ExerciseRules, FoodPreset, FoodCandidate } from '../../src/shared/types';
import { analysisSchema, bodySchema, envelopeSchema, idSchema, memoryInputSchema, settingsSchema, readableError, coachProfileSchema, memoryChangeSchema } from './validation';
import { localRecordStatus, parseBody, parseTraining } from './parser';
import { FoodCatalog } from './nutrition';
import { computeStats, validMemory, localDay } from '../../src/shared/stats';
import { z } from 'zod';
import { resolveRecordDate } from './dates';
import { automaticMemories } from './personalization';
import { normalizeAnalysis, DEFAULT_SPLIT, inferSession, type ExerciseAlias } from '../../src/shared/exercises';
import { foodPer100g, foodText, matchFoodPreset, normalizeFoodName } from '../../src/shared/food';
import { mealLabel, mealSlot } from '../../src/shared/meals';
import { DEFAULT_COACH, weeklyContext } from './coaching';
import { EnergyStore } from './energy-store';

export function sha256(data:Buffer|string) { return createHash('sha256').update(data).digest('hex'); }
export function atomicWrite(file:string,data:string|Buffer) { mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); const tmp=`${file}.${randomUUID()}.tmp`; writeFileSync(tmp,data,{mode:0o600}); renameSync(tmp,file); }
export function safePath(root:string, relative:string) { if(path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').includes('..')) throw new Error('附件路径无效'); const p=path.resolve(root,relative); if(!p.startsWith(path.resolve(root)+path.sep)) throw new Error('附件必须位于记录文件夹内'); return p; }
export function sniffImage(data:Buffer):string {
  if(data.length>20*1024*1024) throw new Error('单张图片不能超过 20 MB');
  if(data.subarray(0,3).equals(Buffer.from([255,216,255]))) {if(data.length<10||data[data.length-2]!==255||data[data.length-1]!==217)throw new Error('附件尚未同步完整');return 'image/jpeg';}
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {if(data.length<45||data.toString('ascii',data.length-8,data.length-4)!=='IEND')throw new Error('附件尚未同步完整');return 'image/png';}
  if(data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP') {if(data.length<16||data.readUInt32LE(4)+8!==data.length)throw new Error('附件尚未同步完整');return 'image/webp';}
  if(['GIF87a','GIF89a'].includes(data.toString('ascii',0,6))) {if(data.length<14||data[data.length-1]!==59)throw new Error('附件尚未同步完整');return 'image/gif';}
  throw new Error('图片格式无法识别，请使用 JPEG、PNG、WebP 或 GIF');
}
function parseJSON<T>(s:unknown):T { return JSON.parse(String(s)) as T; }
function iso() { return new Date().toISOString(); }
export class HealthStore {
  db: DatabaseSync;
  energy!:EnergyStore;
  syncState: { imported:number;pending:number;errors:string[];at?:string }={imported:0,pending:0,errors:[]};
  constructor(public root:string,public catalog:FoodCatalog,defaultInbox:string,seed=true) {
    mkdirSync(root,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path.join(root,'health.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version=Number(this.db.prepare('PRAGMA user_version').get()?.user_version??0);
    if(version>2) throw new Error('档案由更高版本创建，请升级应用后再打开。');
    if(version>0 && version<1) this.db.prepare('VACUUM INTO ?').run(path.join(root,`before-migration-${Date.now()}.sqlite`));
    this.db.exec(`CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, doc TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,month TEXT NOT NULL,provider TEXT NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL,cost REAL NOT NULL,state TEXT NOT NULL,at TEXT NOT NULL);
      `);
    if(!this.db.prepare('SELECT value FROM config WHERE key=?').get('settings')) {
      this.setSettings({provider:'chatgpt',chatgptModel:'',deepseekModel:'deepseek-flash',deepseekBudget:0,deepseekInputPrice:0.3,deepseekOutputPrice:1.2,inbox:defaultInbox,timezone:'Asia/Shanghai',goals:{goal:'增肌减脂，逐步练出更厚实、精干的体型',kcal:null,protein:null,training:''}});
      if(seed) for(const text of ['主要吃食堂和外卖，目前没有自己做饭的条件。','喜欢更换菜式，食物分量通常只能估计。','希望记录负担尽量低，可以接受有针对性的追问。']) this.saveMemory({kind:'fact',text,startsAt:iso(),expiresAt:null,sourceIds:[],active:true,confirmed:true});
    }
    // A crashed request is never presented as a completed answer or forgotten spend.
    this.db.prepare("UPDATE usage SET state='uncertain' WHERE state='reserved'").run();
    for(const m of this.messages()) if(m.status==='streaming') this.putMessage({...m,status:'failed',error:'上次请求被中断，请重新提问。'});
    if(version===1)this.backup(path.join(root,'backups',`before-energy-v2-${Date.now()}.bodyjournal`));
    this.transaction(()=>{this.energy=new EnergyStore(this);
      if(version<2&&this.getSettings().goals.kcal!==null)this.energy.importManualTarget(this.getSettings().goals.kcal!,this.getSettings().goals.protein);
      this.db.exec('PRAGMA user_version=2');});
    this.energy.syncTarget();this.energy.invalidate();
  }
  close() { this.db.close(); }
  migrateEnergyParsing(){
    if(this.getConfig<boolean>('energyParsingV1'))return 0;
    const corrections=this.records().flatMap(r=>{
      if(r.kind!=='training'||r.analysis?.engine!=='local'||!r.analysis.run)return [];
      const parsed=parseTraining(r.text),duration=inferSession(r.text,r.analysis.sets).durationMinutes;
      if(!parsed?.run)return [];
      const badDuration=!!duration&&r.analysis.run.minutes===duration&&parsed.run.minutes!==undefined&&parsed.run.minutes!==duration;
      const completion=r.analysis.training?.completion==='unknown'&&parsed.training?.completion==='completed';
      if(!badDuration&&!completion)return [];
      const analysis={...r.analysis,run:{...r.analysis.run,...(badDuration?{minutes:parsed.run.minutes}:{})},training:{...(r.analysis.training??parsed.training!),...(completion?{completion:'completed' as const}:{})}};
      return [{r,analysis}];
    });
    if(corrections.length)this.backup(path.join(this.root,'backups',`before-energy-parsing-${Date.now()}.bodyjournal`));
    this.transaction(()=>{for(const {r,analysis} of corrections)this.commitRevision(r,{...r,analysis});this.setConfig('energyParsingV1',true);});return corrections.length;
  }
  getSettings():Settings { return parseJSON(this.db.prepare('SELECT value FROM config WHERE key=?').get('settings')!.value); }
  setSettings(value:unknown) { const s=settingsSchema.parse(value),old=this.getConfig<Settings>('settings'); this.db.prepare('INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('settings',JSON.stringify(s));if(this.energy&&!this.energy.mirroring&&(!old||old.goals.kcal!==s.goals.kcal||old.goals.protein!==s.goals.protein))this.energy.rememberManualTarget(s.goals.kcal,s.goals.protein);if(this.energy&&old?.timezone!==s.timezone)this.energy.invalidate(); return s; }
  getConfig<T>(key:string):T|undefined { const row=this.db.prepare('SELECT value FROM config WHERE key=?').get(key); return row?parseJSON<T>(row.value):undefined; }
  setConfig(key:string,value:unknown) { this.db.prepare('INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  records(includeDeleted=false):HealthRecord[] { return this.db.prepare('SELECT doc FROM records').all().map(r=>parseJSON<HealthRecord>(r.doc)).filter(r=>includeDeleted||!r.deleted).sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt)); }
  record(id:string):HealthRecord { idSchema.parse(id); const r=this.db.prepare('SELECT doc FROM records WHERE id=?').get(id); if(!r) throw new Error('没有找到这条记录'); return parseJSON(r.doc); }
  private putRecord(r:HealthRecord,fingerprint?:string) { if(fingerprint) this.db.prepare('INSERT INTO records VALUES(?,?,?)').run(r.id,JSON.stringify(r),fingerprint); else this.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(r),r.id);this.energy?.invalidate(); }
  private transaction<T>(fn:()=>T):T { if(this.db.isTransaction)return fn();this.db.exec('BEGIN IMMEDIATE'); try { const result=fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  importEnvelope(input:unknown,sourceDir?:string,source='桌面记录'): {record:HealthRecord;duplicate:boolean} {
    return this.importRecord(input,sourceDir,source);
  }
  private importRecord(input:unknown,sourceDir:string|undefined,source:string,recoveredTime?:string): {record:HealthRecord;duplicate:boolean} {
    const e=envelopeSchema.parse(recoveredTime?{...(input as object),occurredAt:recoveredTime}:input);
    if(e.textBase64!==undefined){const encoded=e.textBase64.replace(/\s/g,'');if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4!==0)throw new Error('记录文字编码不完整');e.text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(encoded,'base64'));if(e.text.length>100000)throw new Error('单条记录文字过长');}
    // A later iCloud download can change mtime; identity remains the original capture.
    const fp=sha256(JSON.stringify(recoveredTime?{...e,occurredAt:''}:e));
    const existing=this.db.prepare('SELECT doc,fingerprint FROM records WHERE id=?').get(e.id);
    if(existing) { if(existing.fingerprint!==fp) throw new Error('同一个记录编号包含不同内容，请用新编号补录或在应用中修改。'); return {record:parseJSON(existing.doc),duplicate:true}; }
    if(!e.text.trim()&&!e.body&&!e.attachments?.length&&!e.imageBase64) throw new Error('记录内容为空');
    const images=[...(e.attachments??[])]; if(e.imageBase64?.trim()) images.push({name:'photo.jpg',base64:e.imageBase64});
    const prepared: {attachment:Attachment;data:Buffer}[]=[];
    for(const img of images) {
      let data:Buffer;
      if(img.base64) { const base64=img.base64.replace(/\s/g,''); if(!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length%4!==0) throw new Error('图片尚未同步完整'); data=Buffer.from(base64,'base64'); }
      else { if(!img.path||!sourceDir) throw new Error('图片附件缺少路径'); const full=safePath(sourceDir,img.path); if(!existsSync(full)) throw new Error('附件尚未同步'); if(lstatSync(full).isSymbolicLink()||!realpathSync(full).startsWith(realpathSync(sourceDir)+path.sep)) throw new Error('不接受记录目录之外的附件'); if(statSync(full).size>20*1024*1024) throw new Error('单张图片不能超过 20 MB'); data=readFileSync(full); }
      const mime=sniffImage(data); const hash=sha256(data); if(img.sha256&&hash!==img.sha256) throw new Error('附件尚未同步完整，校验值不匹配');
      const file=`attachments/${e.id}/${hash}.${mime.split('/')[1]}`;
      prepared.push({attachment:{name:path.basename(img.name),mime,sha256:hash,file},data});
    }
    let body=e.body??(e.kind==='body'?parseBody(e.text):null); if(body) body=bodySchema.parse(body);
    const parsed=localRecordStatus({kind:e.kind,text:e.text,body});if(parsed.analysis)parsed.analysis=normalizeAnalysis(parsed.analysis,e.text,this.exerciseAliases(),this.exerciseRules());
    if(parsed.analysis) analysisSchema.parse(parsed.analysis);
    const resolved=e.dateLocked?null:resolveRecordDate(e.text,e.occurredAt,e.timezone);
    const r:HealthRecord={id:e.id,kind:e.kind,occurredAt:resolved?.occurredAt??e.occurredAt,capturedAt:e.occurredAt,dateLocked:e.dateLocked,...(resolved?{dateResolution:{originalAt:e.occurredAt,matchedText:resolved.matchedText,dateOnly:resolved.dateOnly}}:{}),...(recoveredTime&&!resolved?{timeSource:'file_modified' as const}:{}),timezone:e.timezone,text:e.text,attachments:prepared.map(p=>p.attachment),body,analysis:parsed.analysis,status:parsed.status,revision:1,createdAt:iso(),updatedAt:iso(),deleted:false,source};
    for(const p of prepared) atomicWrite(safePath(this.root,p.attachment.file),p.data);
    atomicWrite(path.join(this.root,'raw',`${e.id}.json`),JSON.stringify({...e,...(recoveredTime?{occurredAt:'',timeRecovery:{source:'file_modified',usedAt:recoveredTime}}:{}),attachments:r.attachments,imageBase64:undefined},null,2));
    this.putRecord(r,fp); this.refreshAutomaticMemories(); return {record:r,duplicate:false};
  }
  importMany(envelopes:unknown[],source='历史笔记'):HealthRecord[] {
    envelopes.forEach(e=>envelopeSchema.parse(e));
    return this.transaction(()=>envelopes.map(e=>this.importEnvelope(e,undefined,source).record));
  }
  scanInbox():typeof this.syncState {
    const result={imported:0,pending:0,errors:[] as string[],at:iso()}; const inbox=this.getSettings().inbox;
    if(!inbox||!existsSync(inbox)) { result.errors.push('尚未找到手机收件箱，请在设置中建立或选择文件夹。'); this.syncState=result; return result; }
    const files:string[]=[];
    for(const entry of readdirSync(inbox,{withFileTypes:true})) { if(entry.isFile()&&entry.name.endsWith('.json')) files.push(path.join(inbox,entry.name)); if(entry.isDirectory()) {const f=path.join(inbox,entry.name,'record.json');if(existsSync(f)) files.push(f);} }
    for(const file of files.slice(0,5000)) {
      try {
        if(lstatSync(file).isSymbolicLink()||!realpathSync(file).startsWith(realpathSync(inbox)+path.sep)) throw new Error('记录文件路径无效');
        const info=statSync(file);if(info.size>40*1024*1024) throw new Error('单条记录过大');
        const data=JSON.parse(readFileSync(file,'utf8'));
        // v0.1's generated Shortcuts could omit their date. Only recover that exact
        // envelope shape; other malformed dates must still fail strict validation.
        const legacy=data?.version===1&&data.occurredAt===''&&/^-[1-9]\d{6}$/.test(data.id)&&path.basename(file)===`${data.id}.health.json`&&typeof data.textBase64==='string'&&typeof data.imageBase64==='string'&&data.timezone==='Asia/Shanghai';
        if(!this.importRecord(data,path.dirname(file),'iPhone / iCloud',legacy?info.mtime.toISOString():undefined).duplicate)result.imported++;
      }
      catch(e) { const msg=readableError(e); if(e instanceof SyntaxError||/尚未同步/.test(msg)) result.pending++; else result.errors.push(`${path.basename(file)}：${msg}`); }
    }
    this.syncState={...result,errors:result.errors.slice(0,20)}; return this.syncState;
  }
  revise(id:string,changes:Partial<Pick<HealthRecord,'text'|'occurredAt'|'body'|'deleted'>>,expectedRevision:number) {
    if(changes.deleted!==undefined) z.boolean().parse(changes.deleted);
    const old=this.record(id); if(old.revision!==expectedRevision) throw new Error('记录已变化，请刷新后再修改。');
    const checked=envelopeSchema.parse({version:1,id:old.id,kind:old.kind,occurredAt:changes.occurredAt??old.occurredAt,timezone:old.timezone,text:changes.text??old.text,body:changes.body===null?undefined:changes.body??old.body??undefined});
    const body=checked.body??(old.kind==='body'?parseBody(checked.text):null);
    const manualDate=changes.occurredAt!==undefined;
    let resolved=null;
    if(!manualDate&&!old.dateLocked&&changes.text!==undefined&&checked.text!==old.text){
      const fragment=checked.text.startsWith(old.text)?checked.text.slice(old.text.length):checked.text;
      resolved=resolveRecordDate(fragment,iso(),old.timezone);
      const original=resolveRecordDate(old.text,old.capturedAt??old.occurredAt,old.timezone);
      if(resolved&&original?.matchedText===resolved.matchedText)resolved=null;
    }
    const contentChanged=checked.text!==old.text||JSON.stringify(body)!==JSON.stringify(old.body);
    const updated={...old,text:checked.text,occurredAt:resolved?.occurredAt??checked.occurredAt,timeSource:manualDate||resolved?undefined:old.timeSource,dateLocked:manualDate?true:old.dateLocked,dateResolution:manualDate?undefined:resolved?{originalAt:old.occurredAt,matchedText:resolved.matchedText,dateOnly:resolved.dateOnly}:old.dateResolution,body,deleted:changes.deleted??old.deleted,...(contentChanged?localRecordStatus({...old,text:checked.text,body}):{})};
    return this.commitRevision(old,updated);
  }
  private commitRevision(old:HealthRecord,updated:HealthRecord,options?:{skipInvalidate?:string[]}):HealthRecord {
    const next={...updated,...(updated.analysis?{analysis:normalizeAnalysis(updated.analysis,updated.text,this.exerciseAliases(),this.exerciseRules())}:{}),revision:old.revision+1,updatedAt:iso()};
    const result=this.transaction(()=>{ this.db.prepare('INSERT INTO revisions(entity,id,doc,at) VALUES(?,?,?,?)').run('record',old.id,JSON.stringify(old),iso()); this.putRecord(next); this.invalidate(old.id,new Set(options?.skipInvalidate??[])); return next; });
    this.refreshAutomaticMemories(); return result;
  }
  undoRecord(id:string) { const old=this.record(id); const row=this.db.prepare("SELECT doc FROM revisions WHERE entity='record' AND id=? ORDER BY seq DESC LIMIT 1").get(id); if(!row) throw new Error('这条记录还没有可撤销的修改'); const prior=parseJSON<HealthRecord>(row.doc);return this.commitRevision(old,{...prior,dateLocked:old.occurredAt!==prior.occurredAt?true:prior.dateLocked}); }
  applyAnalysis(id:string,value:unknown,engine:Analysis['engine'],expectedRevision:number):HealthRecord {
    const old=this.record(id); if(old.revision!==expectedRevision) throw new Error('分析期间记录已修改，本次结果未覆盖新内容，请重新分析。'); if(old.deleted) throw new Error('记录已删除');
    let a=analysisSchema.parse(value);
    // 分析结果里附带的长期记忆（补剂标签、记法、偏好等）：先校验原文依据与数字，再自动保存。
    const pendingChanges=a.memoryChanges??[];
    if(pendingChanges.length){
      const saved:{id:string;text:string;kind:string}[]=[];
      for(const c of pendingChanges){
        if(c.kind!=='fact'&&c.kind!=='food')throw new Error('分析中的记忆只能提交长期事实或常用食物，本次未保存。');
        if(!old.text.includes(c.evidenceQuote))throw new Error('分析中的记忆缺少原文依据，本次未保存。');
        const quoteNums=(c.evidenceQuote.match(/\d+(?:\.\d+)?/g)??[]).map(Number);
        if(c.kind==='food'){
          if(!c.food)throw new Error('常用食物缺少名称或营养数据，本次未保存。');
          const values=[c.food.servingGrams,c.food.perServing.kcal,c.food.perServing.protein,c.food.perServing.carbs,c.food.perServing.fat];
          if(values.some(v=>!quoteNums.includes(v)))throw new Error('常用食物的数字必须来自记录原文，本次未保存。');
          if(!normalizeFoodName(c.evidenceQuote).includes(normalizeFoodName(c.food.name)))throw new Error('常用食物的名称必须来自记录原文，本次未保存。');
          const memory=this.saveMemory({kind:'food',text:foodText(c.food),topicKey:c.key,food:c.food,startsAt:old.occurredAt,expiresAt:null,sourceIds:[id],active:true,confirmed:true});
          saved.push({id:memory.id,text:memory.text,kind:memory.kind});
        }else{
          if(!c.text)throw new Error('分析中的长期事实缺少内容，本次未保存。');
          if((c.text.match(/\d+(?:\.\d+)?/g)??[]).some(n=>!quoteNums.includes(Number(n))))throw new Error('分析中的记忆出现了原文未提供的数字，本次未保存。');
          const memory=this.saveMemory({kind:'fact',text:c.text,topicKey:c.key,startsAt:old.occurredAt,expiresAt:null,sourceIds:[id],active:true,confirmed:true});
          saved.push({id:memory.id,text:memory.text,kind:memory.kind});
        }
      }
      a={...a,memoryChanges:[],memoryReceipt:saved};
    }
    // 明确说“和某天哪一餐一样”时，食材与分量整份复制，本地重新计算营养；模型的临时估算不采用。
    if(a.copyFromRecordId){
      let source;try{source=this.record(a.copyFromRecordId);}catch{throw new Error('引用的那餐记录不存在，请换一条或直接描述这餐。');}
      if(source.id===old.id) throw new Error('不能把这条记录设为复制自身');
      if(source.kind!=='meal'||source.deleted||!source.analysis?.ingredients?.length) throw new Error('引用的那餐没有可复制的食材记录，请换一条或直接描述这餐。');
      const label=mealLabel(source.occurredAt,source.timezone);
      a={...a,copyFromRecordId:undefined,ingredients:source.analysis.ingredients.map(i=>({...i,assumption:`${i.assumption}；复制自 ${label}`})),summary:`${a.summary}（按 ${label} 的同款记录复制）`,assumptions:[...a.assumptions,`食材与分量取自 ${label} 的同款记录；如需改动可在记录详情调整。`],copiedFrom:{recordId:source.id,occurredAt:source.occurredAt,slot:mealSlot(source.occurredAt,source.timezone),label}};
    }
    // 常用食物（蛋白粉等）的标签营养由本地强制覆盖，避免模型每次重新估计。
    const presets=this.foodPresets(),matched=new Set<string>();
    if(presets.length&&a.ingredients) a={...a,ingredients:a.ingredients.map(i=>{const preset=matchFoodPreset(presets,i.name);if(!preset)return i;matched.add(preset.name);return {...i,foodId:null,nutrition:{source:'label' as const,basis:`个人常用食物：${preset.brand?preset.brand+' ':''}${preset.name}；每份 ${preset.servingGrams}g，按标签折算每100g`,per100g:foodPer100g(preset)}};})};
    if(matched.size) a={...a,assumptions:[...a.assumptions,...[...matched].map(n=>`营养按常用食物“${n}”的标签数据计算。`)]};
    const calc:Partial<ReturnType<FoodCatalog['calculate']>>=a.ingredients?this.catalog.calculate(a.ingredients):{};
    if(old.kind==='meal'&&engine!=='local'&&(!a.ingredients?.length||('unmatched' in calc&&calc.unmatched?.length)))throw new Error('本次分析没有为所有食材提供营养估算，原记录已保留，请重新分析。');
    const proposed=(a.memories??[]).map(m=>memoryInputSchema.parse({kind:m.kind,text:m.text,startsAt:old.occurredAt,expiresAt:m.kind==='state'?(m.expiresAt??new Date(Date.parse(old.occurredAt)+7*86400000).toISOString()):null,sourceIds:[id],active:true,confirmed:false}));
    const analysis:Analysis=normalizeAnalysis({...a,...calc,engine,at:iso()},old.text,this.exerciseAliases(),this.exerciseRules());
    const r=this.commitRevision(old,{...old,analysis,status:old.kind==='meal'&&(!a.ingredients?.length||('unmatched' in calc&&calc.unmatched?.length))?'pending':a.questions.length?'needs_info':'ready'},{skipInvalidate:analysis.memoryReceipt?.map(m=>m.id)??[]});
    for(const m of proposed) this.saveMemory(m);
    return r;
  }
  private invalidate(id:string,skip:Set<string>=new Set()) {
    for(const m of this.messages()) if(m.sources.some(s=>s.id===id)) this.putMessage({...m,stale:true});
    for(const m of this.memories()) if(!skip.has(m.id)&&m.sourceIds.includes(id)) this.db.prepare('UPDATE memories SET doc=? WHERE id=?').run(JSON.stringify({...m,stale:true}),m.id);
  }
  memories():Memory[] { return this.db.prepare('SELECT doc FROM memories').all().map(r=>parseJSON<Memory>(r.doc)); }
  saveMemory(input:unknown,id?:string):Memory {
    const p=memoryInputSchema.parse(input); if(p.kind==='fact'&&!p.confirmed) throw new Error('长期事实需要来自你的确认');
    p.sourceIds.forEach(i=>this.record(i));
    const all=this.memories();const old=id?all.find(m=>m.id===id):(p.topicKey?all.find(m=>m.topicKey===p.topicKey):undefined); if(id&&!old) throw new Error('未找到这条记忆');
    if(p.kind==='food'){
      if(!p.food) throw new Error('常用食物需要名称、每份克数和营养数据');
      const name=normalizeFoodName(p.food.name);
      if(all.some(m=>m.id!==old?.id&&m.kind==='food'&&m.food&&normalizeFoodName(m.food.name)===name)) throw new Error('已有同名常用食物，请直接编辑那一条。');
    } else if(!old){
      const text=normalizeFoodName(p.text);
      if(all.some(m=>m.active&&!m.stale&&m.kind!=='food'&&m.autoManaged!==true&&normalizeFoodName(m.text)===text)) throw new Error('已有相同内容的记忆，无需重复添加。');
    }
    if(old) this.db.prepare('INSERT INTO revisions(entity,id,doc,at) VALUES(?,?,?,?)').run('memory',old.id,JSON.stringify(old),iso());
    const m:Memory={...old,...p,id:old?.id??randomUUID(),stale:false,...(old?.autoKey?{autoManaged:false}: {})}; this.db.prepare('INSERT INTO memories VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(m.id,JSON.stringify(m)); return m;
  }
  foodPresets():FoodPreset[]{return this.memories().filter(m=>m.kind==='food'&&m.food&&validMemory(m)).map(m=>m.food!);}
  ignoredFoodCandidates():string[]{return (this.getConfig<string[]>('ignoredFoodCandidates')??[]).filter(x=>typeof x==='string');}
  ignoreFoodCandidate(value:unknown){
    const name=z.string().trim().min(1).max(80).parse(value),ignored=this.ignoredFoodCandidates();
    if(!ignored.includes(name))this.setConfig('ignoredFoodCandidates',[...ignored,name]);
    return {ignored:this.ignoredFoodCandidates()};
  }
  // 反复出现的食材只作为“可加入常用食物”的候选，不自动写入；用户确认后才成为标签数据。
  foodCandidates():FoodCandidate[]{
    const presets=this.foodPresets(),ignored=new Set(this.ignoredFoodCandidates()),groups=new Map<string,{name:string;meals:Set<string>;days:Set<string>;latestAt:string;grams:Set<string>;per100g:FoodCandidate['per100g']|null;source:FoodCandidate['source']}>();
    for(const r of this.records().filter(x=>!x.deleted&&x.kind==='meal')){
      for(const ing of r.analysis?.ingredients??[]){
        if(!ing.nutrition&&ing.foodId===null)continue;
        const key=normalizeFoodName(ing.name);if(!key||ignored.has(ing.name))continue;
        const group=groups.get(key)??{name:ing.name,meals:new Set(),days:new Set(),latestAt:'',grams:new Set(),per100g:null,source:'estimate' as FoodCandidate['source']};
        group.meals.add(r.id);group.days.add(localDay(r.occurredAt,r.timezone));
        if(r.occurredAt>=group.latestAt){
          group.latestAt=r.occurredAt;
          group.grams=new Set([`${ing.grams.low}-${ing.grams.high}`]);
          let per100g:FoodCandidate['per100g']|null=ing.nutrition?.per100g??null,source:FoodCandidate['source']=ing.nutrition?.source??'estimate';
          if(!per100g&&ing.foodId!==null){const f=this.catalog.get(ing.foodId);if(f&&[f.kcal,f.protein,f.carbs,f.fat].every(v=>v!==null)){per100g={kcal:{low:f.kcal!,high:f.kcal!},protein:{low:f.protein!,high:f.protein!},carbs:{low:f.carbs!,high:f.carbs!},fat:{low:f.fat!,high:f.fat!}};source='catalog';}}
          if(per100g){group.per100g=per100g;group.source=source;}
        }
        groups.set(key,group);
      }
    }
    return [...groups.values()].filter(g=>g.meals.size>=2&&g.per100g&&!presets.some(p=>matchFoodPreset([p],g.name))).map(g=>{
      const [low,high]=(()=>{const pair=[...g.grams][0]??'0-0';const [a,b]=pair.split('-').map(Number);return [a,b];})();
      return {name:g.name,meals:g.meals.size,days:g.days.size,latestGrams:{low,high},per100g:g.per100g!,source:g.source,latestAt:g.latestAt};
    }).sort((a,b)=>b.meals-a.meals||b.latestAt.localeCompare(a.latestAt)).slice(0,12);
  }
  exerciseAliases():ExerciseAlias[]{return this.getConfig<ExerciseAlias[]>('exerciseAliases')??[];}
  exerciseRules():ExerciseRules{
    const v=this.getConfig<ExerciseRules>('exerciseRules');
    const overrides=v&&typeof v==='object'&&v.overrides&&typeof v.overrides==='object'?Object.fromEntries(Object.entries(v.overrides).filter(([,b])=>['total','per_hand','machine','bodyweight','unknown'].includes(String(b)))):{};
    return {archived:Array.isArray(v?.archived)?v.archived.filter((x):x is string=>typeof x==='string'):[],overrides};
  }
  private normalizedRecords(aliases:ExerciseAlias[],rules:ExerciseRules){
    return this.records().filter(r=>r.analysis?.sets?.length).map(r=>({before:r,analysis:normalizeAnalysis(r.analysis!,r.text,aliases,rules)})).filter(x=>JSON.stringify(x.before.analysis)!==JSON.stringify(x.analysis));
  }
  private applyNormalized(updates:{before:HealthRecord;analysis:Analysis}[]){
    return this.transaction(()=>{for(const {before,analysis} of updates)this.commitRevision(before,{...before,analysis});return updates.length;});
  }
  saveExerciseRules(value:unknown){
    const rules=z.object({archived:z.array(z.string().trim().min(1).max(100)).max(500).default([]),overrides:z.record(z.string().trim().min(1).max(100),z.enum(['per_hand','total','machine','bodyweight','unknown'])).default({})}).parse(value);
    const previous=this.exerciseRules(),basisChanged=JSON.stringify(previous.overrides)!==JSON.stringify(rules.overrides);
    const updates=basisChanged?this.normalizedRecords(this.exerciseAliases(),rules):[];
    return this.transaction(()=>{this.setConfig('exerciseRules',rules);for(const {before,analysis} of updates)this.commitRevision(before,{...before,analysis});return {rules,updatedRecords:updates.length};});
  }
  deleteExerciseAlias(raw:string){
    const name=z.string().trim().min(1).max(200).parse(raw);
    const aliases=this.exerciseAliases();if(!aliases.some(a=>a.raw===name))throw new Error('这条手动归类不存在，可能已经被删除。');
    const next=aliases.filter(a=>a.raw!==name),rules=this.exerciseRules();
    const affected=this.records().filter(r=>r.analysis?.sets?.some(s=>(s.originalExercise??s.exercise)===name));
    const updates=affected.map(r=>({before:r,analysis:normalizeAnalysis({...r.analysis!,sets:r.analysis!.sets!.map(s=>(s.originalExercise??s.exercise)===name?{...s,exercise:s.originalExercise??s.exercise,exerciseManuallyClassified:false}:s)},r.text,next,rules)}));
    return this.transaction(()=>{this.setConfig('exerciseAliases',next);for(const {before,analysis} of updates)this.commitRevision(before,{...before,analysis});return {updatedRecords:updates.length};});
  }
  setRecordDeleted(id:string,deleted:unknown){const record=this.record(idSchema.parse(id));return this.revise(record.id,{deleted:z.boolean().parse(deleted)},record.revision);}
  coachProfile():CoachProfile{return this.getConfig<CoachProfile>('coachProfile')??DEFAULT_COACH;}
  saveCoachProfile(value:unknown){const profile=coachProfileSchema.parse(value);this.setConfig('coachProfile',profile);return profile;}
  trainingSplit(){return this.memories().filter(m=>validMemory(m)&&m.policy?.split).at(-1)?.policy?.split??DEFAULT_SPLIT;}
  migrate016(){
    if((this.getConfig<number>('exerciseVersion')??0)>=1)return;
    this.backup(path.join(this.root,'backups',`before-v016-${Date.now()}.bodyjournal`));
    for(const r of this.records())if(r.analysis?.sets?.length)this.commitRevision(r,{...r,analysis:normalizeAnalysis(r.analysis,r.text,this.exerciseAliases(),this.exerciseRules())});
    if(!this.getConfig('coachProfile'))this.saveCoachProfile(DEFAULT_COACH);
    this.setConfig('exerciseVersion',1);this.refreshAutomaticMemories();
  }
  migrateExerciseRules(){
    if((this.getConfig<number>('exerciseVersion')??0)>=2)return 0;
    this.backup(path.join(this.root,'backups',`before-v019-${Date.now()}.bodyjournal`));
    // 历史版本可能给每个动作存了“原名→同名”的归类；它没有改名意图，却会挡住新的自动合并。
    // 迁移时清掉同名归类并清除对应记录的手动标记，再按新规则重新归一化。
    const aliases=this.exerciseAliases(),identity=new Set(aliases.filter(a=>a.raw===a.name).map(a=>a.raw)),cleaned=aliases.filter(a=>a.raw!==a.name);
    const rules=this.exerciseRules();
    const updates=this.records().filter(r=>r.analysis?.sets?.length).map(r=>({before:r,analysis:normalizeAnalysis({...r.analysis!,sets:r.analysis!.sets!.map(s=>identity.has(s.originalExercise??s.exercise)?{...s,exerciseManuallyClassified:false}:s)},r.text,cleaned,rules)})).filter(x=>JSON.stringify(x.before.analysis)!==JSON.stringify(x.analysis));
    this.transaction(()=>{this.setConfig('exerciseAliases',cleaned);for(const {before,analysis} of updates)this.commitRevision(before,{...before,analysis});});
    this.setConfig('exerciseVersion',2);this.refreshAutomaticMemories();return updates.length;
  }
  migrateSeatedPress(){
    if((this.getConfig<number>('exerciseVersion')??0)>=3)return 0;
    this.backup(path.join(this.root,'backups',`before-v0110-${Date.now()}.bodyjournal`));
    const updates=this.normalizedRecords(this.exerciseAliases(),this.exerciseRules());
    for(const {before,analysis} of updates)this.commitRevision(before,{...before,analysis});
    this.setConfig('exerciseVersion',3);this.refreshAutomaticMemories();return updates.length;
  }
  // 一次性整理：删除失效的自动记忆与过期推断、停用与常用食物重复的标签状态、合并完全重复的条目。修改前自动完整备份。
  tidyMemories(){
    const safety=path.join(this.root,'backups',`before-memory-tidy-${Date.now()}.bodyjournal`);this.backup(safety);
    this.refreshAutomaticMemories();
    const all=this.memories(),presets=this.foodPresets();
    const remove=new Set<string>(),deactivate=new Set<string>();
    for(const m of all){
      const text=m.text??'';
      if(m.autoKey&&m.stale){remove.add(m.id);continue;}
      if((m.kind==='state'||m.kind==='hypothesis')&&m.stale){remove.add(m.id);continue;}
      if(m.kind==='state'&&m.expiresAt&&Date.parse(m.expiresAt)<Date.now()){remove.add(m.id);continue;}
      if(m.autoKey&&m.autoCategory==='preference'&&/^(补充|更正|纠正)[：:]/.test(text.trim())){remove.add(m.id);continue;}
      if((m.kind==='state'||m.kind==='hypothesis')&&m.active&&!m.stale&&!/^\s*$/.test(text)&&/营养|每100g|每份/.test(text)&&presets.some(p=>{
        const normalized=normalizeFoodName(text),name=normalizeFoodName(p.name),brand=p.brand?normalizeFoodName(p.brand):'';
        return (name.length>=4&&normalized.includes(name))||(brand.length>=4&&normalized.includes(brand));
      })){deactivate.add(m.id);}
    }
    const remaining=all.filter(m=>!remove.has(m.id)&&!deactivate.has(m.id)&&m.active&&!m.stale);
    const byText=new Map<string,Memory[]>();
    for(const m of remaining){const key=`${m.kind}:${normalizeFoodName(m.text)}`;const list=byText.get(key)??[];list.push(m);byText.set(key,list);}
    const merged=new Map<string,string[]>();
    for(const group of byText.values())if(group.length>1){
      group.sort((a,b)=>Number(a.autoManaged===true)-Number(b.autoManaged===true)||b.sourceIds.length-a.sourceIds.length||Date.parse(b.startsAt)-Date.parse(a.startsAt));
      const keep=group[0];const sources=[...new Set(group.flatMap(m=>m.sourceIds))];
      merged.set(keep.id,sources);
      for(const other of group.slice(1))remove.add(other.id);
    }
    const revision=this.db.prepare('INSERT INTO revisions(entity,id,doc,at) VALUES(?,?,?,?)'),del=this.db.prepare('DELETE FROM memories WHERE id=?'),update=this.db.prepare('UPDATE memories SET doc=? WHERE id=?');
    this.transaction(()=>{
      for(const m of all)if(remove.has(m.id)){revision.run('memory',m.id,JSON.stringify(m),iso());del.run(m.id);}
      for(const id of deactivate){const m=all.find(x=>x.id===id)!;revision.run('memory',m.id,JSON.stringify(m),iso());update.run(JSON.stringify({...m,active:false,autoManaged:false}),m.id);}
      for(const [id,sources] of merged){const m=all.find(x=>x.id===id)!;revision.run('memory',m.id,JSON.stringify(m),iso());update.run(JSON.stringify({...m,sourceIds:sources}),m.id);}
    });
    this.refreshAutomaticMemories();
    return {safety,removed:remove.size,deactivated:deactivate.size,merged:merged.size};
  }
  // P0 记忆结构：给既有长期事实补稳定主题键，供分组、同主题覆盖与检索分层使用。
  migrateMemoryTopics(){
    if((this.getConfig<number>('memoryVersion')??0)>=1)return 0;
    this.backup(path.join(this.root,'backups',`before-memory-v2-${Date.now()}.bodyjournal`));
    const map:[RegExp,string][]=[
      [/^主要吃食堂/,'eating.environment'],[/^喜欢更换菜式/,'eating.estimation'],[/^希望记录负担/,'recording.burden'],
      [/^默认使用简体中文/,'communication.language'],[/^训练日志优先用表格/,'communication.training_format'],[/^记录记法（已确认）/,'recording.conventions'],
    ];
    const revision=this.db.prepare('INSERT INTO revisions(entity,id,doc,at) VALUES(?,?,?,?)'),update=this.db.prepare('UPDATE memories SET doc=? WHERE id=?');
    let updated=0;
    this.transaction(()=>{
      for(const m of this.memories()){
        if(m.topicKey)continue;
        const hit=map.find(([re])=>re.test(m.text));if(!hit)continue;
        revision.run('memory',m.id,JSON.stringify(m),iso());update.run(JSON.stringify({...m,topicKey:hit[1]}),m.id);updated++;
      }
      this.setConfig('memoryVersion',1);
    });
    return updated;
  }
  reclassifyExercise(raw:string,name:string){return this.reclassifyExercises([{raw,name}]).aliases;}
  reclassifyExercises(value:unknown){
    const changes=z.array(z.object({raw:z.string().trim().min(1).max(200),name:z.string().trim().min(1).max(100)})).min(1).max(500).parse(value);
    if(new Set(changes.map(c=>c.raw)).size!==changes.length)throw new Error('同一动作收到多个名称，请保留一个归类。');
    for(const {raw,name} of changes)if(/[（）()]/.test(name))throw new Error(`“${raw}”的新名称不能包含括号，单手、器械或轮次请保留在组信息中。本次修改未保存。`);
    const changeMap=new Map(changes.map(c=>[c.raw,c.name]));
    const aliases=this.exerciseAliases().filter(a=>!changeMap.has(a.raw));aliases.push(...changes);
    const rules=this.exerciseRules();const updates=this.records().filter(r=>r.analysis?.sets?.some(s=>changeMap.has(s.originalExercise??s.exercise))).map(r=>({before:r,analysis:normalizeAnalysis(r.analysis!,r.text,aliases,rules)})).filter(x=>JSON.stringify(x.before.analysis)!==JSON.stringify(x.analysis));
    return this.transaction(()=>{this.setConfig('exerciseAliases',aliases);for(const {before,analysis} of updates)this.commitRevision(before,{...before,analysis});return {aliases,updatedRecords:updates.length,changedAliases:changes.length};});
  }
  repairExerciseAliases(){const aliases=this.exerciseAliases();if(aliases.length)this.reclassifyExercises(aliases);}
  completeChat(reply:Message,changes:MemoryChange[],user:Message,expected:Memory[],expectedGoals:Settings['goals'],energyProposal?:{value:{kcal:number;reason:string};hash:string}) {
    const updates=changes.map(c=>memoryChangeSchema.parse(c));const current=this.memories();
    const changed:{id:string;before:Memory|null;after:Memory}[]=[];let goals={...expectedGoals};
    for(const c of updates){
      if(!user.text.includes(c.evidenceQuote))throw new Error('记忆更新缺少你的原话依据，未保存。');
      const explicit=/记住|记下|记一下|记录一下|保存|添加|加一个|更新|更正|改成|改为|改一下|纠正|以后|默认|常用食物|补剂|我(?:不)?(?:喜欢|习惯|偏好|希望|目标|现在|最近|这周|目前|通常|一般|经常)|不再|忘掉|停用|不用再|最多|每次/.test(c.evidenceQuote)||/^\s*(?:请|帮我)?(?:记住|记下|记一下|记录一下|保存)/.test(user.text)||/(?:添加|加一个|更新|录入|设置).{0,12}(?:记忆|常用食物|食物|补剂|偏好|档案)/.test(user.text);
      // 自动记忆：常用食物带标签数字即可直接保存；长期主题的事实用户明确陈述时保存；临时状态/待验证判断写入短期记忆。
      const durableDomains=/^(communication|eating|training|nutrition|food|supplement|meal|diet|recording|health|profile)\./;
      const looksQuestion=/[？?]|吗|多少|怎么|如何|是否/.test(c.evidenceQuote);
      const labelLike=/(每\s*100\s*g|每100克|每份|每勺|每袋|每片)/i.test(c.evidenceQuote)&&/\d/.test(c.evidenceQuote);
      const durableAuto=c.kind==='food'||labelLike||(durableDomains.test(c.key)&&!/^\s*$/.test(c.evidenceQuote)&&(/我|我的|常用|固定|每天|每份|以后|默认/.test(c.evidenceQuote))&&!looksQuestion);
      const ephemeral=c.kind==='state'||c.kind==='hypothesis';
      if(!explicit&&!durableAuto&&!ephemeral)throw new Error('没有识别到可长期保存的信息或原话依据，未改动档案；可以说“记住：……”或补充更明确的说法。');
      if(c.kind==='food'){
        if(!c.food)throw new Error('常用食物需要名称、每份克数和四项营养，未保存。');
        const foodNums=[c.food.servingGrams,c.food.perServing.kcal,c.food.perServing.protein,c.food.perServing.carbs,c.food.perServing.fat];
        const quoteNums=(c.evidenceQuote.match(/\d+(?:\.\d+)?/g)??[]).map(Number);
        if(foodNums.some(v=>!quoteNums.includes(v)))throw new Error('常用食物的数字必须来自你的原话，未保存。');
        if(!normalizeFoodName(c.evidenceQuote).includes(normalizeFoodName(c.food.name)))throw new Error('常用食物的名称必须来自你的原话，未保存。');
      }
      const before=c.targetId?current.find(m=>m.id===c.targetId):(c.kind==='food'&&c.food?current.find(m=>m.kind==='food'&&m.food&&normalizeFoodName(m.food.name)===normalizeFoodName(c.food!.name)):undefined)??current.find(m=>m.topicKey===c.key);
      if(c.targetId&&!before)throw new Error('要更新的记忆已不存在。');
      if(before){const snapshot=expected.find(m=>m.id===before.id);if(!snapshot||JSON.stringify(snapshot)!==JSON.stringify(before))throw new Error('记忆在回答期间已变化，本次未覆盖，请重新提出修改。');}
      if(changed.some(x=>x.id===before?.id||x.after.topicKey===c.key))throw new Error('同一条记忆收到重复更新，未保存。');
      if(c.operation==='deactivate'){
        if(!before)throw new Error('尚未找到要停用的记忆，请明确是哪一条。');
        changed.push({id:before.id,before,after:{...before,active:false,autoManaged:false,sourceMessageIds:[...(before.sourceMessageIds??[]),user.id]}});continue;
      }
      if(c.split&&(c.key!=='training.split'||c.kind!=='fact'||!/分化|顺序|轮转|循环/.test(c.evidenceQuote)))throw new Error('训练顺序需要明确的顺序设置，未改动轮转。');
      if(!c.text&&c.kind!=='food')throw new Error('记忆内容为空，未保存。');
      const text=c.kind==='food'?foodText(c.food!):c.text!;
      const quoteNumbers:string[]=c.evidenceQuote.match(/\d+(?:\.\d+)?/g)??[];if((text.match(/\d+(?:\.\d+)?/g)??[]).some(n=>!quoteNumbers.includes(n)))throw new Error('记忆中出现了原话未提供的数字，未保存。');
      if(c.operation==='set_goal'){
        if(!/目标|训练安排/.test(c.evidenceQuote)||!/改|更新|设|希望|目标是/.test(c.evidenceQuote))throw new Error('修改目标需要你的明确表达。');
        if(c.key==='goals.goal')goals.goal=text;else if(c.key==='goals.training')goals.training=text;else throw new Error('这类目标请在我的档案中设置。');
      }
      const startsAt=user.createdAt,expiresAt=c.kind==='state'?(c.expiresAt??new Date(Date.parse(startsAt)+7*86400000).toISOString()):null;
      const checked=memoryInputSchema.parse({kind:c.kind??'fact',text,startsAt,expiresAt,sourceIds:[],active:true,confirmed:c.kind!=='hypothesis',...(c.food?{food:c.food}:{})});
      const id=before?.id??randomUUID();const after:Memory={...before,...checked,id,topicKey:c.key,sourceMessageIds:[...(before?.sourceMessageIds??[]),user.id].slice(-20),autoManaged:false,stale:false,...(c.split?{policy:{split:c.split}}:{})};
      changed.push({id,before:before??null,after});
    }
    if(updates.some(c=>c.operation==='set_goal')&&JSON.stringify(this.getSettings().goals)!==JSON.stringify(expectedGoals))throw new Error('目标已在回答期间修改，本次未覆盖。');
    const receipt=changed.length?{changed,...(JSON.stringify(goals)!==JSON.stringify(expectedGoals)?{beforeGoals:expectedGoals,afterGoals:goals}:{})}:undefined;
    return this.transaction(()=>{
      for(const c of changed){if(c.before)this.db.prepare('INSERT INTO revisions(entity,id,doc,at) VALUES(?,?,?,?)').run('memory',c.id,JSON.stringify(c.before),iso());this.db.prepare('INSERT INTO memories VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(c.id,JSON.stringify(c.after));}
      if(receipt?.afterGoals)this.setSettings({...this.getSettings(),goals});
      const proposal=energyProposal?this.energy.createProposal(energyProposal.value,reply.id,energyProposal.hash):undefined;
      const complete={...reply,memoryReceipt:receipt,...(proposal?{goalProposalId:proposal.id}:{})};this.putMessage(complete);return complete;
    });
  }
  undoChatMemory(messageId:string){
    const message=this.messages().find(m=>m.id===messageId),receipt=message?.memoryReceipt;if(!message||!receipt||receipt.undone)throw new Error('这次记忆更新已撤销或不存在。');
    for(const c of receipt.changed){const current=this.memories().find(m=>m.id===c.id);if(JSON.stringify(current)!==JSON.stringify(c.after))throw new Error('记忆已被后续更新，请在我的档案中修改，避免覆盖新内容。');}
    if(receipt.afterGoals&&JSON.stringify(this.getSettings().goals)!==JSON.stringify(receipt.afterGoals))throw new Error('目标已有后续变化，请在我的档案中调整。');
    return this.transaction(()=>{for(const c of receipt.changed){const restored=c.before??{...c.after,active:false};this.db.prepare('INSERT INTO revisions(entity,id,doc,at) VALUES(?,?,?,?)').run('memory',c.id,JSON.stringify(c.after),iso());this.db.prepare('UPDATE memories SET doc=? WHERE id=?').run(JSON.stringify(restored),c.id);}if(receipt.beforeGoals)this.setSettings({...this.getSettings(),goals:receipt.beforeGoals});this.putMessage({...message,memoryReceipt:{...receipt,undone:true}});});
  }
  refreshAutomaticMemories() {
    const existing=this.memories(),drafts=automaticMemories(this.records()),keys=new Set(drafts.map(m=>m.autoKey));
    const write=(m:Memory,old?:Memory)=>{if(old)this.db.prepare('INSERT INTO revisions(entity,id,doc,at) VALUES(?,?,?,?)').run('memory',old.id,JSON.stringify(old),iso());this.db.prepare('INSERT INTO memories VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(m.id,JSON.stringify(m));};
    for(const draft of drafts){const old=existing.find(m=>m.autoKey===draft.autoKey);if(old&&old.autoManaged===false)continue;const next:Memory={...draft,id:old?.id??randomUUID(),stale:false};if(JSON.stringify(old)!==JSON.stringify(next))write(next,old);}
    for(const old of existing)if(old.autoKey&&old.autoManaged!==false&&!keys.has(old.autoKey)&&!old.stale)write({...old,stale:true},old);
  }
  refreshPersonalization() {
    const corrections=this.records().filter(r=>!r.dateLocked&&!r.dateResolution).map(r=>({r,date:resolveRecordDate(r.text,r.capturedAt??r.occurredAt,r.timezone)})).filter(x=>x.date&&(x.date.dateOnly?localDay(x.date.occurredAt,x.r.timezone)!==localDay(x.r.occurredAt,x.r.timezone):x.date.occurredAt!==x.r.occurredAt));
    if(corrections.length)this.backup(path.join(this.root,'backups',`before-date-correction-${Date.now()}.bodyjournal`));
    for(const {r,date} of corrections)this.commitRevision(r,{...r,occurredAt:date!.occurredAt,capturedAt:r.capturedAt??r.occurredAt,timeSource:undefined,dateResolution:{originalAt:r.occurredAt,matchedText:date!.matchedText,dateOnly:date!.dateOnly}});
    this.refreshAutomaticMemories();return corrections.length;
  }
  undoMemory(id:string) { const row=this.db.prepare("SELECT doc FROM revisions WHERE entity='memory' AND id=? ORDER BY seq DESC LIMIT 1").get(id); if(!row) throw new Error('没有可撤销的记忆修改'); const m=parseJSON<Memory>(row.doc); return this.saveMemory(m,id); }
  messages():Message[] { return this.db.prepare('SELECT doc FROM messages ORDER BY rowid').all().map(r=>parseJSON<Message>(r.doc)); }
  putMessage(m:Message) { this.db.prepare('INSERT INTO messages VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(m.id,JSON.stringify(m)); }
  history(id:string) { return this.db.prepare('SELECT doc,at FROM revisions WHERE id=? ORDER BY seq DESC LIMIT 30').all(id).map(r=>({at:r.at,record:parseJSON(r.doc)})); }
  usage(month=iso().slice(0,7)) {
    const rows=this.db.prepare("SELECT * FROM usage WHERE month=? AND provider='deepseek'").all(month);
    return {month,inputTokens:rows.reduce((s,r)=>s+Number(r.input),0),outputTokens:rows.reduce((s,r)=>s+Number(r.output),0),cost:rows.reduce((s,r)=>s+Number(r.cost),0),uncertain:rows.some(r=>['uncertain','reserved'].includes(String(r.state)))};
  }
  reserveUsage(provider:string,estimate:number):string {
    const s=this.getSettings(); if(provider==='deepseek' && (s.deepseekBudget<=0||this.usage().cost+estimate>s.deepseekBudget)) throw new Error('本月预算不足，未发送请求。可在设置中查看或调整预算。');
    const id=randomUUID(); this.db.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)').run(id,iso().slice(0,7),provider,0,0,estimate,'reserved',iso()); return id;
  }
  finishUsage(id:string,input:number,output:number,cost:number,state='complete') { this.db.prepare('UPDATE usage SET input=?,output=?,cost=?,state=? WHERE id=?').run(input,output,cost,state,id); }
  failUsage(id:string) { this.db.prepare("UPDATE usage SET state='uncertain' WHERE id=?").run(id); }
  // 检索分层：只把与用途/问题相关的记忆带进模型上下文；长期事实永远保留。
  memoryContext(purpose:'chat'|'weekly'|'memory'|'meal'|'training',query:string){
    const all=this.memories().filter(m=>validMemory(m));
    const facts=all.filter(m=>m.kind==='fact'),states=all.filter(m=>m.kind==='state'),foods=all.filter(m=>m.kind==='food'),refs=all.filter(m=>m.autoCategory==='training'),templates=all.filter(m=>m.autoCategory==='meal');
    const compact=(s:string)=>s.replace(/[^\p{L}\p{N}]+/gu,''),grams=(s:string)=>{const c=compact(s),out=new Set<string>();for(const n of [2,3,4])for(let i=0;i+n<=c.length;i++)out.add(c.slice(i,i+n));return [...out];};
    const queryGrams=grams(query),hits=(text:string)=>queryGrams.some(g=>compact(text).includes(g));
    const exerciseName=(text:string)=>text.split('：')[0].trim(),latestDate=(text:string)=>(text.match(/20\d{2}-\d{2}-\d{2}/g)??[]).sort().at(-1)??'';
    const picked:{m:Memory;reason:string}[]=[],add=(m:Memory,reason:string)=>{if(!picked.some(p=>p.m.id===m.id))picked.push({m,reason});};
    const budget=purpose==='weekly'?1600:purpose==='meal'?1200:purpose==='training'?2000:purpose==='memory'?2400:800;
    if(purpose==='meal'){
      for(const f of facts)if(/吃|餐|食|蛋白|补剂/.test(f.text)||/^(eating|profile\.eating|recording)\./.test(f.topicKey??''))add(f,'饮食相关长期事实');
      for(const f of foods)add(f,'常用食物');
      for(const t of templates)if(t.mealTemplate?.some(i=>hits(i.name)))add(t,'命中常吃餐食');
    }else if(purpose==='training'){
      for(const f of facts)if(!/吃|餐|食/.test(f.text))add(f,'长期事实');
      for(const r of refs){const name=exerciseName(r.text);if(hits(name))add(r,'命中动作参照');}
    }else if(purpose==='weekly'){
      for(const f of facts)add(f,'长期事实');
      const weekStart=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
      for(const r of refs)if(latestDate(r.text)>=weekStart)add(r,'本周练过的动作');
      for(const s of states.slice(-2))add(s,'近期状态');
    }else{
      for(const f of facts)add(f,'长期事实');
      for(const f of foods)if(hits(`${f.food?.name??''} ${f.food?.brand??''}`))add(f,'命中常用食物');
      const exactRefs=refs.filter(r=>query.includes(exerciseName(r.text))||compact(query).includes(compact(exerciseName(r.text))));
      for(const r of exactRefs)add(r,'精确命中动作');
      // 宽泛动作词（如“卧推”）不把三头类复合动作带进来，避免回答被无关动作干扰。
      const tricepsQuery=/窄距|碎颅|臂屈伸|三头/.test(query);
      const weakRefs=refs.filter(r=>!exactRefs.includes(r)&&!exerciseName(r.text).includes('接')&&(tricepsQuery||!/窄距|碎颅|臂屈伸|三头/.test(exerciseName(r.text)))&&hits(exerciseName(r.text))).sort((a,b)=>latestDate(b.text).localeCompare(latestDate(a.text))).slice(0,3);
      for(const r of weakRefs)add(r,'相关动作参照');
      // 明确问“训练/参照/练得怎么样”但没点名具体动作时，带上最近几次训练参照。
      const trainingIntent=/训练|动作|重量|参照|组次|练|健身|进步|退步|RPE|RIR/.test(query);
      if(!exactRefs.length&&!weakRefs.length&&trainingIntent)for(const r of [...refs].sort((a,b)=>latestDate(b.text).localeCompare(latestDate(a.text))).slice(0,4))add(r,'训练意图相关参照');
      const stateish=/睡|累|精力|状态|感觉|饿|饱|吃|餐/.test(query);
      for(const s of states){const t=s.text;if(stateish&&(/睡/.test(t)||/餐|吃|饱/.test(t)||/精力|累/.test(t)))add(s,'与问题相关的近期状态');}
    }
    const ordered=[...picked.filter(p=>/长期事实|饮食相关/.test(p.reason)),...picked.filter(p=>!/长期事实|饮食相关/.test(p.reason))];
    const items:Memory[]=[];let chars=0,omitted=0,omittedChars=0;
    for(const {m,reason} of ordered){const size=(m.text??'').length,always=/长期事实|饮食相关/.test(reason);if(chars+size>budget&&!always){omitted++;omittedChars+=size;continue;}items.push(m);chars+=size;}
    return {items,chars,omitted,omittedChars,budget};
  }
  context(question:string,purpose:'chat'|'weekly'|'memory'='chat') {
    const all=this.records(); const now=Date.now(); const long=/全部|所有|历史|长期|半年|一年/.test(question);
    const days=/月/.test(question)?90:35; const keywords=question.split(/[，。！？\s]+/).filter(s=>s.length>1);
    const selection=this.memoryContext(purpose,question),memories=selection.items,memoryIds=new Set([...memories.flatMap(m=>m.sourceIds),...[...question.matchAll(/\[记录:([a-zA-Z0-9_-]+)\]/g)].map(m=>m[1])]);
    const recent=all.filter(r=>long||Date.parse(r.occurredAt)>=now-days*86400000||keywords.some(k=>r.text.includes(k)));
    const relevant=[...new Map([...all.filter(r=>memoryIds.has(r.id)).slice(0,60),...recent].map(r=>[r.id,r])).values()].slice(0,160).sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
    return {goals:this.getSettings().goals,memories,weekly:weeklyContext(all,this.getSettings().timezone,new Date(),this.trainingSplit()),stats:computeStats(relevant,this.getSettings().timezone,{rules:this.exerciseRules()}),records:relevant.map(r=>({id:r.id,revision:r.revision,kind:r.kind,occurredAt:r.occurredAt,timeSource:r.timeSource,dateResolution:r.dateResolution,text:r.text.slice(0,4000),body:r.body,status:r.status,analysis:r.analysis})),coverage:{allRecords:all.length,included:relevant.length,earliest:relevant.at(-1)?.occurredAt,latest:relevant[0]?.occurredAt,scope:long?'历史记录（最多 160 条）':`最近 ${days} 天及关键词匹配记录（最多 160 条）`},memoryCoverage:{included:selection.items.length,omitted:selection.omitted,chars:selection.chars,budget:selection.budget}};
  }
  attachmentData(id:string,index:number) { const r=this.record(id); const a=r.attachments[index]; if(!a) throw new Error('附件不存在'); const data=readFileSync(safePath(this.root,a.file)); if(sha256(data)!==a.sha256) throw new Error('图片校验失败'); return `data:${a.mime};base64,${data.toString('base64')}`; }
  exportBundle() {
    const tables:Record<string,unknown[]>={}; for(const name of ['records','revisions','memories','messages','usage']) tables[name]=this.db.prepare(`SELECT * FROM ${name}`).all();
    const files:{path:string;sha256:string;base64:string}[]=[];
    for(const r of this.records(true)) { for(const a of r.attachments) { const data=readFileSync(safePath(this.root,a.file)); files.push({path:a.file,sha256:sha256(data),base64:data.toString('base64')}); } const raw=`raw/${r.id}.json`; if(existsSync(safePath(this.root,raw))) {const data=readFileSync(safePath(this.root,raw));files.push({path:raw,sha256:sha256(data),base64:data.toString('base64')});} }
    return {format:'bodyjournal-backup',version:this.energy?2:1,createdAt:iso(),coachProfile:this.coachProfile(),exerciseAliases:this.exerciseAliases(),settings:this.getSettings(),tables,files,energy:this.energy?.export()};
  }
  backup(file:string) { const data=JSON.stringify(this.exportBundle());if(Buffer.byteLength(data)>512*1024*1024)throw new Error('此档案超过首版完整备份的 512 MB 上限，请使用可读导出保存资料。');atomicWrite(file,data); }
  restore(bundle:unknown) {
    const b=bundle as ReturnType<HealthStore['exportBundle']>; if(!b||b.format!=='bodyjournal-backup'||![1,2].includes(b.version)||!Array.isArray(b.files)||!b.tables) throw new Error('备份格式不支持');
    const energyData=this.energy.validateBackup(b.version===2?b.energy:{profiles:[],targets:[],days:[],proposals:[]});
    const profile=b.coachProfile?coachProfileSchema.parse(b.coachProfile):undefined;const aliases=b.exerciseAliases?z.array(z.object({raw:z.string().max(200),name:z.string().min(1).max(100)})).max(1000).parse(b.exerciseAliases):undefined;
    const settings=settingsSchema.parse(b.settings); settings.inbox=this.getSettings().inbox;
    const revisionRows=z.array(z.object({seq:z.number().int().positive(),entity:z.enum(['record','memory']),id:idSchema,doc:z.string(),at:z.iso.datetime({offset:true})})).max(1000000).parse(b.tables.revisions);
    for(const row of revisionRows){const value=JSON.parse(row.doc);if(value.id!==row.id)throw new Error('备份修订的编号不一致');if(row.entity==='memory')memoryInputSchema.parse(value);else {envelopeSchema.parse({version:1,...value,body:value.body??undefined,attachments:[]});if(value.analysis)analysisSchema.parse(value.analysis);if(!Number.isInteger(value.revision)||value.revision<1)throw new Error('备份修订版本无效');}}
    const usageRows=z.array(z.object({id:idSchema,month:z.string().regex(/^\d{4}-\d{2}$/),provider:z.enum(['chatgpt','deepseek']),input:z.number().int().nonnegative(),output:z.number().int().nonnegative(),cost:z.number().finite().nonnegative(),state:z.enum(['reserved','uncertain','complete']),at:z.iso.datetime({offset:true})})).parse(b.tables.usage);
    for(const table of ['records','revisions','memories','messages','usage']) {const rows=b.tables[table];if(!Array.isArray(rows))throw new Error('备份缺少必要的数据表');const keys=rows.map(r=>table==='revisions'?(r as {seq:number}).seq:(r as {id:string}).id);if(new Set(keys).size!==keys.length)throw new Error('备份包含重复编号');}
    const staged=b.files.map(f=>{ if(!/^(attachments\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.(jpeg|png|webp|gif)|raw\/[a-zA-Z0-9_-]+\.json)$/.test(f.path)) throw new Error('备份包含无效文件路径'); const data=Buffer.from(f.base64,'base64'); if(sha256(data)!==f.sha256) throw new Error('备份文件校验失败'); return {file:safePath(this.root,f.path),data,relative:f.path}; });
    const files=new Map(staged.map(s=>[s.relative,s]));
    const rows=b.tables.records as {id:string;doc:string;fingerprint:string}[];
    if(!Array.isArray(rows)||rows.length>100000) throw new Error('备份记录无效');
    for(const row of rows) { const r=parseJSON<HealthRecord>(row.doc); if(r.id!==row.id||!Number.isInteger(r.revision)||r.revision<1) throw new Error('备份记录不一致'); envelopeSchema.parse({version:1,...r,body:r.body??undefined,attachments:[]}); if(r.analysis) analysisSchema.parse(r.analysis); for(const a of r.attachments) {const f=files.get(a.file);if(!f||sha256(f.data)!==a.sha256) throw new Error('备份缺少附件');sniffImage(f.data);} }
    for(const row of b.tables.memories as {id:string;doc:string}[]) { const m=parseJSON<Memory>(row.doc); idSchema.parse(m.id); memoryInputSchema.parse(m); }
    for(const row of b.tables.messages as {id:string;doc:string}[]) { const m=parseJSON<Message>(row.doc); idSchema.parse(m.id); if(!['user','assistant'].includes(m.role)||!Array.isArray(m.sources)||typeof m.text!=='string') throw new Error('备份对话损坏'); }
    const safety=path.join(this.root,'backups',`before-restore-${Date.now()}.bodyjournal`); this.backup(safety);
    for(const s of staged) atomicWrite(s.file,s.data);
    this.transaction(()=>{
      for(const name of ['records','revisions','memories','messages']) this.db.exec(`DELETE FROM ${name}`);
      for(const row of rows) this.db.prepare('INSERT INTO records VALUES(?,?,?)').run(row.id,row.doc,row.fingerprint);
      for(const row of revisionRows) this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(row.seq,row.entity,row.id,row.doc,row.at);
      for(const name of ['memories','messages']) for(const row of b.tables[name] as {id:string;doc:string}[]) this.db.prepare(`INSERT INTO ${name} VALUES(?,?)`).run(row.id,row.doc);
      for(const r of usageRows) this.db.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?,?,?,?)').run(r.id,r.month,r.provider,r.input,r.output,r.cost,r.state,r.at);
      this.energy.restore(energyData);this.energy.mirroring=true;try{this.setSettings(settings);}finally{this.energy.mirroring=false;}
      if(b.version===1&&settings.goals.kcal!==null)this.energy.importManualTarget(settings.goals.kcal,settings.goals.protein);
      this.energy.syncTarget();this.energy.invalidate();if(profile)this.saveCoachProfile(profile);if(aliases)this.setConfig('exerciseAliases',aliases);
      this.setConfig('energyParsingV1',false);
      this.setConfig('conversationStart','');
    });this.migrateEnergyParsing(); return safety;
  }
  exportReadable(dir:string) {
    atomicWrite(path.join(dir,'能量资料与目标.json'),JSON.stringify(this.energy.export(),null,2));
    mkdirSync(dir,{recursive:true,mode:0o700});
    const records=this.records(true);atomicWrite(path.join(dir,'个人执行规则.json'),JSON.stringify(this.coachProfile(),null,2));atomicWrite(path.join(dir,'个人执行规则.md'),this.coachProfile().originalText);atomicWrite(path.join(dir,'动作别名.json'),JSON.stringify(this.exerciseAliases(),null,2)); atomicWrite(path.join(dir,'records.json'),JSON.stringify(records,null,2)); atomicWrite(path.join(dir,'memories.json'),JSON.stringify(this.memories(),null,2)); atomicWrite(path.join(dir,'conversations.json'),JSON.stringify(this.messages(),null,2)); atomicWrite(path.join(dir,'goals.json'),JSON.stringify(this.getSettings().goals,null,2));
    atomicWrite(path.join(dir,'我的档案.md'),`# 身体手记\n\n导出时间：${iso()}\n\n## 当前目标\n\n${this.getSettings().goals.goal}\n\n## 记忆\n\n${this.memories().map(m=>`- [${m.kind}] ${m.text}${m.expiresAt?`（至 ${m.expiresAt}）`:''}${m.stale?'（依据已修改）':''}`).join('\n')}\n\n## 记录\n\n${records.map(r=>`### ${r.occurredAt} / ${r.kind}${r.deleted?'（已删除）':''}\n\n编号：${r.id}；修订：${r.revision}${r.timeSource?'；时间待确认（暂用文件保存时间）':''}\n\n${r.text}\n\n${r.analysis?.summary??''}\n\n${r.attachments.map(a=>`![${a.name}](${a.file})`).join('\n')}`).join('\n\n')}`);
    for(const r of records) { for(const a of r.attachments) {const dest=safePath(dir,a.file);mkdirSync(path.dirname(dest),{recursive:true});copyFileSync(safePath(this.root,a.file),dest);} const raw=`raw/${r.id}.json`;if(existsSync(safePath(this.root,raw))){const dest=safePath(dir,raw);mkdirSync(path.dirname(dest),{recursive:true});copyFileSync(safePath(this.root,raw),dest);} }
  }
}
