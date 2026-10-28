import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseDailyActivity,parseTraining,localRecordStatus} from '../electron/core/parser';
import {analysisSchema,runSchema,dailyActivitySchema} from '../electron/core/validation';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';
import {AssistantService} from '../electron/ai/service';
import type {ChatGPTAuth,SecretStorage} from '../electron/ai/auth';

test('run extraction retains original calorie meanings, moving and elapsed durations, and source',()=>{
 const run=parseTraining('跑步5km\n运动时长30:00\n总时长35:30\n活动热量300千卡\n总热量340千卡\n步数5,000\n平均步频166\n平均心率155\n来源:Keep\n运动编号:run_123')!.run!;
 assert.deepEqual({km:run.km,minutes:run.minutes,elapsed:run.elapsedMinutes,active:run.activeKcal,total:run.totalKcal,steps:run.steps,cadence:run.cadence,hr:run.avgHeartRate,app:run.sourceApp,id:run.sourceId},{km:5,minutes:30,elapsed:35.5,active:300,total:340,steps:5000,cadence:166,hr:155,app:'Keep',id:'run_123'});
 assert.match(run.calorieLabel!,/活动热量300/);assert.equal(run.reportedKcal,undefined);
 assert.equal(runSchema.parse(run).totalKcal,340);
});
test('ambiguous calories remain unknown; heart rate never manufactures a calorie value',()=>{
 const run=parseTraining('跑步5km 配速6分/公里，用时30分钟，消耗300千卡，平均心率150')!.run!;
 assert.equal(run.minutes,30);assert.equal(run.paceSecondsPerKm,360);assert.equal(run.reportedKcal,300);assert.equal(run.activeKcal,undefined);assert.equal(run.totalKcal,undefined);assert.equal(run.calorieLabel,'消耗300千卡');
 const hrOnly=parseTraining('跑步5km 30分钟 平均心率155')!.run!;
 assert.equal(hrOnly.reportedKcal,undefined);assert.equal(hrOnly.activeKcal,undefined);assert.equal(hrOnly.totalKcal,undefined);
 const kj=parseTraining('跑步5km 30分钟 活动热量1255.2kJ')!.run!;assert.ok(Math.abs(kj.activeKcal!-300)<1e-8);assert.match(kj.calorieLabel!,/1255.2kJ/);
});
test('elapsed-only time is not relabelled moving time and minutes in pace are not duration',()=>{
 const run=parseTraining('跑步5km 总时长35分钟 配速6分/公里')!.run!;
 assert.equal(run.elapsedMinutes,35);assert.equal(run.minutes,undefined);assert.equal(run.paceSecondsPerKm,360);
 const noKm=parseTraining('跑步 运动时长30分钟，活动热量300千卡')!.run!;
 assert.equal(noKm.km,undefined);assert.equal(noKm.minutes,30);assert.equal(noKm.activeKcal,300);
});
test('daily summary distinguishes full/partial coverage and does not conflate running steps',()=>{
 assert.deepEqual(parseDailyActivity('全天步数12,000步，步行距离8公里'),{steps:12000,scope:'all',coverage:'full',walkingKm:8});
 assert.deepEqual(parseDailyActivity('截至18:00今日步数8000'),{steps:8000,scope:'all',coverage:'partial',asOf:'18:00'});
 assert.equal(parseDailyActivity('今天步数5000')?.coverage,'partial');
 assert.equal(parseDailyActivity('昨天步数5000')?.coverage,'full');
 assert.equal(parseDailyActivity('全天非跑步步数6000')?.scope,'nonTraining');
 assert.equal(parseDailyActivity('跑步5km步数6000'),undefined);
 assert.equal(parseTraining('跑步5km 30分钟\n全天步数12000')!.run?.steps,undefined);
 assert.equal(parseTraining('跑步5km 30分钟\n全天步数12000')!.dailyActivity?.steps,12000);
 assert.equal(localRecordStatus({kind:'note',text:'全天步数8000',body:null}).status,'ready');
});
test('mixed strength duration remains independent from running duration and metric metadata is not an exercise',()=>{
 const a=parseTraining("卧推 50kg 3x8\n力量训练60分钟\n跑步3km 配速6' 用时18分钟\n活动热量200千卡\n平均步频170")!;
 assert.equal(a.training?.durationMinutes,60);assert.equal(a.run?.minutes,18);assert.equal(a.run?.activeKcal,200);assert.equal(a.questions.length,0);
 assert.equal(parseTraining('明天计划跑步5km 30分钟 活动热量300千卡')?.run?.completion,'planned');
});
test('activity validation retains supported values and rejects invalid calorie, cadence and coverage inputs',()=>{
 const a=analysisSchema.parse({summary:'活动',run:{km:5,activeKcal:300,totalKcal:340,elapsedMinutes:35,steps:5000,cadence:170,sourceApp:'Keep',terrain:'level'},dailyActivity:{steps:10000,scope:'all',coverage:'full'}});
 assert.equal(a.run?.activeKcal,300);assert.equal(a.dailyActivity?.steps,10000);
 assert.equal(runSchema.safeParse({activeKcal:-1}).success,false);assert.equal(runSchema.safeParse({cadence:900}).success,false);
 assert.equal(dailyActivitySchema.safeParse({steps:100001,scope:'all',coverage:'full'}).success,false);
 assert.equal(dailyActivitySchema.safeParse({steps:5000,scope:'all',coverage:'unknown'}).success,false);
});
function sse(value:unknown){return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(value)})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:5,output_tokens:5}}})+'\n\n');}
test('note screenshot analysis uses activity prompt and persists original labels through validation',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-activity-extract-'));
 const store=new HealthStore(dir,new FoodCatalog([]),path.join(dir,'inbox'),false);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 store.setSettings({...store.getSettings(),chatgptModel:'test-model'});
 const record=store.importEnvelope({version:1,id:randomUUID(),kind:'note',occurredAt:'2026-10-28T18:00:00+08:00',text:'日常活动截图',attachments:[{name:'activity.png',mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGqoAAAAASUVORK5CYII='}]}).record;
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.match(body.instructions,/这是活动截图或日常笔记/);assert.match(body.instructions,/coverage=partial/);assert.match(body.instructions,/模型不得计算或补造热量/);assert.equal(body.input[0].content[1].type,'input_image');return sse({summary:'日常活动和跑步截图',questions:[],assumptions:[],dailyActivity:{steps:12000,scope:'all',coverage:'partial',asOf:'18:00',sourceApp:'Keep'},run:{km:5,minutes:30,reportedKcal:300,calorieLabel:'消耗300千卡',completion:'completed'}});};
 const secrets:SecretStorage={read:async()=>({}),write:async()=>{}};
 await new AssistantService(store,{accessToken:async()=> 'test-token'} as ChatGPTAuth,secrets,()=>{}).analyze([record.id]);
 const saved=store.record(record.id).analysis!;assert.equal(saved.dailyActivity?.coverage,'partial');assert.equal(saved.run?.reportedKcal,300);assert.equal(saved.run?.activeKcal,undefined);
});

test('manual corrections and explicit clears survive reanalysis and caption edits',t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-activity-override-'));
 const store=new HealthStore(dir,new FoodCatalog([]),path.join(dir,'inbox'),false);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let record=store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:'2026-10-28T18:00:00+08:00',text:'卧推 50kg 3x8\n力量训练60分钟\n跑步5km 30分钟 活动热量300千卡'}).record;
 record=store.updateActivity({id:record.id,revision:record.revision,run:{activeKcal:280},trainingMinutes:null});
 assert.equal(record.analysis?.run?.activeKcal,280);assert.equal(record.analysis?.training?.durationMinutes,undefined);
 record=store.applyAnalysis(record.id,{summary:'重提取',sets:record.analysis?.sets,training:{part:'chest',completion:'completed',durationMinutes:60},run:{km:5,minutes:30,activeKcal:310,completion:'completed'}},'deepseek',record.revision);
 assert.equal(record.analysis?.run?.activeKcal,280);assert.equal(record.analysis?.training?.durationMinutes,undefined);assert.ok(record.analysis?.activityOverrides?.cleared?.includes('training.durationMinutes'));
 record=store.revise(record.id,{text:'备注：操场跑步结果，数据见图'},record.revision);
 assert.equal(record.analysis?.activityOverrides?.run?.activeKcal,280);
 assert.ok(record.analysis?.activityOverrides?.cleared?.includes('training.durationMinutes'));
 record=store.applyAnalysis(record.id,{summary:'修改备注后重提取',training:{part:'chest',completion:'completed',durationMinutes:65},run:{km:5,minutes:30,activeKcal:320,completion:'completed'}},'deepseek',record.revision);
 assert.equal(record.analysis?.run?.activeKcal,280);assert.equal(record.analysis?.training?.durationMinutes,undefined);
 record=store.updateActivity({id:record.id,revision:record.revision,run:{activeKcal:null},trainingMinutes:45});
 record=store.applyAnalysis(record.id,{summary:'再次提取',training:{part:'chest',completion:'completed',durationMinutes:70},run:{km:5,minutes:30,activeKcal:350,completion:'completed'}},'deepseek',record.revision);
 assert.equal(record.analysis?.run?.activeKcal,undefined);assert.equal(record.analysis?.training?.durationMinutes,45);
});
test('model output cannot manufacture or replace persisted manual overrides',t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'bodyjournal-activity-model-override-'));
 const store=new HealthStore(dir,new FoodCatalog([]),path.join(dir,'inbox'),false);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let record=store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:'2026-10-28T18:00:00+08:00',text:'跑步5km 30分钟'}).record;
 record=store.applyAnalysis(record.id,{summary:'识别',run:{km:5,minutes:30,activeKcal:300},activityOverrides:{run:{activeKcal:900},cleared:['run.km']}},'deepseek',record.revision);
 assert.equal(record.analysis?.run?.activeKcal,300);assert.equal(record.analysis?.run?.km,5);assert.equal(record.analysis?.activityOverrides,undefined);
 record=store.updateActivity({id:record.id,revision:record.revision,run:{activeKcal:280}});
 record=store.applyAnalysis(record.id,{summary:'识别',run:{km:5,minutes:30,activeKcal:310},activityOverrides:{run:{activeKcal:900}}},'deepseek',record.revision);
 assert.equal(record.analysis?.run?.activeKcal,280);assert.equal(record.analysis?.activityOverrides?.run?.activeKcal,280);
});

test('fractional reported strength durations are retained independently of running',()=>{
 const a=parseTraining("卧推 50kg 3x8\n力量训练60.5分钟\n跑步5km 用时30分钟")!;
 assert.equal(a.training?.durationMinutes,60.5);assert.equal(a.run?.minutes,30);
});

test('a duration-only strength log is usable and a planned run does not cancel completed strength',()=>{
 const strength=parseTraining('力量训练42.5分钟')!;
 assert.equal(strength.training?.durationMinutes,42.5);assert.equal(strength.training?.completion,'completed');assert.equal(strength.sets?.length,0);
 const mixed=parseTraining('力量训练42.5分钟\n计划跑步5km 配速6分/公里')!;
 assert.equal(mixed.training?.completion,'completed');assert.equal(mixed.run?.completion,'planned');
});

test('step goals stay out of actual activity and training envelopes can hold daily reports',()=>{
 assert.equal(parseDailyActivity('计划全天步数10000步'),undefined);
 assert.equal(parseDailyActivity('目标步数10000步'),undefined);
 assert.equal(parseDailyActivity('今天步数目标10000步'),undefined);
 const report=parseTraining('全天步数8000步')!;
 assert.equal(report.dailyActivity?.steps,8000);assert.equal(report.dailyActivity?.coverage,'full');assert.equal(report.run,undefined);
});
