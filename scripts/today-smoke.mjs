import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {tsImport} from 'tsx/esm/api';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const vault=mkdtempSync(path.join(tmpdir(),'bodyjournal-today-ui-'));
let app;
const errors=[];
async function launch(){
  app=await _electron.launch({executablePath:process.env.BODYJOURNAL_APP??electron,args:process.env.BODYJOURNAL_APP?[]:[process.cwd()],
    env:{...process.env,HEALTH_TEST_VAULT:vault,HEALTH_DEMO:'0'},timeout:30000});
  const page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('navigation',{name:'主导航'}).waitFor();
  return page;
}
try{
  const {HealthStore}=await tsImport('../electron/core/store.ts',import.meta.url);
  const {FoodCatalog}=await tsImport('../electron/core/nutrition.ts',import.meta.url);
  const {addDays}=await tsImport('../src/shared/energy.ts',import.meta.url);
  const {ingredient}=await tsImport('../tests/fixtures/prompt-golden.ts',import.meta.url);
  const store=new HealthStore(vault,new FoodCatalog([]),vault+'/inbox',false);
  try{
    const today=store.energy.today(),zone='Asia/Shanghai';
    function add(kind,id,days,text,body){
      return store.importEnvelope({version:1,kind,id,occurredAt:addDays(today,days)+'T12:00:00+08:00',timezone:zone,text,body,dateLocked:true}).record;
    }
    store.energy.importManualTarget(2200,140);
    add('training','synthetic-back',-5,'背日\n高位下拉 40kg 3×8');add('training','synthetic-chest',-1,'胸日\n杠铃卧推 45kg 3×8');
    add('body','synthetic-weight',-1,'测量',{weightKg:75});
    const meal=add('meal','synthetic-meal',0,'样例豆腐 100 克');
    store.applyAnalysis(meal.id,{summary:'合成午餐',ingredients:[ingredient('样例豆腐',100)]},'local',meal.revision);
  }finally{store.close();}
  const start=performance.now();let page=await launch();
  let card=page.getByRole('region',{name:'今日维持'});
  await expect(card).toContainText('下次练背');await expect(card).toContainText('40 kg');
  await expect(card).toContainText('130 g 待补');await expect(card).toContainText('75 kg');
  await card.getByRole('button',{name:'今天休息'}).click();await expect(card.getByRole('button',{name:'撤销休息'})).toBeVisible();
  const elapsed=(performance.now()-start)/1000; if(elapsed>30)throw Error('启动到标记休息超过30秒');
  await app.close();page=await launch();card=page.getByRole('region',{name:'今日维持'});
  await card.getByRole('button',{name:'撤销休息'}).click();await expect(card).toContainText('下次练背');
  for(const [width,height] of [[860,650],[1300,900]]){
    await page.setViewportSize({width,height});
    const fits=await card.locator('.summary-row').evaluateAll(rows=>rows.length===3&&rows.every(el=>{
      const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;
    }));
    if(!fits)throw Error('今日卡超出 '+width+' × '+height+' 首屏');
  }
  await card.getByRole('button',{name:/上次可比记录/}).click();await expect(page.getByRole('dialog')).toContainText('高位下拉');
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('navigation').getByRole('button',{name:'能量',exact:true}).click();
  await expect(card).toContainText('130 g 待补');await expect(page.locator('.energy-detail')).toHaveCount(0);
  const links=page.getByRole('region',{name:'能量详情入口'});
  await expect(links.getByRole('button')).toHaveCount(3);
  for(const [width,height] of [[860,650],[1300,900]]){
    await page.setViewportSize({width,height});
    await expect(page.locator('.energy-tile')).toHaveCount(4);
    const fits=await page.locator('.energy-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1);
    if(!fits)throw Error('能量摘要发生横向溢出 '+width+' × '+height);
  }
  const date=await page.locator('.plot-column').first().getAttribute('aria-label');
  await page.locator('.plot-column').first().click();
  await expect(page.getByLabel('能量日期',{exact:true})).toHaveValue(date.slice(0,10));
  await page.getByRole('button',{name:'看趋势',exact:true}).click();await expect(page.locator('.energy-week-review')).toBeVisible();
  await links.getByRole('button',{name:'核对今天',exact:true}).click();
  await expect(page.getByLabel('能量日期',{exact:true})).toHaveValue(date.slice(0,10));
  await links.getByRole('button',{name:'核对今天',exact:true}).click();
  await expect(page.locator('.energy-detail')).toHaveCount(0);
  if(errors.length)throw Error(errors.join('\n'));
  console.log('隔离桌面通过。启动到标记休息 '+elapsed.toFixed(1)+' 秒，860×650 与 1300×900 首屏、重启撤销、原记录链接及趋势展开均已验证。');
}finally{if(app)await app.close().catch(()=>{});rmSync(vault,{recursive:true,force:true});}
