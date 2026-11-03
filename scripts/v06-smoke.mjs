import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {tsImport} from 'tsx/esm/api';

const {HealthStore}=await tsImport('../electron/core/store.ts',import.meta.url);
const {FoodCatalog}=await tsImport('../electron/core/nutrition.ts',import.meta.url);
const base=mkdtempSync(path.join(tmpdir(),'bodyjournal-v06-ui-'));
const vault=path.join(base,'vault'),archive=path.join(base,'synthetic.bodyjournal'),errors=[];
let app;
async function launch(){
  app=await _electron.launch({executablePath:process.env.BODYJOURNAL_APP??electron,args:process.env.BODYJOURNAL_APP?[]:[process.cwd()],env:{...process.env,HEALTH_TEST_VAULT:vault,HEALTH_DEMO:'0'},timeout:30000});
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('navigation',{name:'主导航'}).waitFor();return page;
}
try{
  mkdirSync(path.join(base,'inbox'));
  const store=new HealthStore(vault,new FoodCatalog([]),path.join(base,'inbox'),false);
  store.setSettings({...store.getSettings(),provider:'deepseek',deepseekBudget:100});
  const record=store.importEnvelope({version:1,id:'synthetic-v06-training',kind:'training',text:'肩：\n哑铃肩推 12kg 3x10',dateLocked:true,occurredAt:'2026-06-10T18:00:00+08:00',timezone:'Asia/Shanghai'}).record;
  store.saveExerciseRules({archived:['哑铃飞鸟'],overrides:{}});store.close();
  let page=await launch();
  await app.evaluate(({net,safeStorage,dialog},archive)=>{
    if(!process.env.HEALTH_TEST_VAULT)throw new Error('Requires isolated synthetic vault');
    safeStorage.isAsyncEncryptionAvailable=async()=>true;
    safeStorage.encryptStringAsync=async value=>Buffer.from(value);
    safeStorage.decryptStringAsync=async value=>({result:value.toString(),shouldReEncrypt:false});
    globalThis.v06Calls=[];
    net.fetch=async(_url,init)=>{
      const body=JSON.parse(String(init.body)),payload=JSON.parse(body.messages[1].content[0].text);
      globalThis.v06Calls.push(payload);
      const q=payload.question;
      const correction=q.includes('45');
      const save=q.includes('60')||correction;
      const output={answerMarkdown:save?'已保存训练时长约定。':q.includes('6月10')?'当天已入档肩推为3组，每组10次。[记录:synthetic-v06-training]':'按当前45分钟约定安排。',memoryChanges:save?[{operation:'upsert',key:'training.duration',kind:'fact',text:correction?'每次训练最多45分钟':'每次训练最多60分钟',evidenceQuote:q}]:[]};
      return new Response([{choices:[{delta:{content:JSON.stringify(output)}}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n');
    };
    dialog.showSaveDialog=async()=>({canceled:false,filePath:archive});
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[archive]});
    dialog.showMessageBox=async()=>({response:1});
  },archive);
  await page.evaluate(()=>window.health.invoke('deepseek:save',{key:'synthetic-key-never-sent'}));
  const input=page.getByLabel('向健康助理提问');
  for(const q of ['以后每次训练最多60分钟','更正，以后每次训练最多45分钟']){
    await input.fill(q);await page.getByRole('button',{name:'发送问题',exact:true}).click();
    await expect.poll(async()=>page.evaluate(async()=>{const s=await window.health.invoke('snapshot');return s.messages.at(-1)?.status;})).toBe('complete');
  }
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'我的档案',exact:true}).click();await expect(page.locator('.profile-page')).toContainText('每次训练最多45分钟');await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'助理',exact:true}).click();
  await page.getByRole('button',{name:'新对话',exact:true}).click();
  await expect(page.locator('.message')).toHaveCount(0);
  await input.fill('今天肩怎么练？');await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.locator('.message.assistant').last()).toContainText('当前45分钟');
  const request=await app.evaluate(()=>globalThis.v06Calls.at(-1));
  if(JSON.stringify(request).includes('60分钟'))throw new Error('Corrected source returned to a new conversation');
  await input.fill('6月10日肩推做了几组？');await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.locator('.message.assistant').last()).toContainText('3组');
  await page.locator('.message.assistant').last().getByText('本次参考与引用',{exact:true}).click();
  await expect(page.locator('.message.assistant').last()).toContainText('2026-06-10');
  await page.evaluate(()=>window.health.invoke('backup:save'));
  // A post-backup mutation must disappear on restore, while the original remains.
  await page.evaluate(()=>window.health.invoke('record:create',{kind:'note',text:'合成恢复后应不存在',occurredAt:new Date().toISOString(),attachmentTokens:[]}));
  await page.evaluate(()=>window.health.invoke('backup:restore'));
  let snapshot=await page.evaluate(()=>window.health.invoke('snapshot'));
  if(snapshot.records.some(r=>r.text==='合成恢复后应不存在')||!snapshot.records.some(r=>r.id===record.id))throw new Error('Restore did not replace the record dataset');
  await app.close();app=undefined;
  page=await launch();snapshot=await page.evaluate(()=>window.health.invoke('snapshot'));
  if(snapshot.version!=='0.6.1'||snapshot.exerciseRules.archived[0]!=='哑铃飞鸟')throw new Error('Version or portable rules were lost on restart');
  if(snapshot.memories.filter(m=>m.active&&m.topicKey==='training.duration')[0].text!=='每次训练最多45分钟')throw new Error('Memory correction lost on restore');
  await page.locator('.message.assistant').last().getByText('本次参考与引用',{exact:true}).click();
  await page.setViewportSize({width:860,height:650});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Receipt overflows narrow window');
  await page.screenshot({path:path.join(tmpdir(),'bodyjournal-v06-verified.png')});
  if(errors.length)throw new Error(errors.join('\n'));
  const report={version:snapshot.version,synthetic:true,network:'mock transport only',passed:['record','correction','new conversation','historical lookup','receipt','native backup restore','restart','portable rules','narrow layout']};
  if(process.env.BODYJOURNAL_VERIFY_REPORT)writeFileSync(process.env.BODYJOURNAL_VERIFY_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(tmpdir(),'bodyjournal-v06-failure.png')}).catch(()=>{});}throw error;}
finally{if(app)await app.close().catch(()=>{});rmSync(base,{recursive:true,force:true});}
