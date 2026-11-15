import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {tsImport} from 'tsx/esm/api';
const {HealthStore}=await tsImport('../electron/core/store.ts',import.meta.url);
const {FoodCatalog}=await tsImport('../electron/core/nutrition.ts',import.meta.url);
const vault=mkdtempSync(path.join(tmpdir(),'bodyjournal-dishes-ui-')),errors=[];
const originalName='合成鸡肉面轻食（去皮）',renamed='合成常吃面餐',brand='合成餐牌';
const part=(name,group)=>({name,foodId:null,grams:{low:100,high:100},assumption:'仅用于合成流程验证',compositionGroup:group,role:'component',portionSource:'estimated',nutrition:{source:'estimate',basis:'合成每100g数据',per100g:{kcal:{low:150,high:200},protein:{low:8,high:12},carbs:{low:20,high:30},fat:{low:3,high:5}}}});
let app;const originals={};
async function launch(){app=await _electron.launch({executablePath:process.env.BODYJOURNAL_APP??electron,args:process.env.BODYJOURNAL_APP?[]:[process.cwd()],env:{...process.env,HEALTH_TEST_VAULT:vault,HEALTH_DEMO:'0'},timeout:30000});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('navigation',{name:'主导航'}).waitFor();return page;}
try{
 const store=new HealthStore(vault,new FoodCatalog([]),path.join(vault,'inbox'),false);
 for(const [id,date,names,group] of [['synthetic-dish-first','2026-10-20',['合成主菜','合成配菜'],'synthetic-group-first'],['synthetic-dish-second','2026-10-21',['合成肉类','合成主菜','合成玉米粒（熟）'],'synthetic-group-second']]){
  const r=store.importEnvelope({version:1,id,kind:'meal',text:id==='synthetic-dish-second'?'依旧是合成鸡肉面轻食（鸡肉没有皮，照常）':originalName,occurredAt:date+'T12:00:00+08:00',timezone:'Asia/Shanghai'}).record;
  originals[id]=store.applyAnalysis(id,{summary:'合成餐食已按本次分量估算',questions:[],assumptions:['不同的食材拆分不改变同款名称'],ingredients:names.map(name=>part(name,group))},'chatgpt',r.revision).analysis.macros;
 }
 // The same side in two ungrouped meals used to return as a standalone suggestion.
 for(const [id,date,text] of [['synthetic-side-first','2026-10-18','合成乙店牛肉碗'],['synthetic-side-second','2026-10-19','合成丙店鸡肉拼盘']]){
  const r=store.importEnvelope({version:1,id,kind:'meal',text,occurredAt:date+'T12:00:00+08:00',timezone:'Asia/Shanghai'}).record;
  originals[id]=store.applyAnalysis(id,{summary:'合成餐食配菜',questions:[],ingredients:[part('合成玉米粒（熟）','synthetic-side-group')]},'chatgpt',r.revision).analysis.macros;
 }
 for(const name of ['合成主菜','合成蛋白粉'])store.saveMemory({kind:'food',food:{name,servingGrams:100,perServing:{kcal:150,protein:10,carbs:20,fat:3}},text:name,startsAt:'2026-10-19T00:00:00Z',expiresAt:null,active:true,confirmed:true,sourceIds:[]});
 store.close();let page=await launch();
 const snapshot=await page.evaluate(()=>window.health.invoke('snapshot'));
 const dishes=snapshot.commonDishes.filter(d=>d.recordIds.includes('synthetic-dish-first'));
 if(dishes.length!==1||dishes[0].recordIds.length!==2)throw new Error('Same whole dish was not grouped across different ingredient decompositions');
 for(const r of snapshot.records)if(originals[r.id]&&JSON.stringify(r.analysis.macros)!==JSON.stringify(originals[r.id]))throw new Error('Grouping changed a historical calorie or macro estimate');
 await page.getByRole('navigation').getByRole('button',{name:'我的档案',exact:true}).click();
 let section=page.getByRole('region',{name:'常吃餐食',exact:true});
 await expect(section.locator('.common-dish-card')).toHaveCount(1);await expect(section).toContainText('出现 2 餐 / 2 天');await expect(section).toContainText('450–600 kcal');
 const ingredients=section.locator('[aria-label="餐食的食材信息"]'),fold=section.locator('.common-dish-details');
 await expect(fold).not.toHaveAttribute('open','');await expect(ingredients.locator('.ingredient-line')).toHaveCount(3);await expect(ingredients.locator('.ingredient-line').first()).not.toBeVisible();
 await fold.locator(':scope > summary').click();await expect(ingredients.locator('.ingredient-line').first()).toBeVisible();
 let independent=page.getByRole('region',{name:'常用食物与补剂',exact:true});await expect(independent).toContainText('合成蛋白粉');await expect(independent).not.toContainText('合成主菜');await expect(independent).not.toContainText('合成玉米粒（熟）');await expect(independent.getByRole('button',{name:'加入常用食物',exact:true})).toHaveCount(0);await expect(ingredients).toContainText('合成玉米粒（熟）');
 await section.locator('.dish-food-labels > summary').click();await expect(section.locator('.dish-food-labels')).toContainText('合成主菜');await expect(section.locator('.dish-food-labels').getByRole('button',{name:'编辑常用食物'})).toBeVisible();
 await section.getByRole('button',{name:'查看最近记录',exact:true}).click();
 let modal=page.getByRole('dialog');await expect(modal.getByRole('heading',{name:/合成鸡肉面轻食/})).toBeVisible();await expect(modal.locator('.macro-grid')).toHaveCount(1);await expect(modal.locator('.macro-grid')).toContainText('450–600');
 const detail=modal.locator('.meal-calculation-details');await expect(detail).not.toHaveAttribute('open','');await expect(detail.locator('summary')).toHaveText('食材计算明细（3项）');await expect(modal.locator('.ingredient-line').first()).not.toBeVisible();
 await detail.locator('summary').click();await expect(detail.locator('.ingredient-line')).toHaveCount(3);await expect(detail.locator('.ingredient-line').first()).toBeVisible();
 await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await section.getByRole('button',{name:'编辑常吃餐食',exact:true}).click();modal=page.getByRole('dialog');await modal.getByLabel('餐食名称',{exact:true}).fill(renamed);await modal.getByLabel('餐食品牌',{exact:true}).fill(brand);await modal.getByLabel('餐食其他称呼',{exact:true}).fill(originalName+'\n合成另一种叫法');await modal.getByRole('button',{name:'保存餐食信息',exact:true}).click();await expect(modal).toHaveCount(0);await expect(section).toContainText(renamed);await expect(section.locator('.dish-brand')).toHaveText(brand);
 await section.getByRole('button',{name:'停用常吃餐食',exact:true}).click();await expect(section.locator('.common-dish-card')).toHaveCount(0);
 await page.getByLabel('显示过期、停用和依据已变化的记忆',{exact:true}).check();await expect(section.locator('.common-dish-card')).toHaveCount(1);await section.getByRole('button',{name:'启用常吃餐食',exact:true}).click();await page.getByLabel('显示过期、停用和依据已变化的记忆',{exact:true}).uncheck();await expect(section).toContainText(renamed);
 await app.close();app=null;page=await launch();await page.getByRole('navigation').getByRole('button',{name:'我的档案',exact:true}).click();section=page.getByRole('region',{name:'常吃餐食',exact:true});await expect(section.locator('.common-dish-card')).toHaveCount(1);await expect(section).toContainText(renamed);await expect(section).toContainText('出现 2 餐 / 2 天');await expect(section.locator('.dish-brand')).toHaveText(brand);
 await section.getByRole('button',{name:'编辑常吃餐食',exact:true}).click();modal=page.getByRole('dialog');await expect(modal.getByLabel('餐食品牌',{exact:true})).toHaveValue(brand);await modal.getByLabel('餐食品牌',{exact:true}).fill('');await modal.getByRole('button',{name:'保存餐食信息',exact:true}).click();await expect(section.locator('.dish-brand')).toHaveCount(0);
 await section.getByRole('button',{name:'编辑常吃餐食',exact:true}).click();modal=page.getByRole('dialog');await modal.getByLabel('餐食品牌',{exact:true}).fill(brand);await modal.getByRole('button',{name:'保存餐食信息',exact:true}).click();await expect(section.locator('.dish-brand')).toHaveText(brand);
 const after=await page.evaluate(()=>window.health.invoke('snapshot'));for(const r of after.records)if(originals[r.id]&&JSON.stringify(r.analysis.macros)!==JSON.stringify(originals[r.id]))throw new Error('Profile edits changed historical macro totals');
 await page.setViewportSize({width:1080,height:850});
 await expect(section.locator('.common-dish-details')).not.toHaveAttribute('open','');await section.locator('.common-dish-details > summary').click();
 const headingBox=await section.locator('.common-dish-heading').boundingBox(),ingredientsBox=await section.locator('.common-dish-ingredients').boundingBox();
 if(!headingBox||!ingredientsBox||ingredientsBox.y<headingBox.y+headingBox.height-1)throw new Error('Ingredients must appear below the dish heading');
 await section.screenshot({path:path.join(tmpdir(),'bodyjournal-dishes-profile.png')});
 await section.locator('.common-dish-details > summary').click();await expect(section.locator('.ingredient-line').first()).not.toBeVisible();
 await page.setViewportSize({width:860,height:650});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Common dishes overflow narrow layout');if(errors.length)throw new Error(errors.join('\n'));
 // A named pot must group even when the two first lines list different ingredients/portions.
 const potRecords=await page.evaluate(async part=>{
  const saved=[];
  for(const [date,text,grams] of [['2026-10-22','合成麻辣香锅，一碗米饭，有青菜和鸡肉',100],['2026-10-23','合成麻辣香锅，按称一斤，有蔬菜、鹌鹑蛋、鸡胸肉，加一碗米饭',150]]){
   const r=await window.health.invoke('record:create',{kind:'meal',occurredAt:date+'T12:00:00+08:00',text,attachmentTokens:[]});
   const current=await window.health.invoke('record:analyze',{ids:[r.id],revision:r.revision,analysis:{summary:'合成香锅的本次估算',questions:[],ingredients:[{...part,grams:{low:grams,high:grams}}]}});saved.push({id:r.id,macros:current.analysis.macros});
  }
  return saved;
 },part('合成香锅蔬菜','synthetic-pot'));
 let pot=section.locator('.common-dish-card').filter({hasText:'合成麻辣香锅'});await expect(pot).toHaveCount(1);await expect(pot.locator('.common-dish-name')).toHaveText('合成麻辣香锅');await expect(pot).toContainText('出现 2 餐 / 2 天');await expect(pot.locator('.common-dish-details')).not.toHaveAttribute('open','');
 await app.close();app=null;page=await launch();await page.getByRole('navigation').getByRole('button',{name:'我的档案',exact:true}).click();section=page.getByRole('region',{name:'常吃餐食',exact:true});pot=section.locator('.common-dish-card').filter({hasText:'合成麻辣香锅'});await expect(pot).toHaveCount(1);await expect(pot).toContainText('出现 2 餐 / 2 天');
 const potAfter=await page.evaluate(()=>window.health.invoke('snapshot'));for(const original of potRecords){const r=potAfter.records.find(r=>r.id===original.id);if(JSON.stringify(r.analysis.macros)!==JSON.stringify(original.macros))throw new Error('Pot grouping changed per-meal nutrition');}
 // A new analysis and the resulting profile refresh must also keep shared sides nested.
 await page.evaluate(async part=>{const r=await window.health.invoke('record:create',{kind:'meal',occurredAt:'2026-10-24T12:00:00+08:00',text:'合成丁店蔬菜餐盘',attachmentTokens:[]});await window.health.invoke('record:analyze',{ids:[r.id],revision:r.revision,analysis:{summary:'合成新餐食的配菜',questions:[],ingredients:[part]}});},part('合成玉米粒（熟）','synthetic-new-side'));
 independent=page.getByRole('region',{name:'常用食物与补剂',exact:true});await expect(independent).not.toContainText('合成玉米粒（熟）');await expect(independent.getByRole('button',{name:'加入常用食物',exact:true})).toHaveCount(0);await expect(independent).toContainText('合成蛋白粉');await expect(section.locator('.common-dish-card').filter({hasText:renamed})).toContainText('合成玉米粒（熟）');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Common-dish UI passed: shared sides in unrelated meals stay out of standalone suggestions after analysis refresh and restart; recurring pots, natural-name matching, collapsed ingredients and saved labels, independent supplements, unchanged historical macros, editable names/aliases/brands, archive/restore. Synthetic records only; no model requests sent.');
}catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(tmpdir(),'bodyjournal-dishes-failure.png')}).catch(()=>{});console.error('Common-dish UI failure:',errors,await page.locator('[role="dialog"]').allTextContents());}throw error;}
finally{if(app)await app.close().catch(()=>{});rmSync(vault,{recursive:true,force:true});}
