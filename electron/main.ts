import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, statSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HealthStore, atomicWrite, sniffImage } from './core/store';
import { FoodCatalog } from './core/nutrition';
import { splitHistorical } from './core/parser';
import { needsAnalysis } from '../src/shared/stats';
import { envelopeSchema, idSchema, readableError, memoryInputSchema } from './core/validation';
import { ChatGPTAuth, type SecretStorage } from './ai/auth';
import { AssistantService } from './ai/service';
import {evaluateDataset,EVALUATION_EXAMPLE} from '../src/shared/evaluation';
import type { Envelope, Food, HealthRecord, Snapshot } from '../src/shared/types';

app.setName('身体手记');
const demo=process.argv.includes('--demo')||process.env.HEALTH_DEMO==='1';
if(process.env.HEALTH_TEST_VAULT) app.setPath('userData',path.join(process.env.HEALTH_TEST_VAULT,'app-profile'));
else if(demo) app.setPath('userData',path.join(app.getPath('temp'),'bodyjournal-demo-app'));
else app.setPath('userData',path.join(app.getPath('appData'),'BodyJournal'));
const root=process.env.HEALTH_TEST_VAULT??(demo?path.join(app.getPath('temp'),'bodyjournal-demo-vault'):path.join(app.getPath('userData'),'vault'));
const resource=(p:string)=>path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),p);
let win:BrowserWindow;let store:HealthStore;let auth:ChatGPTAuth;let assistant:AssistantService;let secrets:SecretStorage;let timer:NodeJS.Timeout;let securityError='';
const attachments=new Map<string,{name:string;mime:string;base64:string}>();
function emit(event:Record<string,unknown>){if(win&&!win.isDestroyed())win.webContents.send('health:event',event);}
async function snapshot():Promise<Snapshot&{demo:boolean}> {store.energy.syncTarget();store.energy.invalidate();store.invalidateMemoryAnswers();const secretState=await secrets.read().catch(()=>({} as Record<string,unknown>));return {records:store.records(true),memories:store.memories(),messages:store.messages(),settings:store.getSettings(),connection:{...auth.status(),hasDeepSeek:!!secretState.deepseekKey,error:securityError||auth.status().error},sync:store.syncState,usage:store.usage(),vault:root,version:app.getVersion(),demo,coachProfile:store.coachProfile(),exerciseAliases:store.exerciseAliases(),exerciseRules:store.exerciseRules(),foodCandidates:store.foodCandidates(),conversationStart:store.getConfig<string>('conversationStart')};}
function assertAvailable(){if(assistant.isBusy())throw new Error('分析进行中，请完成或取消后再进行此操作。');}
async function chooseImages(){const picked=await dialog.showOpenDialog(win,{title:'选择餐食照片或训练截图',properties:['openFile','multiSelections'],filters:[{name:'图片',extensions:['jpg','jpeg','png','webp','gif']}]});if(picked.canceled)return [];const result=[];for(const file of picked.filePaths.slice(0,8)){if(statSync(file).size>20*1024*1024)throw new Error('单张图片不能超过 20 MB');const data=readFileSync(file);const mime=sniffImage(data);const token=randomUUID();attachments.set(token,{name:path.basename(file),mime,base64:data.toString('base64')});result.push({token,name:path.basename(file),preview:`data:${mime};base64,${data.toString('base64')}`});}return result;}
async function invoke(action:string,payload:any) {
  switch(action){
    case 'snapshot':return snapshot();
    case 'energy:get':return store.energy.view(payload??{});
    case 'energy:sourceOpen':{const source=z.enum(['resting','met','protein']).parse(payload.source);return shell.openExternal({resting:'https://pubmed.ncbi.nlm.nih.gov/2305711/',met:'https://pacompendium.com/adult-compendium/',protein:'https://pmc.ncbi.nlm.nih.gov/articles/PMC5477153/'}[source]);}
    case 'energy:profileSave':{const result=store.energy.saveProfile(payload);emit({type:'changed'});return result;}
    case 'energy:daySave':{const result=store.energy.saveDay(payload);emit({type:'changed'});return result;}
    case 'energy:targetSave':{assertAvailable();const result=store.energy.saveTarget(payload);emit({type:'changed'});return result;}
    case 'energy:goalApply':{assertAvailable();const result=store.energy.applyProposal(idSchema.parse(payload.id));emit({type:'changed'});return result;}
    case 'energy:goalUndo':{assertAvailable();store.energy.undoTarget(idSchema.parse(payload.id));emit({type:'changed'});return;}
    case 'attachment:choose':return chooseImages();
    case 'attachment:get':return store.attachmentData(idSchema.parse(payload.id),z.number().int().min(0).max(7).parse(payload.index));
    case 'record:create':{const input=z.object({kind:z.enum(['meal','training','body','note']),text:z.string().max(100000),occurredAt:z.string(),dateLocked:z.boolean().optional(),body:z.any().optional(),attachmentTokens:z.array(z.string()).max(8).default([])}).parse(payload);const images=input.attachmentTokens.map(t=>{const a=attachments.get(t);if(!a)throw new Error('图片选择已过期，请重新选择');return a;});const e={version:1,id:randomUUID(),kind:input.kind,text:input.text,occurredAt:input.occurredAt,dateLocked:input.dateLocked,timezone:store.getSettings().timezone,body:input.body,attachments:images};const r=store.importEnvelope(e).record;for(const t of input.attachmentTokens)attachments.delete(t);emit({type:'changed'});return r;}
    case 'record:update':{const id=idSchema.parse(payload.id);const r=store.revise(id,{text:payload.text,occurredAt:payload.occurredAt,body:payload.body,deleted:payload.deleted},z.number().int().parse(payload.revision));emit({type:'changed'});return r;}
    case 'record:activityUpdate':{const r=store.updateActivity(payload);emit({type:'changed'});return r;}
    case 'record:undo':{const r=store.undoRecord(idSchema.parse(payload.id));emit({type:'changed'});return r;}
    case 'record:history':return store.history(idSchema.parse(payload.id));
    case 'record:analyze':{const ids=z.array(idSchema).min(1).max(30).parse(payload.ids);if(payload.analysis){if(ids.length!==1)throw new Error('请逐条修正分析');const r=store.applyAnalysis(ids[0],payload.analysis,'local',z.number().int().parse(payload.revision),z.boolean().optional().parse(payload.manualMeal)??false);emit({type:'changed'});return r;}return assistant.analyze(ids);}
    case 'record:analyzePending':return assistant.analyze(store.records().filter(needsAnalysis).slice(0,10).map(r=>r.id));
    case 'record:importHistory':{const text=z.string().max(500000).parse(payload.text);const parsed=splitHistorical(text);if(payload.preview)return parsed;const result=store.importMany(parsed.map(p=>({version:1,id:randomUUID(),kind:'training',...p})));emit({type:'changed'});return result;}
    case 'record:importFiles':{const selected=await dialog.showOpenDialog(win,{properties:['openFile','multiSelections'],filters:[{name:'手机记录',extensions:['json']}]});if(selected.canceled)return 0;let count=0;for(const f of selected.filePaths){if(statSync(f).size>40*1024*1024)throw new Error('记录文件过大');if(!store.importEnvelope(JSON.parse(readFileSync(f,'utf8')),path.dirname(f),'文件导入').duplicate)count++;}emit({type:'changed'});return count;}
    case 'sync':{const r=store.scanInbox();emit({type:'changed'});return r;}
    case 'memory:history':return store.memoryHistory(idSchema.parse(payload.id));
    case 'memory:save':{const m=store.saveMemory(payload.memory,payload.id? idSchema.parse(payload.id):undefined);emit({type:'changed'});return m;}
    case 'coach:save':{assertAvailable();const p=store.saveCoachProfile(payload);emit({type:'changed'});return p;}
    case 'exercise:reclassifyMany':{assertAvailable();const result=store.reclassifyExercises(payload.changes);emit({type:'changed'});return result;}
    case 'exercise:reclassify':{assertAvailable();const a=store.reclassifyExercise(payload.raw,payload.name);emit({type:'changed'});return a;}
    case 'memory:tidy':{const r=store.tidyMemories();emit({type:'changed'});return r;}
    case 'food:candidateIgnore':{const r=store.ignoreFoodCandidate(payload.name);emit({type:'changed'});return r;}
    case 'exercise:rules':{assertAvailable();const r=store.saveExerciseRules(payload);emit({type:'changed'});return r;}
    case 'exercise:deleteAlias':{assertAvailable();const r=store.deleteExerciseAlias(payload.raw);emit({type:'changed'});return r;}
    case 'record:setDeleted':{const r=store.setRecordDeleted(payload.id,payload.deleted);emit({type:'changed'});return r;}
    case 'chat:undoMemory':{store.undoChatMemory(idSchema.parse(payload.id));emit({type:'changed'});return;}
    case 'memory:undo':{const m=store.undoMemory(idSchema.parse(payload.id));emit({type:'changed'});return m;}
    case 'settings:save':{assertAvailable();const old=store.getSettings();const value={...payload,inbox:old.inbox};if(!Array.isArray(auth.status().models)||!value.chatgptModel){}else if(auth.status().models.length&&!auth.status().models.includes(value.chatgptModel))throw new Error('请选择此账号可用的模型。');const s=store.setSettings(value);emit({type:'changed'});return s;}
    case 'inbox:choose':{const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory'],title:'选择 iCloud 收件箱'});if(r.canceled)return;store.setSettings({...store.getSettings(),inbox:r.filePaths[0]});store.scanInbox();emit({type:'changed'});return r.filePaths[0];}
    case 'inbox:prepare':{const p=store.getSettings().inbox;mkdirSync(p,{recursive:true,mode:0o700});await shell.openPath(p);store.scanInbox();emit({type:'changed'});return p;}
    case 'vault:open':return shell.openPath(root);
    case 'shortcuts:open':return shell.openPath(resource('shortcuts'));
    case 'docs:open':return shell.openPath(resource('docs/使用说明.html'));
    case 'backup:save':{assertAvailable();const r=await dialog.showSaveDialog(win,{title:'保存完整备份',defaultPath:`身体手记-${new Date().toISOString().slice(0,10)}.bodyjournal`,filters:[{name:'身体手记备份',extensions:['bodyjournal']}]});if(r.canceled||!r.filePath)return;store.backup(r.filePath);return r.filePath;}
    case 'backup:restore':{assertAvailable();const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'身体手记备份',extensions:['bodyjournal']}]});if(r.canceled)return;const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['取消','恢复备份'],defaultId:0,cancelId:0,message:'用所选备份恢复档案？',detail:'当前档案会先自动备份。账号密钥不会被导入或覆盖。'});if(confirm.response!==1)return;if(statSync(r.filePaths[0]).size>512*1024*1024)throw new Error('此备份超过首版支持的 512 MB');const backup=store.restore(JSON.parse(readFileSync(r.filePaths[0],'utf8')));emit({type:'changed'});return backup;}
    case 'export':{const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory'],title:'选择导出位置'});if(r.canceled)return;const dir=path.join(r.filePaths[0],`身体手记导出-${Date.now()}`);store.exportReadable(dir);await shell.openPath(dir);return dir;}
    case 'chat:send':return assistant.chat(z.string().max(10000).parse(payload.text));
    case 'chat:cancel':assistant.cancel();return;
    case 'chat:new':{assertAvailable();store.setConfig('conversationStart',new Date().toISOString());emit({type:'new-chat'});return;}
    case 'chat:remember':{const m=store.messages().find(m=>m.id===payload.id&&m.role==='user');if(!m)throw new Error('未找到你的这句话');return {kind:'fact',text:m.text,startsAt:m.createdAt,expiresAt:null,sourceIds:[],active:true,confirmed:true};}
    case 'auth:login':{assertAvailable();const c=await auth.login();const models=c.models;if(models.length&&!models.includes(store.getSettings().chatgptModel))store.setSettings({...store.getSettings(),chatgptModel:models[0]});emit({type:'changed'});return c;}
    case 'auth:logout':assertAvailable();await auth.logout();emit({type:'changed'});return;
    case 'auth:models':{assertAvailable();const models=await auth.listModels();if(models.length&&!models.includes(store.getSettings().chatgptModel))store.setSettings({...store.getSettings(),chatgptModel:models[0]});emit({type:'changed'});return models;}
    case 'auth:usage':return shell.openExternal('https://chatgpt.com/settings/usage');
    case 'auth:test':{const icon=resource('assets/connection-test.png');const data=readFileSync(icon);return assistant.testConnection(`data:image/png;base64,${data.toString('base64')}`);}
    case 'deepseek:save':{assertAvailable();const key=z.string().trim().min(10).max(500).parse(payload.key);const all=await secrets.read();await secrets.write({...all,deepseekKey:key});emit({type:'changed'});return;}
    case 'deepseek:remove':{assertAvailable();const all=await secrets.read();delete all.deepseekKey;await secrets.write(all);emit({type:'changed'});return;}
    case 'evaluation:open':{
      const selected=await dialog.showOpenDialog(win,{title:'选择精度评测文件',properties:['openFile'],filters:[{name:'评测数据',extensions:['json']}]});
      if(selected.canceled||!selected.filePaths[0])return null;
      const file=selected.filePaths[0],info=statSync(file);
      if(!info.isFile()||info.size>10*1024*1024)throw new Error('请选择不超过10 MB的评测文件');
      return {filename:path.basename(file),report:evaluateDataset(JSON.parse(readFileSync(file,'utf8')))};
    }
    case 'evaluation:exampleSave':{
      const selected=await dialog.showSaveDialog(win,{title:'保存合成评测示例',defaultPath:'身体手记-合成评测示例.json',filters:[{name:'评测数据',extensions:['json']}]});
      if(selected.canceled||!selected.filePath)return null;
      atomicWrite(selected.filePath,JSON.stringify(EVALUATION_EXAMPLE,null,2));return path.basename(selected.filePath);
    }
    case 'food:search':return store.catalog.search(z.string().max(150).parse(payload.query));
    default:throw new Error('不支持的操作');
  }
}
async function start(){
  const data=JSON.parse(readFileSync(resource('data/foods.json'),'utf8')) as {foods:Food[]};
  const inbox=process.env.HEALTH_TEST_VAULT||demo?path.join(root,'inbox'):path.join(homedir(),'Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/BodyJournal/inbox');
  store=new HealthStore(root,new FoodCatalog(data.foods),inbox);if(process.env.HEALTH_TEST_VAULT||demo)mkdirSync(inbox,{recursive:true});
  const secretFile=path.join(app.getPath('userData'),'credentials.enc');
  secrets={async read(){if(!existsSync(secretFile))return {};if(!(await safeStorage.isAsyncEncryptionAvailable()))throw new Error('系统钥匙串暂时不可用，无法读取模型连接。');const decrypted=await safeStorage.decryptStringAsync(readFileSync(secretFile));if(decrypted.shouldReEncrypt)atomicWrite(secretFile,await safeStorage.encryptStringAsync(decrypted.result));return JSON.parse(decrypted.result);},async write(v){if(!(await safeStorage.isAsyncEncryptionAvailable()))throw new Error('系统钥匙串暂时不可用，未保存密钥。');atomicWrite(secretFile,await safeStorage.encryptStringAsync(JSON.stringify(v)));}};
  auth=new ChatGPTAuth(app.getPath('userData'),secrets,url=>shell.openExternal(url),()=>emit({type:'changed'}));await auth.init().catch(e=>{securityError=readableError(e);});assistant=new AssistantService(store,auth,secrets,emit,(url)=>{let image=nativeImage.createFromDataURL(url);if(image.isEmpty())throw new Error('这张图片暂时无法读取，请转为 JPEG 或 PNG。');const size=image.getSize();if(Math.max(size.width,size.height)>1600)image=image.resize(size.width>=size.height?{width:1600}:{height:1600});return 'data:image/jpeg;base64,'+image.toJPEG(82).toString('base64');});
  if(demo&&store.records().length===0){const {seedDemo}=await import('./demo');seedDemo(store);}
  store.migrate016();store.repairExerciseAliases();store.migrateExerciseRules();store.migrateSeatedPress();store.migrateMemoryTopics();store.migrateEnergyParsing();store.scanInbox();
  store.refreshPersonalization();
  const profileImport=path.join(app.getPath('userData'),'coach-profile-import.json');if(existsSync(profileImport)){store.saveCoachProfile(JSON.parse(readFileSync(profileImport,'utf8')));renameSync(profileImport,path.join(app.getPath('userData'),'coach-profile-imported.json'));}
  win=new BrowserWindow({width:1300,height:900,minWidth:860,minHeight:650,title:'身体手记',backgroundColor:'#f7faf9',titleBarStyle:'hiddenInset',trafficLightPosition:{x:20,y:20},show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event)=>event.preventDefault());win.webContents.session.setPermissionRequestHandler((_wc,_perm,callback)=>callback(false));
  ipcMain.handle('health:invoke',async(event,action,payload)=>{try{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('不允许的调用来源');return {ok:true,value:await invoke(String(action),payload)};}catch(e){return {ok:false,error:readableError(e)};}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'身体手记',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]}]));
  if(process.env.HEALTH_DEV==='1')await win.loadURL('http://127.0.0.1:5179');else await win.loadFile(path.join(app.getAppPath(),'dist/index.html'));
  win.show();
  let energyDay=store.energy.today();
  timer=setInterval(()=>{try{const previous=JSON.stringify({pending:store.syncState.pending,errors:store.syncState.errors});const result=store.scanInbox();const changedDay=energyDay!==store.energy.today();if(changedDay){energyDay=store.energy.today();store.energy.syncTarget();store.energy.invalidate();}if(changedDay||result.imported||previous!==JSON.stringify({pending:result.pending,errors:result.errors}))emit({type:'changed'});}catch{}},20000);
  app.on('activate',()=>{if(!win.isDestroyed())win.show();});
}
if(!app.requestSingleInstanceLock()&&!process.env.HEALTH_TEST_VAULT){app.quit();}else{
  app.on('second-instance',()=>{if(win&&!win.isDestroyed()){win.show();win.focus();}});
  app.whenReady().then(start).catch(e=>{dialog.showErrorBox('身体手记未能启动',readableError(e));app.exit(1);});
  app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>{clearInterval(timer);assistant?.cancel();store?.close();});
}
