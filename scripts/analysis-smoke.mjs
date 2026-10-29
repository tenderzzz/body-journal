import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {tsImport} from 'tsx/esm/api';
const {HealthStore}=await tsImport('../electron/core/store.ts',import.meta.url);
const {FoodCatalog}=await tsImport('../electron/core/nutrition.ts',import.meta.url);
const vault=mkdtempSync(path.join(tmpdir(),'bodyjournal-analysis-ui-')),errors=[];
const mealFixture={name:'合成测试米饭',foodId:null,grams:{low:100,high:120},assumption:'仅用于合成流程验证',nutrition:{source:'estimate',basis:'合成流程数据',per100g:{kcal:{low:110,high:130},protein:{low:2,high:3},carbs:{low:24,high:28},fat:{low:0.2,high:0.5}}}};
let app;
try{
 const store=new HealthStore(vault,new FoodCatalog([]),path.join(vault,'inbox'),false),now=new Date().toISOString();
 store.setSettings({...store.getSettings(),provider:'deepseek',deepseekBudget:100});
 for(let i=0;i<13;i++)store.importEnvelope({version:1,id:`synthetic-batch-${String(i).padStart(2,'0')}`,kind:'note',occurredAt:now,text:`合成队列记录 ${i}`,timezone:'Asia/Shanghai'});
 const training=store.importEnvelope({version:1,id:'synthetic-followup-training',kind:'training',occurredAt:now,text:'合成训练：卧推 20kg 3x8',timezone:'Asia/Shanghai'}).record;
 store.applyAnalysis(training.id,{summary:'合成待确认训练',questions:['这次训练完成了吗？'],training:{part:'chest',completion:'unknown'},sets:[]},'deepseek',training.revision);
 store.close();
 app=await _electron.launch({executablePath:process.env.BODYJOURNAL_APP??electron,args:process.env.BODYJOURNAL_APP?[]:[process.cwd()],env:{...process.env,HEALTH_TEST_VAULT:vault,HEALTH_DEMO:'0'},timeout:30000});
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('navigation',{name:'主导航'}).waitFor();
 // Intercept transport and secret protection only in this disposable process.
 // The renderer, preload, IPC handler, service, database and restart stay real.
 await app.evaluate(({net,safeStorage},meal)=>{
  if(!process.env.HEALTH_TEST_VAULT)throw new Error('Synthetic transport requires an isolated vault');
  safeStorage.isAsyncEncryptionAvailable=async()=>true;
  safeStorage.encryptStringAsync=async value=>Buffer.from(value);
  safeStorage.decryptStringAsync=async value=>({result:value.toString(),shouldReEncrypt:false});
  globalThis.syntheticAnalysis={calls:[],failOne:true,failTraining:true,failMeal:false,slow:false};
  net.fetch=async(_url,init)=>{
   const state=globalThis.syntheticAnalysis,payload=JSON.parse(JSON.parse(String(init.body)).messages[1].content[0].text),r=payload.record;
   state.calls.push(r.id);
   await new Promise(resolve=>setTimeout(resolve,state.slow?700:55));
   init.signal?.throwIfAborted();
   if(r.id==='synthetic-followup-training'&&state.failTraining){state.failTraining=false;throw new TypeError('fetch failed');}
   if(r.kind==='meal'&&state.failMeal){state.failMeal=false;throw new TypeError('fetch failed');}
   const invalid=r.id==='synthetic-batch-06'&&state.failOne;
   if(invalid)state.failOne=false;
   const output=invalid?{questions:[]}:{summary:`合成分析完成：${r.id}`,questions:[],assumptions:[],...(r.kind==='training'?{training:{part:'chest',completion:'completed'},sets:[]}: {}),...(r.kind==='meal'?{ingredients:[meal]}:{})};
   return new Response([
    {choices:[{delta:{content:JSON.stringify(output)}}]},
    {choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}}
   ].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n');
  };
 },mealFixture);
 await page.evaluate(()=>window.health.invoke('deepseek:save',{key:'synthetic-ui-key-never-sent'}));
 await page.getByRole('button',{name:'分析 13 条新记录',exact:true}).click();
 await expect(page.getByRole('status',{name:'批量分析进度'})).toBeVisible();
 // section's accessible role depends on aria-label; use its label for consistency.
 const batch=page.locator('[aria-label="本次分析结果"]');
 await expect(batch).toContainText('已完成 12 条，失败 1 条');
 await expect(batch).toContainText('summary');
 await batch.getByRole('button',{name:'继续分析未完成记录',exact:true}).click();
 await expect(batch).toContainText('共 1 条，已完成 1 条');
 if((await app.evaluate(()=>globalThis.syntheticAnalysis.calls.length))!==14)throw new Error('Successful batch records were analyzed twice');
 await page.getByRole('button',{name:'回答待补充问题',exact:true}).click();
 let modal=page.getByRole('dialog');
 await modal.getByLabel('回答待补充问题',{exact:true}).fill('已完成，今天训练40分钟。');
 await modal.getByRole('button',{name:'保存并重新分析',exact:true}).click();
 await expect(modal.locator('[aria-label="记录分析状态"]')).toContainText('补充已经保存，无需再次输入');
 await expect(modal.getByRole('alert')).toContainText('网络');
 await expect(modal.locator('.original-text')).toContainText('已完成，今天训练40分钟。');
 if(await modal.getByLabel('回答待补充问题',{exact:true}).count())await expect(modal.getByLabel('回答待补充问题',{exact:true})).toHaveValue('');
 await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:/^记录/}).click();
 await page.locator('.record-row').filter({hasText:'合成训练：卧推 20kg 3x8'}).click();
 modal=page.getByRole('dialog');
 await expect(modal.locator('[aria-label="记录分析状态"]')).toContainText('网络');
 await modal.getByRole('button',{name:'重试分析',exact:true}).click();
 await expect(modal.locator('[aria-label="记录分析状态"]')).toContainText('分析已完成，整理结果已更新');
 const saved=await page.evaluate(async()=>{const s=await window.health.invoke('snapshot');return s.records.find(r=>r.id==='synthetic-followup-training');});
 if(saved.followups.length!==1||saved.text.split('已完成，今天训练40分钟。').length!==2||saved.analysisPending!==false)throw new Error('Retry duplicated or lost the saved followup');
 await modal.getByRole('button',{name:'关闭',exact:true}).click();
 const meal=await page.evaluate(async ingredient=>{
  const record=await window.health.invoke('record:create',{kind:'meal',occurredAt:new Date().toISOString(),text:'合成餐食补充回归',attachmentTokens:[]});
  return window.health.invoke('record:analyze',{ids:[record.id],revision:record.revision,manualMeal:false,analysis:{summary:'合成餐食的上次估算',questions:['这份饭吃完了吗？'],assumptions:['仅用于合成流程验证'],ingredients:[ingredient]}});
 },mealFixture);
 await app.evaluate(()=>{globalThis.syntheticAnalysis.failMeal=true;});
 await page.getByRole('navigation').getByRole('button',{name:/^记录/}).click();
 await page.locator('.record-row').filter({hasText:'合成餐食补充回归'}).click();
 modal=page.getByRole('dialog');
 await modal.getByLabel('回答待补充问题',{exact:true}).fill('这份饭全部吃完了。');
 await modal.getByRole('button',{name:'保存并重新分析',exact:true}).click();
 const baseline=modal.locator('[aria-label="上次食材估算"]');
 await expect(modal.getByRole('alert')).toContainText('网络');
 await expect(baseline).toContainText('上次食材估算（补充前）');
 await expect(baseline).toContainText('不代表最新分析结果');
 await expect(baseline).toContainText('合成餐食的上次估算');
 await expect(baseline).toContainText('合成测试米饭');
 await expect(baseline.locator('.macro-grid')).toContainText('能量');
 const failedMeal=await page.evaluate(async id=>(await window.health.invoke('snapshot')).records.find(r=>r.id===id),meal.id);
 if(failedMeal.analysis!==null||failedMeal.followups.at(-1).previousAnalysis.ingredients.length!==1)throw new Error('Meal followup lost baseline or counted it as current analysis');
 await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('.record-row').filter({hasText:'合成餐食补充回归'}).click();
 modal=page.getByRole('dialog');
 await expect(modal.locator('[aria-label="上次食材估算"]')).toContainText('合成测试米饭');
 await modal.getByRole('button',{name:'重试分析',exact:true}).click();
 await expect(modal.locator('[aria-label="记录分析状态"]')).toContainText('分析已完成，整理结果已更新');
 await expect(modal.locator('[aria-label="上次食材估算"]')).toHaveCount(0);
 await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('navigation').getByRole('button',{name:'助理',exact:true}).click();
 await app.evaluate(()=>{globalThis.syntheticAnalysis.slow=true;});
 await page.evaluate(async()=>{for(let i=0;i<3;i++)await window.health.invoke('record:create',{kind:'note',occurredAt:new Date().toISOString(),text:`合成取消记录 ${i}`,attachmentTokens:[]});});
 await page.getByRole('button',{name:'分析 3 条新记录',exact:true}).click();
 await page.getByRole('button',{name:'取消剩余分析',exact:true}).click();
 await expect(batch).toContainText('分析已取消');
 await expect(batch).toContainText('尚有 3 条未处理');
 await page.setViewportSize({width:860,height:650});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Analysis UI overflows narrow window');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Isolated analysis UI passed: 13-item queue, per-item failure and retry, saved followup after network failure, prior meal estimate preserved and labelled, one-shot retry without duplication, cancellation and narrow layout. No model requests sent.');
}catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(tmpdir(),'bodyjournal-analysis-failure.png')}).catch(()=>{});console.error('Analysis UI failure:',errors,await page.locator('[role="dialog"]').allTextContents());}throw error;}
finally{if(app)await app.close().catch(()=>{});rmSync(vault,{recursive:true,force:true});}
