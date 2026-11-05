import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {tsImport} from 'tsx/esm/api';

const {HealthStore}=await tsImport('../electron/core/store.ts',import.meta.url);
const {FoodCatalog}=await tsImport('../electron/core/nutrition.ts',import.meta.url);
const vault=mkdtempSync(path.join(tmpdir(),'bodyjournal-cardio-ui-')),date='2026-10-15',errors=[];
let app;
async function launch(){
 app=await _electron.launch({executablePath:process.env.BODYJOURNAL_APP??electron,args:process.env.BODYJOURNAL_APP?[]:[process.cwd()],env:{...process.env,HEALTH_TEST_VAULT:vault,HEALTH_DEMO:'0'},timeout:30000});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.getByRole('navigation',{name:'主导航'}).waitFor();return page;
}
try{
 const store=new HealthStore(vault,new FoodCatalog([]),path.join(vault,'inbox'),false);
 store.importEnvelope({version:1,id:'synthetic-weight',kind:'body',text:'合成体重',body:{weightKg:80},occurredAt:date+'T08:00:00+08:00',timezone:'Asia/Shanghai'});
 store.energy.saveProfile({effectiveDate:date,age:30,heightCm:180,sex:'male',activity:'seated',strengthMinutes:{low:45,high:60},strengthPerWeek:3,runMinutes:30,runPerWeek:1,runPace:360,generalAdult:true,usualSteps:3000});
 const r=store.importEnvelope({version:1,id:'synthetic-incline',kind:'training',text:'跑步机爬坡 坡度12% 1.8km 24min\n卧推 50kg 3x8',occurredAt:date+'T18:00:00+08:00',timezone:'Asia/Shanghai'}).record;
 const legacy=store.record(r.id);legacy.analysis.run={km:1.8,minutes:24,terrain:'hilly',completion:'completed'};legacy.analysisPending=false;store.db.prepare('UPDATE records SET doc=? WHERE id=?').run(JSON.stringify(legacy),r.id);
 const beforeSets=JSON.stringify(legacy.analysis.sets);store.energy.saveDay({date,steps:9000,mealComplete:false,activityComplete:true});store.close();
 let page=await launch();await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'能量',exact:true}).click();
 await page.getByLabel('能量日期',{exact:true}).fill(date);
 await expect(page.locator('.energy-breakdown').getByRole('button',{name:'有氧',exact:true})).toBeVisible();
 await expect(page.locator('.energy-step-flow')).toContainText('有氧步数');await expect(page.locator('.energy-step-flow')).toContainText('距离与步长估算');
 const before=await page.evaluate(async date=>(await window.health.invoke('energy:get',{date})).selected,date);
 if(before.workouts.find(w=>w.kind==='run')?.method!=='acsm-walking'||before.walking.pending)throw new Error('Incline calculation or step verification is pending');
 await page.locator('.energy-breakdown').getByRole('button',{name:'有氧',exact:true}).click();
 const modal=page.getByRole('dialog');await expect(modal).toContainText('有氧（爬坡）');
 await modal.getByRole('button',{name:'核对 / 更正活动数据',exact:true}).click();await expect(modal.getByLabel('有氧方式')).toHaveValue('incline');
 await modal.getByLabel('更正坡度 %',{exact:true}).fill('8');await modal.getByLabel('有氧步数已计入全天步数',{exact:true}).uncheck();
 await modal.getByRole('button',{name:'保存活动更正',exact:true}).click();
 await expect(modal).toContainText('有氧步数未计入全天总数');await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await expect.poll(()=>page.evaluate(async date=>(await window.health.invoke('energy:get',{date})).selected.walking.nonTrainingSteps,date)).toBe(9000);
 const fixed=await page.evaluate(()=>window.health.invoke('record:get',{id:'synthetic-incline'}));if(JSON.stringify(fixed.analysis.sets)!==beforeSets)throw new Error('Cardio correction modified strength sets');
 await app.close();app=undefined;page=await launch();
 const persisted=await page.evaluate(()=>window.health.invoke('record:get',{id:'synthetic-incline'}));
 if(persisted.analysis.run.inclinePercent!==8||persisted.analysis.run.stepsIncluded!==false)throw new Error('Cardio overrides lost on restart');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log(JSON.stringify({synthetic:true,passed:['legacy incline correction','ACSM calculation','step interval','cardio detail','grade override','step inclusion override','strength preservation','restart']}));
}catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(tmpdir(),'bodyjournal-cardio-failure.png')}).catch(()=>{});}throw error;}
finally{if(app)await app.close().catch(()=>{});rmSync(vault,{recursive:true,force:true});}
