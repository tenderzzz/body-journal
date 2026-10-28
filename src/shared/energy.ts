import type {ActivityLevel, DailyEnergyEstimate, DailyEnergyInput, EnergyGoal, EnergyProfile, EnergyTarget, EnergyWorkout, HealthRecord, Range, RunEntry, DailyActivity, WalkingEstimate, ActivityDuplicate, StepReference} from './types';
import {localDay} from './stats';
import {inferSession,runCompletion} from './exercises';

export const ENERGY_MODEL_VERSION='mifflin-compendium2024-steps-v4';
export const ACTIVITY_LEVELS:Record<ActivityLevel,{label:string;factor:Range}>={
  seated:{label:'主要久坐',factor:{low:1.20,high:1.35}},
  walking:{label:'日常走动较多',factor:{low:1.35,high:1.55}},
  physical:{label:'体力活动较多',factor:{low:1.55,high:1.80}}
};
// Product assumptions, not measured personal steps or a published PAL-to-step conversion.
// A range keeps missing personal reference data visible in the resulting estimate.
export const ASSUMED_REFERENCE_STEPS:Record<ActivityLevel,Range>={
  seated:{low:2000,high:4000},walking:{low:5000,high:8000},physical:{low:8000,high:12000}
};
type CompletedRun={run:RunEntry;minutes:number;recordId:string;revision:number;validTiming:boolean};
export const ENERGY_GOALS:Record<EnergyGoal,string>={maintain:'维持',lose:'减脂',gain:'增肌'};
export const mid=(r:Range)=>(r.low+r.high)/2;
export const round50=(n:number)=>Math.round(n/50)*50;
export function addDays(day:string,n:number){return new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
export function dateDistance(a:string,b:string){return Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000);}
export function restingEnergy(weight:number,height:number,age:number,sex:EnergyProfile['sex']){return 10*weight+6.25*height-5*age+(sex==='male'?5:-161);}
export function refs(records:HealthRecord[]){return records.map(r=>({id:r.id,revision:r.revision})).sort((a,b)=>a.id.localeCompare(b.id));}
export function sameRefs(a:{id:string;revision:number}[],b:{id:string;revision:number}[]){return JSON.stringify([...a].sort((x,y)=>x.id.localeCompare(y.id)))===JSON.stringify([...b].sort((x,y)=>x.id.localeCompare(y.id)));}

// Linear interpolation between level-ground speed rows from the 2024 Adult Compendium.
const RUN_ROWS=[ [3.15,3.3],[4.1,6.5],[4.55,7.8],[5.1,8.5],[5.65,9],[6.15,9.3],[6.7,10.5],[7,11],[7.5,11.8],[8,12],[8.6,12.5],[9,13],[9.45,14.8],[10,14.8],[11,16.8],[12,18.5],[13,19.8],[14,23] ];
export function runningMET(paceSeconds:number):Range|null{
  const mph=3600/paceSeconds/1.609344;
  if(!Number.isFinite(mph)||mph<2.6||mph>14.5)return null;
  let value=RUN_ROWS[0][1];
  if(mph>=RUN_ROWS.at(-1)![0])value=RUN_ROWS.at(-1)![1];
  else for(let i=1;i<RUN_ROWS.length;i++)if(mph<=RUN_ROWS[i][0]){
    const [x0,y0]=RUN_ROWS[i-1],[x1,y1]=RUN_ROWS[i];
    value=mph<=x0?y0:y0+(y1-y0)*(mph-x0)/(x1-x0);break;
  }
  return {low:value,high:value};
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

const positive=(n:number|undefined):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const nonnegative=(n:number|undefined):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export const isEnergyActivityRecord=(r:HealthRecord)=>r.kind==='training'||!!r.analysis?.run||!!r.analysis?.sets?.length||!!r.analysis?.training?.durationMinutes||!!r.analysis?.dailyActivity;
const energyRunCompletion=(r:HealthRecord)=>runCompletion(r.kind==='note'?{...r,kind:'training'}:r);
const reportedMinutes=(run:RunEntry)=>positive(run.minutes)?run.minutes:positive(run.km)&&positive(run.paceSecondsPerKm)?run.km*run.paceSecondsPerKm/60:positive(run.elapsedMinutes)?run.elapsedMinutes:undefined;
function sameRun(a:RunEntry,b:RunEntry){
  const am=reportedMinutes(a),bm=reportedMinutes(b);
  return positive(a.km)&&positive(b.km)&&positive(am)&&positive(bm)&&Math.abs(a.km-b.km)<=.01&&Math.abs(am-bm)<=.05;
}
function activityDuplicates(training:HealthRecord[],excluded:Set<string>,distinct:[string,string][]=[]){
  const duplicates:ActivityDuplicate[]=[],skip=new Set<string>(),previous:HealthRecord[]=[];
  const confirmedDifferent=(a:string,b:string)=>distinct.some(([x,y])=>x===a&&y===b||x===b&&y===a);
  for(const r of training){
    if(excluded.has(r.id))continue;
    const run=r.analysis?.run;
    if(!run||energyRunCompletion(r)!=='completed')continue;
    const match=previous.find(p=>{
      const other=p.analysis!.run!;
      const distinctIds=!!run.sourceId&&!!other.sourceId&&run.sourceApp===other.sourceApp&&run.sourceId!==other.sourceId;
      const sameSource=run.sourceId&&run.sourceApp&&run.sourceId===other.sourceId&&run.sourceApp===other.sourceApp;
      const sameAttachment=r.attachments.some(a=>a.sha256&&p.attachments.some(b=>a.sha256===b.sha256));
      return sameSource||(!distinctIds&&sameRun(run,other)&&(sameAttachment||!confirmedDifferent(r.id,p.id)));
    });
    if(match){
      const other=match.analysis!.run!;
      const sameSource=!!run.sourceId&&!!run.sourceApp&&run.sourceId===other.sourceId&&run.sourceApp===other.sourceApp;
      const sameAttachment=r.attachments.some(a=>a.sha256&&match.attachments.some(b=>a.sha256===b.sha256));
      const exact=sameSource||(sameAttachment&&sameRun(run,other));
      duplicates.push({recordId:r.id,duplicateOf:match.id,exact});skip.add(r.id);
    }else previous.push(r);
  }
  const strengths:HealthRecord[]=[];
  for(const r of training){
    if(excluded.has(r.id)||r.analysis?.run||(!r.analysis?.sets?.length&&!positive(r.analysis?.training?.durationMinutes))||r.analysis?.training?.completion==='planned')continue;
    const signature=(record:HealthRecord)=>JSON.stringify({sets:record.analysis?.sets,minutes:record.analysis?.training?.durationMinutes??inferSession(record.text,record.analysis?.sets).durationMinutes});
    const match=strengths.find(p=>signature(r)===signature(p)&&(
      r.attachments.some(a=>a.sha256&&p.attachments.some(b=>a.sha256===b.sha256))||
      (r.attachments.length>0&&p.attachments.length>0&&positive(r.analysis?.training?.durationMinutes)&&!confirmedDifferent(r.id,p.id))));
    if(match){const exact=r.attachments.some(a=>a.sha256&&match.attachments.some(b=>a.sha256===b.sha256));duplicates.push({recordId:r.id,duplicateOf:match.id,exact});skip.add(r.id);}else strengths.push(r);
  }
  return {duplicates,skip};
}
function reportTimestamp(record:HealthRecord){
  const asOf=record.analysis?.dailyActivity?.asOf;
  if(asOf){
    const iso=Date.parse(asOf);
    if(Number.isFinite(iso))return iso;
    const clock=asOf.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if(clock)return Date.parse(record.occurredAt.slice(0,10)+'T'+clock[1].padStart(2,'0')+':'+clock[2]+':'+(clock[3]??'00')+(record.occurredAt.match(/(?:Z|[+-]\d{2}:\d{2})$/)?.[0]??'Z'));
  }
  return Date.parse(record.occurredAt);
}
function walkingEstimate(day:HealthRecord[],runs:CompletedRun[],input:DailyEnergyInput|undefined,profile:EnergyProfile|undefined,weight:number|undefined,missing:string[],assumptions:string[],unresolvedRun:boolean,historyReference?:StepReference):{walking:WalkingEstimate|null;unresolved:boolean}{
  let data:DailyActivity|undefined,source:HealthRecord|undefined,unresolved=false;
  const reports=day.filter(r=>r.analysis?.dailyActivity&&!r.timeSource&&r.status==='ready');
  if(input?.steps!==undefined||input?.walkingKm!==undefined){
    data={steps:input.steps,walkingKm:input.walkingKm,scope:input.stepsScope??'all',coverage:input.stepCoverage??'full'};
  }else if(input?.stepSourceId){
    source=reports.find(r=>r.id===input.stepSourceId);
    data=source?.analysis?.dailyActivity;
    if(!source){missing.push('选用的步数来源已删除或不再有效，请重新选择');unresolved=true;}
  }else{
    const full=reports.filter(r=>r.analysis!.dailyActivity!.coverage==='full');
    const candidates=full.length?full:reports;
    const sources=new Map<string,HealthRecord>();
    for(const r of candidates.sort((a,b)=>reportTimestamp(a)-reportTimestamp(b)||Date.parse(a.capturedAt??a.createdAt)-Date.parse(b.capturedAt??b.createdAt))){
      const d=r.analysis!.dailyActivity!;sources.set(d.sourceApp?.trim().toLowerCase()||`未注明来源:${r.id}`,r);
    }
    const latest=[...sources.values()];
    if(latest.length>1&&latest.some(r=>{
      const a=r.analysis!.dailyActivity!,b=latest[0].analysis!.dailyActivity!;
      return a.steps!==b.steps||a.walkingKm!==b.walkingKm||a.scope!==b.scope;
    })){
      missing.push('活动汇总来源或数值有冲突，请选择步数来源或手动填写');unresolved=true;
    }else{source=latest.at(-1);data=source?.analysis?.dailyActivity;}
  }
  if(!data)return {walking:null,unresolved};
  const walking:WalkingEstimate={steps:data.steps,referenceSteps:profile?.usualSteps,correction:null,source:source?{id:source.id,revision:source.revision}:undefined,coverage:data.coverage,scope:data.scope,deductions:[],basis:''};
  if(data.coverage!=='full'){
    walking.pending='partial';
    walking.basis=`截至${data.asOf??'记录时'}的累计活动，未作为全天步数修正`;
    missing.push('活动截图仅覆盖部分日期，请补充全天数据');return {walking,unresolved:true};
  }
  let steps=data.steps,distance=(data.scope==='nonTraining'||input?.walkingKm!==undefined)?data.walkingKm:undefined;
  // The manual distance field explicitly means non-training walking, independently of total-step scope.
  if(data.scope==='all'&&distance!==undefined)steps=undefined;
  if(data.scope==='all'&&nonnegative(steps)){
    let runSteps=0,unknown=unresolvedRun;
    for(const entry of runs){
      const source={recordId:entry.recordId,revision:entry.revision};
      if(nonnegative(entry.run.steps)){
        runSteps+=entry.run.steps;walking.deductions!.push({...source,steps:entry.run.steps,method:'reported'});
      }else if(entry.validTiming&&positive(entry.run.cadence)&&(positive(entry.run.minutes)||(positive(entry.run.km)&&positive(entry.run.paceSecondsPerKm)))){
        const minutes=entry.run.minutes??entry.run.km!*entry.run.paceSecondsPerKm!/60,steps=entry.run.cadence*minutes;
        runSteps+=steps;walking.deductions!.push({...source,steps,method:'cadence',cadence:entry.run.cadence,minutes});
        assumptions.push('跑步步数由明确报告的平均步频×运动时长推导，不使用含暂停的总时长。');
      }else unknown=true;
    }
    if(unknown){walking.pending='overlap';walking.basis='全天步数已保存；跑步重叠步数尚不明确，暂沿用日常基线。可补充跑步步数／步频，或直接填写非训练步数。';assumptions.push(walking.basis);return {walking,unresolved};}
    if(runSteps>steps){walking.pending='data';walking.basis='跑步步数大于当天累计步数，暂沿用日常基线';missing.push('跑步步数超过全天步数，请核对统计来源和覆盖范围');return {walking,unresolved:true};}
    steps-=runSteps;
  }
  walking.nonTrainingSteps=steps;
  if(!profile||!positive(weight))return {walking,unresolved};
  if(distance===undefined&&!nonnegative(steps)){walking.pending='data';walking.basis='尚缺可用的非训练步数或步行距离';missing.push(walking.basis);return {walking,unresolved:true};}
  const stride=profile.strideCm!==undefined?{low:profile.strideCm/100,high:profile.strideCm/100}:{low:profile.heightCm*.35/100,high:profile.heightCm*.45/100};
  const reference:StepReference=profile.usualSteps!==undefined
    ?{method:'manual',steps:{low:profile.usualSteps,high:profile.usualSteps},dates:[],sources:[]}
    :historyReference??{method:'assumed',steps:ASSUMED_REFERENCE_STEPS[input?.activity??profile.activity],dates:[],sources:[]};
  walking.reference=reference;walking.referenceSteps=mid(reference.steps);
  let delta:Range;
  if(distance!==undefined){
    walking.distanceKm={low:distance,high:distance};
    delta={low:distance-reference.steps.high*stride.high/1000,high:distance-reference.steps.low*stride.low/1000};
  }else{
    walking.distanceKm={low:steps!*stride.low/1000,high:steps!*stride.high/1000};
    const changes=[steps!-reference.steps.low,steps!-reference.steps.high];
    const distances=changes.flatMap(change=>[change*stride.low/1000,change*stride.high/1000]);
    delta={low:Math.min(...distances),high:Math.max(...distances)};
  }
  walking.correction={low:.5*weight*delta.low,high:.5*weight*delta.high};
  const referenceLabel=reference.method==='manual'?`已填写的平常非训练步数 ${walking.referenceSteps} 步`
    :reference.method==='history'?`此前28天中 ${reference.dates.length} 个完整记录日的非训练步数中位数 ${walking.referenceSteps} 步`
    :`活动档位暂定参考 ${reference.steps.low}–${reference.steps.high} 步（产品假设，尚非个人历史值）`;
  walking.basis=`${referenceLabel}；平地步行净消耗近似0.5×体重×相对参考的距离变化；${profile.strideCm!==undefined?`已核对步长${profile.strideCm}厘米`:'默认步长为身高的0.40倍，范围0.35–0.45倍'}`;
  if(reference.method==='assumed')assumptions.push('历史完整记录不足7天，暂用活动档位对应的参考步数范围；它不是测量值或标准换算，可在计算资料中更正。');
  assumptions.push('步数修正只计入相对平常非训练步行的增减，不再叠加整段步行消耗；步长与平地公式属于估算假设。');
  return {walking,unresolved};
}

export function estimateDay(date:string,timezone:string,records:HealthRecord[],profile:EnergyProfile|undefined,input:DailyEnergyInput|undefined,target:EnergyTarget|null,historyReference?:StepReference):DailyEnergyEstimate{
  const active=records.filter(r=>!r.deleted),day=active.filter(r=>localDay(r.occurredAt,timezone)===date);
  const meals=day.filter(r=>r.kind==='meal'),training=day.filter(r=>r.kind==='training'||!!r.analysis?.run||!!r.analysis?.sets?.length||!!r.analysis?.training?.durationMinutes)
    .sort((a,b)=>Number(!!b.analysis?.activityOverrides)-Number(!!a.analysis?.activityOverrides)||Date.parse(b.updatedAt)-Date.parse(a.updatedAt)||a.id.localeCompare(b.id));
  const activityRecords=day.filter(isEnergyActivityRecord);
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
  const workouts:EnergyWorkout[]=[],completedRuns:CompletedRun[]=[];
  const excluded=new Set(input?.excludedWorkoutIds??[]),{duplicates,skip}=activityDuplicates(training,excluded,input?.distinctWorkoutPairs);
  let unsupported=duplicates.some(d=>!d.exact),unresolvedRun=duplicates.some(d=>!d.exact);
  for(const r of day.filter(r=>r.analysis?.dailyActivity&&r.timeSource)){missing.push(`活动汇总发生日期待确认：${r.id}`);unsupported=true;}
  for(const r of day.filter(r=>r.analysis?.dailyActivity&&r.status!=='ready')){missing.push(`活动汇总尚待分析或核对：${r.id}`);unsupported=true;}
  if(duplicates.some(d=>!d.exact))missing.push('疑似重复的训练尚待核对，暂只计入第一份；请排除重复项，或确认是两次不同训练');
  for(const duplicate of duplicates.filter(d=>d.exact))assumptions.push(`重复训练仅计一次：${duplicate.recordId}，与${duplicate.duplicateOf}同源`);
  for(const r of training){
    if(excluded.has(r.id)){assumptions.push(`已排除当天训练记录：${r.id}`);continue;}
    const a=r.analysis,session=a?.training??inferSession(r.text,a?.sets);
    if(skip.has(r.id)&&!a?.run)continue;
    const rawSession=inferSession(r.text,a?.sets);
    if(r.timeSource){missing.push(`训练发生日期待确认：${r.id}`);unsupported=true;unresolvedRun=!!a?.run||unresolvedRun;continue;}
    if(!a?.sets?.length&&!a?.run&&!positive(a?.training?.durationMinutes)){
      if(a?.dailyActivity)continue;
      missing.push(`训练项目待分析：${r.id}`);unsupported=true;unresolvedRun=true;continue;
    }
    if(!baseline||!profile||!weight)continue;
    // Identical photo copies of a mixed workout must not add its strength component twice either.
    const duplicate=duplicates.find(d=>d.recordId===r.id);
    const sameMixed=duplicate?.exact&&JSON.stringify(a?.sets)===JSON.stringify(training.find(t=>t.id===duplicate.duplicateOf)?.analysis?.sets);
    if((a.sets?.length||positive(a.training?.durationMinutes))&&!sameMixed){
      if(rawSession.completion==='planned'||session.completion==='planned')assumptions.push(`计划力量训练未计入：${r.id}`);
      else if(session.completion!=='completed'||(rawSession.completion!=='completed'&&(/(?:未|没(?:有)?)(?:完成|练完)|取消.{0,8}(?:力量|训练)|未训练/.test(r.text)||!positive(a.training?.durationMinutes)))) {missing.push(`力量训练是否完成待确认：${r.id}`);unsupported=true;}
      else{
        const explicit=a.activityOverrides?.cleared?.includes('training.durationMinutes')?undefined:a.activityOverrides?.training?.durationMinutes??rawSession.durationMinutes??session.durationMinutes;
        const minutes=explicit?{low:explicit,high:explicit}:profile.strengthMinutes;
        workouts.push({recordId:r.id,revision:r.revision,kind:'strength',minutes,met:{low:3.5,high:6},method:'met',extra:workoutExtra(weight.kg,minutes,{low:3.5,high:6},baseline),assumed:!explicit,basis:explicit?'已报告的力量时长；3.5–6.0 MET':'按已确认的常规力量时长估算；3.5–6.0 MET'});
      }
    }
    if(a.run&&!skip.has(r.id)){
      const completion=energyRunCompletion(r);
      if(completion==='planned'){assumptions.push(`计划跑步未计入：${r.id}`);continue;}
      if(completion!=='completed'){missing.push(`跑步是否完成待确认：${r.id}`);unsupported=true;unresolvedRun=true;continue;}
      const run=a.run,minutes=reportedMinutes(run);
      if(!positive(minutes)||minutes>1440){missing.push(`跑步时长不足或超过一天：${r.id}`);unsupported=true;unresolvedRun=true;continue;}
      const validTiming=!(positive(run.elapsedMinutes)&&(run.elapsedMinutes<minutes||run.elapsedMinutes>1440))&&!(positive(run.km)&&positive(run.minutes)&&positive(run.paceSecondsPerKm)&&Math.abs(run.minutes*60/run.km-run.paceSecondsPerKm)/run.paceSecondsPerKm>.05);
      completedRuns.push({run,minutes,recordId:r.id,revision:r.revision,validTiming});
      const pace=positive(run.km)?minutes*60/run.km:run.paceSecondsPerKm;
      if(positive(run.elapsedMinutes)&&run.elapsedMinutes<minutes){missing.push(`跑步总时长短于运动时长：${r.id}`);unsupported=true;continue;}
      if(positive(run.km)&&positive(run.minutes)&&positive(run.paceSecondsPerKm)&&Math.abs(run.minutes*60/run.km-run.paceSecondsPerKm)/run.paceSecondsPerKm>.05){missing.push(`跑步距离、时长与配速相差超过5%，请核对：${r.id}`);unsupported=true;continue;}
      if(nonnegative(run.activeKcal)&&nonnegative(run.totalKcal)&&run.activeKcal>run.totalKcal){missing.push(`跑步活动热量超过总热量：${r.id}`);unsupported=true;continue;}
      const met=pace?runningMET(pace):null,appMinutes={low:minutes,high:run.elapsedMinutes??minutes};
      if(appMinutes.high>1440){missing.push(`跑步总时长超过一天：${r.id}`);unsupported=true;continue;}
      let extra:Range,method:EnergyWorkout['method'],basis:string;
      if(nonnegative(run.activeKcal)){
        extra={low:Math.max(0,run.activeKcal-(baseline.high-resting!)*appMinutes.high/1440),high:Math.max(0,run.activeKcal-(baseline.low-resting!)*appMinutes.low/1440)};
        method='app-active';basis=`${run.sourceApp??'App'}报告活动热量${run.activeKcal} kcal；扣除同期已含的非静息日常基线`;
      }else if(nonnegative(run.totalKcal)){
        extra={low:Math.max(0,run.totalKcal-baseline.high*appMinutes.high/1440),high:Math.max(0,run.totalKcal-baseline.low*appMinutes.low/1440)};
        method='app-total';basis=`${run.sourceApp??'App'}报告总热量${run.totalKcal} kcal；扣除同期日常基线`;
      }else{
        if(run.reportedKcal!==undefined)assumptions.push(`跑步${r.id}保留原报告“${run.calorieLabel??'消耗'} ${run.reportedKcal} kcal”，口径待核对，暂用公式估算。`);
        if(!met){missing.push(`跑步配速不足／超出平地估算范围：${r.id}`);unsupported=true;continue;}
        if(run.terrain==='hilly'){missing.push(`跑步为坡地，平地公式仅作参考，请补充口径明确的App热量：${r.id}`);unsupported=true;}
        extra=workoutExtra(weight.kg,{low:minutes,high:minutes},met,baseline);method='met';basis=`按${Math.round(pace!)}秒/公里在2024平地跑步MET表插值；坡度与地形未单独建模`;
      }
      const energyMinutes=method==='met'?{low:minutes,high:minutes}:appMinutes;
      if(method!=='met'&&appMinutes.high>appMinutes.low)basis+=`；App热量覆盖时长未明，按运动至总时长${appMinutes.low}–${appMinutes.high}分钟范围扣重`;
      const elapsedOnly=!positive(run.minutes)&&!(positive(run.km)&&positive(run.paceSecondsPerKm));
      if(elapsedOnly)basis+='；仅报告总时长，暂作估算时长，运动时长待核对';
      workouts.push({recordId:r.id,revision:r.revision,kind:'run',minutes:energyMinutes,met,method,extra,assumed:elapsedOnly,basis});
    }
  }
  const {walking,unresolved}=walkingEstimate(day,completedRuns,input,profile,weight?.kg,missing,assumptions,unresolvedRun,historyReference);
  unsupported=unsupported||unresolved;
  const tooLong=workouts.reduce((sum,w)=>sum+w.minutes.high,0)>1440;
  if(tooLong){missing.push('当天训练时长合计超过24小时，请核对重复记录或时长');unsupported=true;}
  const dailyBaseline=baseline?{low:Math.max(resting!,baseline.low+(walking?.correction?.low??0)),high:Math.max(resting!,baseline.high+(walking?.correction?.high??0))}:null;
  const expenditure=dailyBaseline&&!tooLong?{low:dailyBaseline.low+workouts.reduce((s,w)=>s+w.extra.low,0),high:dailyBaseline.high+workouts.reduce((s,w)=>s+w.extra.high,0)}:null;
  if(baseline&&resting!==null&&baseline.low+(walking?.correction?.low??0)<resting)assumptions.push('步数调整后的日常消耗下限低于静息参考，已按静息参考截取；请核对平常步数与活动档位是否匹配。');
  const estimated=meals.filter(r=>r.analysis?.macros);
  const sumMacro=(key:'kcal'|'protein'):Range|null=>estimated.length?{low:estimated.reduce((s,r)=>s+r.analysis!.macros![key].low,0),high:estimated.reduce((s,r)=>s+r.analysis!.macros![key].high,0)}:null;
  const foodReady=meals.length>0&&estimated.length===meals.length&&meals.every(r=>r.status==='ready'&&!r.analysis?.unmatched?.length&&!r.timeSource);
  const mealConfirmed=!!input?.mealComplete&&sameRefs(input.mealSources,refs(meals));
  const activityConfirmed=!!input?.activityComplete&&sameRefs(input.activitySources,refs(activityRecords));
  const mealComplete=mealConfirmed&&foodReady;
  const activityComplete=activityConfirmed&&!unsupported;
  if(!mealComplete)missing.push('饮食尚未确认记齐，或存在待分析／修订的餐食');
  if(!activityComplete)missing.push('活动尚未确认记齐，或存在待确认的训练');
  if(profile&&!profile.generalAdult)assumptions.push('当前不属于一般成年健身场景，仅展示记录与估算，不自动提供饮食目标。');
  const protein=sumMacro('protein'),kcal=sumMacro('kcal'),balance=mealComplete&&activityComplete&&kcal&&expenditure?{low:kcal.low-expenditure.high,high:kcal.high-expenditure.low}:null;
  return {date,timezone,modelVersion:ENERGY_MODEL_VERSION,profileId:profile?.id,weight,resting,baseline,dailyBaseline,expenditure,workouts,walking,duplicates,intake:{kcal,protein,meals:meals.length,estimated:estimated.length,complete:mealComplete},mealConfirmed,activityConfirmed,activityComplete,balance,balanceState:balance?(balance.high<0?'deficit':balance.low>0?'surplus':'uncertain'):'incomplete',target,targetDifference:target&&kcal?{low:target.kcal-kcal.high,high:target.kcal-kcal.low}:null,proteinDifference:target?.protein&&protein?{low:target.protein-protein.high,high:target.protein-protein.low}:null,sources:[...new Map([...refs([...day,...(measured&&!day.some(r=>r.id===measured.id)?[measured]:[])]),...(walking?.reference?.sources??[])].map(r=>[r.id,r])).values()],missing,assumptions};
}
