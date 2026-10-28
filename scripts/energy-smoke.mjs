import {_electron,expect} from '@playwright/test';
import electron from 'electron';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const vault=mkdtempSync(path.join(tmpdir(),'bodyjournal-energy-ui-')),demoVault=mkdtempSync(path.join(tmpdir(),'bodyjournal-energy-demo-'));
const reviewVault=mkdtempSync(path.join(tmpdir(),'bodyjournal-energy-review-'));
const photoVault=mkdtempSync(path.join(tmpdir(),'bodyjournal-energy-photo-'));
const executablePath=process.env.BODYJOURNAL_APP??electron,args=process.env.BODYJOURNAL_APP?[]:[process.cwd()];
const errors=[];let app;
async function assertModalFooter(page,buttonName){
  const modal=page.getByRole('dialog');
  const state=await modal.getByRole('button',{name:buttonName,exact:true}).evaluate(button=>{
    const dialog=button.closest('[role="dialog"]'),footer=button.closest('footer'),body=dialog.querySelector('.modal-body');
    const b=button.getBoundingClientRect(),d=dialog.getBoundingClientRect(),f=footer.getBoundingClientRect();
    const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
    return {disabled:button.disabled,pointerEvents:getComputedStyle(button).pointerEvents,hit:hit?{tag:hit.tagName,html:hit.outerHTML.slice(0,300)}:null,button:{x:b.x,width:b.width,top:b.top,bottom:b.bottom},dialog:{top:d.top,bottom:d.bottom},footer:{top:f.top,bottom:f.bottom},viewport:innerHeight,visible:b.top>=d.top&&b.bottom<=d.bottom+1&&b.top>=0&&b.bottom<=innerHeight+1&&!!hit&&(hit===button||button.contains(hit)),bodyScrollable:body.scrollHeight>body.clientHeight};
  });
  if(!state.visible){await page.screenshot({path:'/tmp/bodyjournal-modal-failure.png'});throw new Error('保存按钮没有完整显示在弹窗内：'+JSON.stringify(state));}
}
async function verifyDialogSizes(page,buttonName){
  const modal=page.getByRole('dialog'),body=modal.locator('.modal-body');
  for(const [width,height] of [[1300,900],[860,650],[1300,650]]){
    await page.setViewportSize({width,height});
    await body.evaluate(el=>{el.scrollTop=0;});
    await assertModalFooter(page,buttonName);
    const before=await modal.getByRole('button',{name:buttonName,exact:true}).boundingBox();
    const scrollable=await body.evaluate(el=>el.scrollHeight>el.clientHeight);
    if(scrollable){
      await body.hover();await page.mouse.wheel(0,10000);
      await expect.poll(()=>body.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
      await assertModalFooter(page,buttonName);
      const after=await modal.getByRole('button',{name:buttonName,exact:true}).boundingBox();
      if(Math.abs(before.y-after.y)>1)throw new Error('正文滚动带动保存按钮移出固定页脚');
    }
    if(buttonName==='保存计算资料'){
      const checkbox=modal.getByLabel('我已核对以上资料、活动档位和常规训练时长',{exact:true});
      const box=await checkbox.boundingBox();
      if(!box||box.y<0||box.y+box.height>height)throw new Error('核对复选框未显示在窗口中');
    }
    if(width===860&&buttonName==='保存计算资料'){mkdirSync('evidence',{recursive:true});await modal.screenshot({path:'evidence/energy-profile-small.png'});}
  }
  await page.setViewportSize({width:1300,height:900});await body.evaluate(el=>{el.scrollTop=0;});
}
async function launch(root,demo=false){app=await _electron.launch({executablePath,args,env:{...process.env,HEALTH_TEST_VAULT:root,HEALTH_DEMO:demo?'1':'0'},timeout:30000});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('navigation',{name:'主导航'}).waitFor();return page;}
try{
  let page=await launch(vault);
  await page.getByRole('navigation').getByRole('button',{name:'能量',exact:true}).click();
  await expect(page.getByText('再补一点资料，就能估算每天的消耗。',{exact:true})).toBeVisible();
  const today=await page.evaluate(async()=>(await window.health.invoke('energy:get')).today);
  await page.getByRole('button',{name:'记身体',exact:true}).click();
  await page.getByRole('spinbutton',{name:'体重（kg）'}).fill('80');
  await page.getByRole('button',{name:'保存记录',exact:true}).click();
  // Dismiss the preceding record-save notification before testing the modal layout.
  const notification=page.getByRole('button',{name:'关闭提示',exact:true});
  await expect(notification).toBeVisible();
  await notification.click();
  await expect(notification).toHaveCount(0);
  await page.getByRole('button',{name:'补充计算资料',exact:true}).click();
  let modal=page.getByRole('dialog');
  await verifyDialogSizes(page,'保存计算资料');
  await modal.getByLabel('生效时年龄',{exact:true}).fill('30');
  await modal.getByLabel('身高 cm',{exact:true}).fill('180');
  if(!await modal.getByLabel('公式使用的性别参数',{exact:true}).count())throw new Error('Profile form labels: '+JSON.stringify(await modal.locator('label').allTextContents()));
  await modal.getByLabel('公式使用的性别参数',{exact:true}).selectOption('male');
  await modal.getByLabel('我已核对以上资料、活动档位和常规训练时长',{exact:true}).check();
  await assertModalFooter(page,'保存计算资料');
  await modal.getByRole('button',{name:'保存计算资料',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.energy-burn>strong')).not.toHaveText('— kcal');
  await page.getByRole('button',{name:'设置目标',exact:true}).first().click();
  modal=page.getByRole('dialog');
  await expect(modal.getByRole('button',{name:'填入参考数值',exact:true})).toBeVisible();
  await verifyDialogSizes(page,'确认目标');
  await modal.getByLabel('当前目标',{exact:true}).selectOption('lose');
  await expect(modal.getByRole('button',{name:'填入参考数值',exact:true})).toBeVisible();
  await modal.getByRole('button',{name:'填入参考数值',exact:true}).click();
  const fixed=Number(await modal.getByLabel('每日能量目标 kcal',{exact:true}).inputValue());
  await modal.getByRole('button',{name:'确认目标',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const fixture=await page.evaluate(async(today)=>{
    const train=await window.health.invoke('record:create',{kind:'training',text:"卧推 50kg 3x8\n力量训练60分钟\n跑步3km 配速6' 用时18分钟",occurredAt:today+'T18:00:00+08:00',attachmentTokens:[]});
    const meal=await window.health.invoke('record:create',{kind:'meal',text:'合成测试全天饮食',occurredAt:today+'T19:00:00+08:00',attachmentTokens:[]});
    await window.health.invoke('record:analyze',{ids:[meal.id],revision:meal.revision,analysis:{summary:'合成数据',questions:[],assumptions:[],ingredients:[{name:'示例食物',foodId:null,grams:{low:1000,high:1100},assumption:'测试',nutrition:{source:'estimate',basis:'合成测试',per100g:{kcal:{low:200,high:210},protein:{low:10,high:11},carbs:{low:20,high:22},fat:{low:5,high:6}}}}]}});
    return train;
  },today);
  await expect(page.getByText('60 分钟 · 记录时长',{exact:true})).toBeVisible();
  await expect(page.getByText('18 分钟 · 记录时长',{exact:true})).toBeVisible();
  await page.getByLabel('当天饮食已记齐，包含零食和饮料',{exact:true}).check();
  await page.getByLabel('当天活动已记齐，或明确没有专门训练',{exact:true}).check();
  await page.getByRole('button',{name:'保存当天补充',exact:true}).click();
  await expect.poll(async()=>page.evaluate(async()=>(await window.health.invoke('energy:get')).selected.intake.complete)).toBe(true);
  const energy=await page.evaluate(async()=>await window.health.invoke('energy:get'));
  if(energy.selected.target.kcal!==fixed)throw new Error('Training changed the fixed target');
  if(energy.selected.workouts.length!==2||!energy.selected.balance)throw new Error('Energy summary did not include completed workouts and complete intake');
  await page.getByRole('combobox',{name:'能量趋势范围'}).selectOption('30');
  await expect(page.locator('.energy-trend')).toBeVisible();
  await page.getByText('查看计算方法、假设与缺失项',{exact:true}).click();
  await expect(page.getByText(/运动总消耗＝MET/)).toBeVisible();
  await page.evaluate(async r=>window.health.invoke('record:update',{id:r.id,revision:r.revision,text:r.text+'\n感受：今天有点累'}),fixture);
  await expect.poll(async()=>page.evaluate(async()=>(await window.health.invoke('energy:get')).selected.activityComplete)).toBe(false);
  await app.close();
  page=await launch(vault);
  const reopened=await page.evaluate(async()=>window.health.invoke('energy:get'));
  if(!reopened.profiles.length||reopened.selected.target.kcal!==fixed)throw new Error('Energy data did not survive restart');
  await app.close();
  // A legacy image-only run must count without inventing a strength session or requiring duplicate text.
  const photoFixture=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
    import {HealthStore} from './electron/core/store.ts';
    import {FoodCatalog} from './electron/core/nutrition.ts';
    import {addDays} from './src/shared/energy.ts';
    import {randomUUID} from 'node:crypto';
    const root=process.env.BODYJOURNAL_PHOTO_FIXTURE;
    const store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false),date=addDays(store.energy.today(),-2);
    store.energy.saveProfile({effectiveDate:date,age:30,heightCm:180,sex:'male',activity:'seated',strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:20,runPerWeek:1,runPace:360,generalAdult:true});
    store.importEnvelope({version:1,id:randomUUID(),kind:'body',occurredAt:date+'T08:00:00+08:00',timezone:'Asia/Shanghai',text:'合成测试体重',body:{weightKg:80}});
    const r=store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:date+'T18:00:00+08:00',timezone:'Asia/Shanghai',text:'无补充',attachments:[{name:'run.png',mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGqoAAAAASUVORK5CYII='}]}).record;
    store.applyAnalysis(r.id,{summary:'合成测试：户外跑步结果截图，5.02公里、26分54秒，无力量训练。',questions:[],assumptions:['合成图片识别结果，不调用真实模型。'],sets:[],run:{km:5.02,minutes:26.9}},'deepseek',r.revision);
    store.energy.saveDay({date,mealComplete:false,activityComplete:true});
    console.log(JSON.stringify({date,recordId:r.id}));store.close();
  `],{cwd:process.cwd(),env:{...process.env,BODYJOURNAL_PHOTO_FIXTURE:photoVault},encoding:'utf8',stdio:'pipe'}).trim());
  page=await launch(photoVault);
  await page.getByRole('navigation').getByRole('button',{name:'能量',exact:true}).click();
  await page.getByLabel('能量日期',{exact:true}).fill(photoFixture.date);
  await expect(page.getByText('26.9 分钟 · 记录时长',{exact:true})).toBeVisible();
  const photoActivity=page.getByLabel('当天活动已记齐，或明确没有专门训练',{exact:true});
  await photoActivity.scrollIntoViewIfNeeded();
  await expect(photoActivity).toBeVisible();await expect(photoActivity).toBeChecked();
  const photoEnergy=await page.evaluate(async date=>(await window.health.invoke('energy:get',{date})).selected,photoFixture.date);
  if(photoEnergy.workouts.length!==1||photoEnergy.workouts[0].kind!=='run'||photoEnergy.workouts[0].recordId!==photoFixture.recordId||photoEnergy.workouts[0].minutes.low!==26.9||!photoEnergy.activityComplete)throw new Error('Image-only run was missing, duplicated, or treated as strength');
  await page.getByRole('button',{name:'保存当天补充',exact:true}).click();
  await expect.poll(()=>page.evaluate(async date=>(await window.health.invoke('energy:get',{date})).selected.activityComplete,photoFixture.date)).toBe(true);
  await expect(photoActivity).toBeChecked();
  await page.getByRole('navigation').getByRole('button',{name:'趋势',exact:true}).click();
  await page.getByRole('button',{name:'训练表现',exact:true}).click();
  await expect(page.locator('.run-row')).toHaveCount(1);
  await expect(page.locator('.run-row')).toContainText('5.02 km');
  await app.close();
  // Seed a fully synthetic eligible review, without any model credentials or requests.
  execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
    import {HealthStore} from './electron/core/store.ts';
    import {FoodCatalog} from './electron/core/nutrition.ts';
    import {addDays} from './src/shared/energy.ts';
    import {randomUUID} from 'node:crypto';
    const root=process.env.BODYJOURNAL_REVIEW_FIXTURE;
    const store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false),today=store.energy.today(),from=addDays(today,-21);
    store.energy.saveProfile({effectiveDate:from,age:30,heightCm:180,sex:'male',activity:'seated',strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:20,runPerWeek:0,runPace:360,generalAdult:true});
    store.energy.saveTarget({effectiveDate:from,mode:'maintain',kcal:2300,protein:128},new Date(from+'T08:00:00+08:00'));
    for(let i=0;i<21;i++){const date=addDays(from,i);
      store.importEnvelope({version:1,id:randomUUID(),kind:'body',occurredAt:date+'T08:00:00+08:00',timezone:'Asia/Shanghai',text:'合成测试体重',body:{weightKg:80}});
      const m=store.importEnvelope({version:1,id:randomUUID(),kind:'meal',occurredAt:date+'T19:00:00+08:00',timezone:'Asia/Shanghai',text:'合成测试全天饮食'}).record;
      store.applyAnalysis(m.id,{summary:'合成测试',questions:[],assumptions:[],ingredients:[{name:'合成食物',foodId:null,grams:{low:1000,high:1000},assumption:'合成数据',nutrition:{source:'estimate',basis:'合成测试',per100g:{kcal:{low:220,high:230},protein:{low:12,high:13},carbs:{low:20,high:22},fat:{low:5,high:6}}}}]},'local',m.revision);
      store.energy.saveDay({date,mealComplete:true,activityComplete:true});
    }
    const review=store.energy.review();store.energy.createProposal({kcal:2400,reason:'合成测试草案：仅验证采纳与撤销流程'},randomUUID(),store.energy.hash(review.from,today));store.close();
  `],{cwd:process.cwd(),env:{...process.env,BODYJOURNAL_REVIEW_FIXTURE:reviewVault},stdio:'pipe'});
  page=await launch(reviewVault);
  await page.getByRole('navigation').getByRole('button',{name:'能量',exact:true}).click();
  await page.getByText('饮食与训练建议',{exact:true}).click();
  await page.getByRole('button',{name:'采纳建议',exact:true}).click();
  await page.getByText('饮食目标的生效记录',{exact:true}).click();
  await expect(page.getByText(/已安排 .*2400 kcal／天/)).toBeVisible();
  let reviewed=await page.evaluate(async()=>window.health.invoke('energy:get'));
  if(reviewed.selected.target.kcal!==2300||!reviewed.targets.some(t=>t.kcal===2400&&t.effectiveDate>reviewed.today&&!t.undoneAt))throw new Error('Adoption did not schedule the next-day goal');
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  reviewed=await page.evaluate(async()=>window.health.invoke('energy:get'));
  if(reviewed.targets.some(t=>t.effectiveDate>reviewed.today&&!t.undoneAt)||reviewed.selected.target.kcal!==2300)throw new Error('Goal undo failed');
  await app.close();
  page=await launch(demoVault,true);
  await page.getByRole('navigation').getByRole('button',{name:'能量',exact:true}).click();
  await expect(page.locator('.energy-trend')).toBeVisible();
  mkdirSync('evidence',{recursive:true});await page.screenshot({path:'evidence/energy.png'});
  await page.locator('.energy-history').screenshot({path:'evidence/energy-trend.png'});
  await page.setViewportSize({width:860,height:700});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Energy page overflow at 860px');
  await page.screenshot({path:'evidence/energy-compact.png'});
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('Energy UI passed: setup, fixed target, separate exercise durations, completeness, detail/trend, edit invalidation, restart, image-only running and saved activity confirmation, next-day adoption and undo, isolated demo and compact layout.');
}finally{if(app)await app.close().catch(()=>{});rmSync(vault,{recursive:true,force:true});rmSync(demoVault,{recursive:true,force:true});rmSync(reviewVault,{recursive:true,force:true});rmSync(photoVault,{recursive:true,force:true});}
