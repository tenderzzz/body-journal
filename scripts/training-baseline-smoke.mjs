import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {tsImport} from 'tsx/esm/api';
const {HealthStore}=await tsImport('../electron/core/store.ts',import.meta.url);
const {FoodCatalog}=await tsImport('../electron/core/nutrition.ts',import.meta.url);
const vault=mkdtempSync(path.join(tmpdir(),'bodyjournal-training-baseline-')),errors=[],originals={};
let app;
async function launch(){
 app=await _electron.launch({executablePath:process.env.BODYJOURNAL_APP??electron,args:process.env.BODYJOURNAL_APP?[]:[process.cwd()],env:{...process.env,HEALTH_TEST_VAULT:vault,HEALTH_DEMO:'0'},timeout:30000});
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('navigation',{name:'主导航'}).waitFor();return page;
}
async function check(page){
 await page.getByRole('navigation').getByRole('button',{name:'趋势',exact:true}).click();
 await page.getByLabel('趋势时间范围',{exact:true}).selectOption('0');await page.getByRole('button',{name:'训练表现',exact:true}).click();
 await page.getByLabel('训练动作',{exact:true}).selectOption('器械反向飞鸟');
 await expect(page.getByLabel('比较基线',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('cell',{name:'20 kg',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'25 kg',exact:true})).toBeVisible();
 const snapshot=await page.evaluate(()=>window.health.invoke('snapshot'));
 for(const r of snapshot.records)if(originals[r.id]&&JSON.stringify(r.analysis.sets)!==originals[r.id])throw new Error('Baseline grouping rewrote reported training sets');
 const refs=snapshot.memories.filter(m=>m.autoCategory==='training'&&m.active&&!m.stale&&m.text.startsWith('器械反向飞鸟：'));
 if(refs.length!==1||refs[0].sourceIds.length!==2||!refs[0].text.includes('蝴蝶机 · 器械标重'))throw new Error('Training references did not merge with statistics');
 await page.getByRole('button',{name:'查看训练记录',exact:true}).last().click();
 const dialog=page.getByRole('dialog');await expect(dialog.locator('.table-sub').filter({hasText:'蝴蝶机 · 器械标重'})).toHaveCount(1);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
}
try{
 const store=new HealthStore(vault,new FoodCatalog([]),path.join(vault,'inbox'),false);
 for(const [id,date,equipment,kg] of [['synthetic-reverse-machine','2026-10-20','器械',20],['synthetic-reverse-butterfly','2026-10-21','蝴蝶机',25]]){
  const r=store.importEnvelope({version:1,id,kind:'training',text:`肩：\n器械反向飞鸟 ${kg}kg 2x10`,occurredAt:date+'T12:00:00+08:00',timezone:'Asia/Shanghai'}).record;
  originals[id]=JSON.stringify(store.applyAnalysis(id,{summary:'合成反向飞鸟训练',questions:[],training:{part:'shoulders',completion:'completed'},sets:[{exercise:'器械反向飞鸟',equipment,kg,sets:2,reps:10,loadBasis:'machine',confirmed:true}]},'local',r.revision).analysis.sets);
 }
 store.close();let page=await launch();await check(page);await app.close();app=null;
 page=await launch();await check(page);if(errors.length)throw new Error(errors.join('\n'));
 console.log('Training baseline UI passed: one machine/butterfly caliber, both historical rows, shared training reference, record details, unchanged reported sets and restart. Synthetic records only; no model requests sent.');
}finally{if(app)await app.close().catch(()=>{});rmSync(vault,{recursive:true,force:true});}
