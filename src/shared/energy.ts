import type {ActivityLevel, DailyEnergyEstimate, DailyEnergyInput, EnergyGoal, EnergyProfile, EnergyTarget, EnergyWorkout, HealthRecord, Range} from './types';
import {localDay} from './stats';
import {inferSession,runCompletion} from './exercises';

export const ENERGY_MODEL_VERSION='mifflin-compendium2024-v2';
export const ACTIVITY_LEVELS:Record<ActivityLevel,{label:string;factor:Range}>={
  seated:{label:'主要久坐',factor:{low:1.20,high:1.35}},
  walking:{label:'日常走动较多',factor:{low:1.35,high:1.55}},
  physical:{label:'体力活动较多',factor:{low:1.55,high:1.80}}
};
export const ENERGY_GOALS:Record<EnergyGoal,string>={maintain:'维持',lose:'减脂',gain:'增肌'};
export const mid=(r:Range)=>(r.low+r.high)/2;
export const round50=(n:number)=>Math.round(n/50)*50;
export function addDays(day:string,n:number){return new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
export function dateDistance(a:string,b:string){return Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000);}
export function restingEnergy(weight:number,height:number,age:number,sex:EnergyProfile['sex']){return 10*weight+6.25*height-5*age+(sex==='male'?5:-161);}
export function refs(records:HealthRecord[]){return records.map(r=>({id:r.id,revision:r.revision})).sort((a,b)=>a.id.localeCompare(b.id));}
export function sameRefs(a:{id:string;revision:number}[],b:{id:string;revision:number}[]){return JSON.stringify([...a].sort((x,y)=>x.id.localeCompare(y.id)))===JSON.stringify([...b].sort((x,y)=>x.id.localeCompare(y.id)));}

// Nearest level-ground speed row, 2024 Adult Compendium, codes 12026–12135.
const RUN_ROWS=[ [3.15,3.3],[4.1,6.5],[4.55,7.8],[5.1,8.5],[5.65,9],[6.15,9.3],[6.7,10.5],[7,11],[7.5,11.8],[8,12],[8.6,12.5],[9,13],[9.45,14.8],[10,14.8],[11,16.8],[12,18.5],[13,19.8],[14,23] ];
export function runningMET(paceSeconds:number):Range|null{
  const mph=3600/paceSeconds/1.609344;
  if(!Number.isFinite(mph)||mph<2.6||mph>14.5)return null;
  const row=RUN_ROWS.reduce((a,b)=>Math.abs(b[0]-mph)<Math.abs(a[0]-mph)?b:a);
  return {low:row[1],high:row[1]};
}
export function workoutExtra(weight:number,minutes:Range,met:Range,baseline:Range):Range{
  // Replace the baseline during exercise, rather than adding gross exercise energy twice.
  return {low:Math.max(0,met.low*3.5*weight/200-baseline.high/1440)*minutes.low,
    high:Math.max(0,met.high*3.5*weight/200-baseline.low/1440)*minutes.high};
}
export function initialEnergySuggestion(profile:EnergyProfile,weight:{id:string;kg:number},mode:EnergyGoal){
  if(!profile.generalAdult)return null;
  const resting=restingEnergy(weight.kg,profile.heightCm,profile.age,profile.sex),factor=ACTIVITY_LEVELS[profile.activity].factor;
  const baseline={low:resting*factor.low,high:resting*factor.high};
  const strength=workoutExtra(weight.kg,profile.strengthMinutes,{low:3.5,high:6},baseline);
  const runMet=runningMET(profile.runPace);if(profile.runPerWeek>0&&!runMet)return null;
  const run=workoutExtra(weight.kg,{low:profile.runMinutes,high:profile.runMinutes},runMet??{low:0,high:0},baseline);
  const maintenance={low:baseline.low+(strength.low*profile.strengthPerWeek+run.low*profile.runPerWeek)/7,high:baseline.high+(strength.high*profile.strengthPerWeek+run.high*profile.runPerWeek)/7};
  const kcal=round50(mid(maintenance)*({maintain:1,lose:.90,gain:1.05}[mode]));
  if(kcal<1000||kcal>6000)return null;
  return {maintenance,kcal,protein:profile.strengthPerWeek+profile.runPerWeek>0?Math.round(weight.kg*1.6):null,weightId:weight.id};
}

export function estimateDay(date:string,timezone:string,records:HealthRecord[],profile:EnergyProfile|undefined,input:DailyEnergyInput|undefined,target:EnergyTarget|null):DailyEnergyEstimate{
  const active=records.filter(r=>!r.deleted),day=active.filter(r=>localDay(r.occurredAt,timezone)===date);
  const meals=day.filter(r=>r.kind==='meal'),training=day.filter(r=>r.kind==='training');
  const measurements=active.filter(r=>r.kind==='body'&&r.body?.weightKg&&localDay(r.occurredAt,timezone)<=date&&!r.timeSource).sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
  const measured=measurements[0],weight=measured?{id:measured.id,revision:measured.revision,kg:measured.body!.weightKg!,date:localDay(measured.occurredAt,timezone)}:undefined;
  const missing:string[]=[],assumptions=['活动档位为经验参数，含日常活动与进食相关消耗。','参考区间不是统计置信区间，也不是实测消耗。'];
  if(!profile)missing.push('尚未配置本日期生效的计算资料');
  if(!weight)missing.push('缺少本日期或之前已确认日期的体重');
  if(weight&&dateDistance(weight.date,date)>30)assumptions.push(`体重取自 ${weight.date}，已超过30天，请更新测量。`);
  const age=profile?profile.age+Math.floor(Math.max(0,dateDistance(profile.effectiveDate,date))/365.2425):0;
  const resting=profile&&weight?restingEnergy(weight.kg,profile.heightCm,age,profile.sex):null;
  const factor=ACTIVITY_LEVELS[input?.activity??profile?.activity??'seated'].factor;
  const baseline=resting===null?null:{low:resting*factor.low,high:resting*factor.high};
  const workouts:EnergyWorkout[]=[];
  let unsupported=false;
  for(const r of training){
    const a=r.analysis,session=a?.training??inferSession(r.text,a?.sets);
    const rawSession=inferSession(r.text,a?.sets);
    if(r.timeSource){missing.push(`训练发生日期待确认：${r.id}`);unsupported=true;continue;}
    if(!a?.sets?.length&&!a?.run){missing.push(`训练项目待分析：${r.id}`);unsupported=true;continue;}
    if(!baseline||!profile||!weight)continue;
    if(a.sets?.length){
      if(rawSession.completion!=='completed'||session.completion!=='completed'){
        if(rawSession.completion==='planned'||session.completion==='planned')assumptions.push(`计划力量训练未计入：${r.id}`);
        else {missing.push(`力量训练是否完成待确认：${r.id}`);unsupported=true;}
      }else{
      const explicit=rawSession.durationMinutes??session.durationMinutes;
      const minutes=explicit?{low:explicit,high:explicit}:profile.strengthMinutes;
      workouts.push({recordId:r.id,revision:r.revision,kind:'strength',minutes,met:{low:3.5,high:6},extra:workoutExtra(weight.kg,minutes,{low:3.5,high:6},baseline),assumed:!explicit,basis:explicit?'已报告的力量时长；3.5–6.0 MET':'按已确认的常规力量时长估算；3.5–6.0 MET'});
      }
    }
    if(a.run){
      const completion=runCompletion(r);
      if(completion==='planned'){assumptions.push(`计划跑步未计入：${r.id}`);continue;}
      if(completion!=='completed'){missing.push(`跑步是否完成待确认：${r.id}`);unsupported=true;continue;}
      const run=a.run,minutes=run.minutes??(run.km&&run.paceSecondsPerKm?run.km*run.paceSecondsPerKm/60:undefined);
      const pace=run.km&&minutes?minutes*60/run.km:run.paceSecondsPerKm;
      const met=pace?runningMET(pace):null;
      if(!minutes||!met||minutes>1440){missing.push(`跑步时长或配速不足／超出平地跑步估算范围：${r.id}`);unsupported=true;continue;}
      workouts.push({recordId:r.id,revision:r.revision,kind:'run',minutes:{low:minutes,high:minutes},met,extra:workoutExtra(weight.kg,{low:minutes,high:minutes},met,baseline),assumed:false,basis:`按 ${Math.round(pace!)} 秒/公里匹配2024平地跑步MET；坡度与地形未单独建模`});
    }
  }
  const tooLong=workouts.reduce((sum,w)=>sum+w.minutes.high,0)>1440;
  if(tooLong){missing.push('当天训练时长合计超过24小时，请核对重复记录或时长');unsupported=true;}
  const expenditure=baseline&&!tooLong?{low:baseline.low+workouts.reduce((s,w)=>s+w.extra.low,0),high:baseline.high+workouts.reduce((s,w)=>s+w.extra.high,0)}:null;
  const estimated=meals.filter(r=>r.analysis?.macros);
  const sumMacro=(key:'kcal'|'protein'):Range|null=>estimated.length?{low:estimated.reduce((s,r)=>s+r.analysis!.macros![key].low,0),high:estimated.reduce((s,r)=>s+r.analysis!.macros![key].high,0)}:null;
  const foodReady=meals.length>0&&estimated.length===meals.length&&meals.every(r=>r.status==='ready'&&!r.analysis?.unmatched?.length&&!r.timeSource);
  const mealComplete=!!input?.mealComplete&&foodReady&&sameRefs(input.mealSources,refs(meals));
  const activityComplete=!!input?.activityComplete&&!unsupported&&sameRefs(input.activitySources,refs(training));
  if(input?.steps!==undefined)assumptions.push(`已报告 ${input.steps} 步；仅辅助判断活动档位，不另加步数热量。`);
  if(!mealComplete)missing.push('饮食尚未确认记齐，或存在待分析／修订的餐食');
  if(!activityComplete)missing.push('活动尚未确认记齐，或存在待确认的训练');
  if(profile&&!profile.generalAdult)assumptions.push('当前不属于一般成年健身场景，仅展示记录与估算，不自动提供饮食目标。');
  const protein=sumMacro('protein'),kcal=sumMacro('kcal'),balance=mealComplete&&activityComplete&&kcal&&expenditure?{low:kcal.low-expenditure.high,high:kcal.high-expenditure.low}:null;
  return {date,timezone,modelVersion:ENERGY_MODEL_VERSION,profileId:profile?.id,weight,resting,baseline,expenditure,workouts,intake:{kcal,protein,meals:meals.length,estimated:estimated.length,complete:mealComplete},activityComplete,balance,balanceState:balance?(balance.high<0?'deficit':balance.low>0?'surplus':'uncertain'):'incomplete',target,targetDifference:target&&kcal?{low:target.kcal-kcal.high,high:target.kcal-kcal.low}:null,proteinDifference:target?.protein&&protein?{low:target.protein-protein.high,high:target.protein-protein.low}:null,sources:refs([...day,...(measured&&!day.some(r=>r.id===measured.id)?[measured]:[])]),missing,assumptions};
}
