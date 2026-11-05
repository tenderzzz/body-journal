import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {tsImport} from 'tsx/esm/api';

const {HealthStore}=await tsImport('../electron/core/store.ts',import.meta.url);
const {FoodCatalog}=await tsImport('../electron/core/nutrition.ts',import.meta.url);
const base=mkdtempSync(path.join(tmpdir(),'bodyjournal-v061-ui-')),vault=path.join(base,'vault'),inbox=path.join(base,'inbox');
const archive=path.join(base,'synthetic.bodyjournal'),errors=[];
let app;
async function launch(){
  app=await _electron.launch({executablePath:process.env.BODYJOURNAL_APP??electron,args:process.env.BODYJOURNAL_APP?[]:[process.cwd()],env:{...process.env,HEALTH_TEST_VAULT:vault,HEALTH_DEMO:'0'},timeout:30000});
  const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('navigation',{name:'主导航'}).waitFor();console.log('isolated window ready');return page;
}
try{
  mkdirSync(inbox);
  const store=new HealthStore(vault,new FoodCatalog([]),inbox,false);
  store.setSettings({...store.getSettings(),provider:'deepseek',deepseekBudget:100});
  for(let i=0;i<105;i++)store.importEnvelope({version:1,id:'synthetic-history-'+i,kind:'note',text:'UI 合成历史 '+i,occurredAt:'2026-10-01T12:00:00+08:00',timezone:'Asia/Shanghai',dateLocked:true});
  store.importEnvelope({version:1,id:'synthetic-night-food',kind:'meal',text:'UI 合成夜宵',occurredAt:'2026-11-03T01:20:00+08:00',timezone:'Asia/Shanghai',dateLocked:true});
  store.close();
  let page=await launch();
  await app.evaluate(({net,safeStorage,dialog},archive)=>{
    if(!process.env.HEALTH_TEST_VAULT)throw new Error('Requires isolated synthetic vault');
    const NativeDate=Date,fixed=NativeDate.parse('2026-11-03T01:30:00+08:00');
    globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
    safeStorage.isAsyncEncryptionAvailable=async()=>true;
    safeStorage.encryptStringAsync=async value=>Buffer.from(value);
    safeStorage.decryptStringAsync=async value=>({result:value.toString(),shouldReEncrypt:false});
    globalThis.v061Calls=[];
    net.fetch=async(_url,init)=>{
      const payload=JSON.parse(JSON.parse(String(init.body)).messages[1].content[0].text);globalThis.v061Calls.push(payload);
      const answer={answerMarkdown:`摄入按${payload.context.query.period.from}手记核对，步数按${payload.context.stepPeriod.from}自然日核对。[记录:synthetic-night-food]`,memoryChanges:[]};
      return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(answer)}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}})}\n\ndata: [DONE]\n\n`);
    };
    dialog.showSaveDialog=async()=>({canceled:false,filePath:archive});
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[archive]});
    dialog.showMessageBox=async()=>({response:1});
  },archive);
  await page.clock.setFixedTime(new Date('2026-11-03T01:30:00+08:00'));
  await page.evaluate(()=>window.health.invoke('deepseek:save',{key:'synthetic-key-never-sent'}));
  const overview=await page.evaluate(()=>window.health.invoke('overview'));
  if(overview.records.length>12||overview.messages.length||overview.memories.length)throw new Error('Overview fetched the full archive');
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/^记录/}).click();
  await expect(page.locator('.record-row')).toHaveCount(50);
  await page.getByRole('button',{name:'加载更多记录',exact:true}).click();await expect(page.locator('.record-row')).toHaveCount(100);console.log('pagination passed');
  await page.getByLabel('搜索记录').fill('UI 合成夜宵');await expect(page.locator('.record-row')).toHaveCount(1);
  await page.locator('.record-row').click();await expect(page.getByRole('dialog')).toContainText('归入 2026-11-02');
  await page.evaluate(async()=>{const r=await window.health.invoke('record:get',{id:'synthetic-night-food'});await window.health.invoke('record:update',{id:r.id,revision:r.revision,text:'UI 合成夜宵（已更正）'});});
  await expect(page.getByRole('dialog')).toContainText('UI 合成夜宵（已更正）');console.log('night detail correction passed');
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'能量',exact:true}).click();
  await expect(page.getByLabel('能量日期')).toHaveValue('2026-11-02');
  await page.getByRole('button',{name:'能量下一天',exact:true}).click();await expect(page.getByLabel('能量日期')).toHaveValue('2026-11-03');
  await page.getByLabel('手动补充步数',{exact:true}).fill('4321');
  await page.getByLabel('步数覆盖时间').selectOption('partial');
  await page.getByRole('button',{name:'保存当天补充',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'部分步数已保存'})).toBeVisible();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'趋势',exact:true}).click();await expect(page.getByRole('heading',{name:'看见变化'})).toBeVisible();await page.getByRole('button',{name:'饮食摄入',exact:true}).click();await expect(page.getByText('2026-11-02 · 当日合计',{exact:true})).toBeVisible();
  console.log('civil steps entry passed');await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'助理',exact:true}).click();
  await page.getByRole('button',{name:'新对话',exact:true}).click();
  await page.getByLabel('向健康助理提问').fill('今天吃了多少、走了多少步？');await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.locator('.message.assistant').last()).toContainText('2026-11-02');
  await expect(page.locator('.message.assistant').last()).toContainText('2026-11-03');
  if(await app.evaluate(()=>globalThis.v061Calls.length)!==1)throw new Error('Unexpected model call count');
  await page.locator('.message.assistant').last().getByText('本次参考与引用',{exact:true}).click();
  await expect(page.locator('.message.assistant').last()).toContainText('手记04:00、步数00:00');
  console.log('dual-date request passed');
  // The file watcher must recover an incomplete download without a manual sync.
  const capture=path.join(inbox,'synthetic-phone.json');writeFileSync(capture,'{"version":');
  await expect.poll(()=>page.evaluate(async()=>(await window.health.invoke('overview')).sync.pending)).toBe(1);
  writeFileSync(capture,JSON.stringify({version:1,id:'synthetic-phone',kind:'note',text:'UI 合成手机记录',occurredAt:'2026-11-03T01:25:00+08:00',timezone:'Asia/Shanghai'}));
  await expect.poll(()=>page.evaluate(async()=>{try{return (await window.health.invoke('record:get',{id:'synthetic-phone'})).source;}catch{return '';}})).toBe('iPhone / iCloud');
  console.log('watcher passed');await page.evaluate(()=>window.health.invoke('backup:save'));
  await page.evaluate(()=>window.health.invoke('record:create',{kind:'note',text:'UI 恢复后移除',occurredAt:'2026-11-03T01:30:00+08:00',attachmentTokens:[]}));
  await page.evaluate(()=>window.health.invoke('backup:restore'));
  await app.close();app=undefined;page=await launch();
  const restored=await page.evaluate(()=>window.health.invoke('records:list',{search:'UI 恢复后移除'}));if(restored.items.length)throw new Error('Restore kept a post-backup record');
  const energy=await page.evaluate(()=>window.health.invoke('energy:get',{date:'2026-11-03'}));if(energy.dayInput.steps!==4321)throw new Error('Civil day steps were lost on restore');
  if(errors.length)throw new Error(errors.join('\n'));
  const report={version:'0.6.2',synthetic:true,network:'mock transport only',passed:['bounded overview','record pagination','unloaded source','night correction','04:00 journal','00:00 steps','new conversation','dual-date receipt','watcher partial download','backup restore','restart']};
  if(process.env.BODYJOURNAL_VERIFY_REPORT)writeFileSync(process.env.BODYJOURNAL_VERIFY_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(tmpdir(),'bodyjournal-v061-failure.png')}).catch(()=>{});}throw error;}
finally{if(app)await app.close().catch(()=>{});rmSync(base,{recursive:true,force:true});}
