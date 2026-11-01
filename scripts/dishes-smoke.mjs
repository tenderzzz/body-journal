import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {tsImport} from 'tsx/esm/api';
const {HealthStore}=await tsImport('../electron/core/store.ts',import.meta.url);
const {FoodCatalog}=await tsImport('../electron/core/nutrition.ts',import.meta.url);
const vault=mkdtempSync(path.join(tmpdir(),'bodyjournal-dishes-ui-')),errors=[];
const originalName='合成鸡肉面轻食（去皮）',renamed='合成常吃面餐';
const part=(name,group)=>({name,foodId:null,grams:{low:100,high:100},assumption:'仅用于合成流程验证',compositionGroup:group,role:'component',portionSource:'estimated',nutrition:{source:'estimate',basis:'合成每100g数据',per100g:{kcal:{low:150,high:200},protein:{low:8,high:12},carbs:{low:20,high:30},fat:{low:3,high:5}}}});
let app;const originals={};
async function launch(){app=await _electron.launch({executablePath:process.env.BODYJOURNAL_APP??electron,args:process.env.BODYJOURNAL_APP?[]:[process.cwd()],env:{...process.env,HEALTH_TEST_VAULT:vault,HEALTH_DEMO:'0'},timeout:30000});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('navigation',{name:'主导航'}).waitFor();return page;}
try{
 const store=new HealthStore(vault,new FoodCatalog([]),path.join(vault,'inbox'),false);
 for(const [id,date,names,group] of [['synthetic-dish-first','2026-10-20',['合成主菜','合成配菜'],'synthetic-group-first'],['synthetic-dish-second','2026-10-21',['合成肉类','合成面食','合成蔬菜'],'synthetic-group-second']]){
  const r=store.importEnvelope({version:1,id,kind:'meal',text:originalName,occurredAt:date+'T12:00:00+08:00',timezone:'Asia/Shanghai'}).record;
  originals[id]=store.applyAnalysis(id,{summary:'合成餐食已按本次分量估算',questions:[],assumptions:['不同的食材拆分不改变同款名称'],ingredients:names.map(name=>part(name,group))},'chatgpt',r.revision).analysis.macros;
 }
 store.close();let page=await launch();
 const snapshot=await page.evaluate(()=>window.health.invoke('snapshot'));
 const dishes=snapshot.commonDishes.filter(d=>d.recordIds.includes('synthetic-dish-first'));
 if(dishes.length!==1||dishes[0].recordIds.length!==2)throw new Error('Same whole dish was not grouped across different ingredient decompositions');
 for(const r of snapshot.records)if(originals[r.id]&&JSON.stringify(r.analysis.macros)!==JSON.stringify(originals[r.id]))throw new Error('Grouping changed a historical calorie or macro estimate');
 await page.getByRole('navigation').getByRole('button',{name:'我的档案',exact:true}).click();
 let section=page.getByRole('region',{name:'常吃餐食',exact:true});
 await expect(section.locator('.memory-row')).toHaveCount(1);await expect(section).toContainText('出现 2 餐 / 2 天');await expect(section).toContainText('450–600 kcal');
 await section.getByRole('button',{name:'查看最近记录',exact:true}).click();
 let modal=page.getByRole('dialog');await expect(modal.getByRole('heading',{name:/合成鸡肉面轻食/})).toBeVisible();await expect(modal.locator('.macro-grid')).toHaveCount(1);await expect(modal.locator('.macro-grid')).toContainText('450–600');
 const detail=modal.locator('.meal-calculation-details');await expect(detail).not.toHaveAttribute('open','');await expect(detail.locator('summary')).toHaveText('食材计算明细（3项）');await expect(modal.locator('.ingredient-line').first()).not.toBeVisible();
 await detail.locator('summary').click();await expect(detail.locator('.ingredient-line')).toHaveCount(3);await expect(detail.locator('.ingredient-line').first()).toBeVisible();
 await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await section.getByRole('button',{name:'编辑常吃餐食',exact:true}).click();modal=page.getByRole('dialog');await modal.getByLabel('餐食名称',{exact:true}).fill(renamed);await modal.getByLabel('餐食其他称呼',{exact:true}).fill(originalName+'\n合成另一种叫法');await modal.getByRole('button',{name:'保存餐食名称',exact:true}).click();await expect(modal).toHaveCount(0);await expect(section).toContainText(renamed);
 await section.getByRole('button',{name:'停用常吃餐食',exact:true}).click();await expect(section.locator('.memory-row')).toHaveCount(0);
 await page.getByLabel('显示过期、停用和依据已变化的记忆',{exact:true}).check();await expect(section.locator('.memory-row')).toHaveCount(1);await section.getByRole('button',{name:'启用常吃餐食',exact:true}).click();await page.getByLabel('显示过期、停用和依据已变化的记忆',{exact:true}).uncheck();await expect(section).toContainText(renamed);
 await app.close();app=null;page=await launch();await page.getByRole('navigation').getByRole('button',{name:'我的档案',exact:true}).click();section=page.getByRole('region',{name:'常吃餐食',exact:true});await expect(section.locator('.memory-row')).toHaveCount(1);await expect(section).toContainText(renamed);await expect(section).toContainText('出现 2 餐 / 2 天');
 const after=await page.evaluate(()=>window.health.invoke('snapshot'));for(const r of after.records)if(originals[r.id]&&JSON.stringify(r.analysis.macros)!==JSON.stringify(originals[r.id]))throw new Error('Profile edits changed historical macro totals');
 await page.setViewportSize({width:860,height:650});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Common dishes overflow narrow layout');if(errors.length)throw new Error(errors.join('\n'));
 console.log('Common-dish UI passed: automatic whole-dish grouping, compact ingredient display, unchanged historical macros, name/aliases, archive/restore and restart. Synthetic records only; no model requests sent.');
}catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(tmpdir(),'bodyjournal-dishes-failure.png')}).catch(()=>{});console.error('Common-dish UI failure:',errors,await page.locator('[role="dialog"]').allTextContents());}throw error;}
finally{if(app)await app.close().catch(()=>{});rmSync(vault,{recursive:true,force:true});}
