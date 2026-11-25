import {EnergyReader} from '../../src/shared/energy-reader';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {HealthStore} from './store';
import type {DailyEnergyInput,EnergyProfile,EnergyTarget,GoalProposal,EnergyReview,EnergyView,EnergyGoal,StepReference,ActivityLevel,EnergyBaselineAnchor,EnergyTrendWeek,DailyEnergyEstimate,EnergyOverview} from '../../src/shared/types';
import {journalDay as localDay,calendarDay,DAY_POLICY_VERSION} from '../../src/shared/dates';
import {addDays,dateDistance,indexEnergyRecords,estimateDay,initialEnergySuggestion,refs,sameRefs,ENERGY_MODEL_VERSION,ENERGY_RECORD_POLICY_VERSION,isEnergyActivityRecord,ACTIVITY_LEVELS,ASSUMED_REFERENCE_STEPS,stepDay,isJournalActivityRecord} from '../../src/shared/energy';
import {daySchema,energyDayInput,energyStepsInput,energyProfileInput,energyTargetInput,energyBackupSchema,energyGoalSchema} from './energy-validation';
const TABLES={profiles:'energy_profiles',targets:'energy_targets',days:'energy_days',proposals:'energy_proposals'} as const;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median=(values:number[])=>{const a=[...values].sort((x,y)=>x-y),n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):null;};
type EnergyRead=ReturnType<EnergyStore['read']>;
export function weightWeek(from:string,weights:Map<string,number[]>){
  const values:number[]=[];
  for(let i=0;i<7;i++){
    const kg=median(weights.get(addDays(from,i))??[]);
    if(kg!==null)values.push(kg);
  }
  return {from,days:values.length,median:median(values)};
}
export class EnergyStore extends EnergyReader{
  mirroring=false;
  constructor(private host:HealthStore){
    super(()=>host.records(),()=>host.getSettings().timezone,digest);
    for(const name of Object.values(TABLES))host.db.exec(`CREATE TABLE IF NOT EXISTS ${name}(id TEXT PRIMARY KEY,doc TEXT NOT NULL)`);
  }
  today(now=new Date()){return localDay(now.toISOString(),this.host.getSettings().timezone);}
  private rows<K extends keyof typeof TABLES,T>(kind:K):T[]{return this.host.db.prepare(`SELECT doc FROM ${TABLES[kind]} ORDER BY rowid`).all().map(r=>JSON.parse(String(r.doc)));}
  private put(kind:keyof typeof TABLES,id:string,value:unknown){this.host.db.prepare(`INSERT INTO ${TABLES[kind]} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc`).run(id,JSON.stringify(value));}
  profiles(){return this.rows<'profiles',EnergyProfile>('profiles');}
  targets(){return this.rows<'targets',EnergyTarget>('targets');}
  proposals(){return this.rows<'proposals',GoalProposal>('proposals');}
  days(){return this.rows<'days',DailyEnergyInput>('days');}
  private fixedAnchor(profile:EnergyProfile,date:string,now:Date):EnergyBaselineAnchor{
    const read=this.read();
    const levels=Object.keys(ACTIVITY_LEVELS) as ActivityLevel[];
    const references=Object.fromEntries(levels.map(activity=>[activity,profile.usualSteps!==undefined
      ?{method:'manual',steps:{low:profile.usualSteps,high:profile.usualSteps},dates:[],sources:[]}
      :this.stepReference(date,read,activity,profile)??{method:'assumed',steps:{...ASSUMED_REFERENCE_STEPS[activity]},dates:[],sources:[]}])) as EnergyBaselineAnchor['references'];
    const factors=Object.fromEntries(levels.map(activity=>[activity,{...ACTIVITY_LEVELS[activity].factor}])) as EnergyBaselineAnchor['factors'];
    const dates=[...new Set(Object.values(references).flatMap(r=>r.dates))];
    return {modelVersion:ENERGY_MODEL_VERSION,capturedAt:now.toISOString(),references,factors,dayEvidence:dates.map(date=>({date,hash:digest(read.inputs.get(date)??null)}))};
  }
  /** Upgrade at the current date without rewriting an older profile or its historical calculations. */
  migrateFixedBaselines(now=new Date()){
    const today=this.today(now),old=this.profileAt(today);if(!old||old.baselineAnchor)return 0;
    const next:EnergyProfile={...old,id:randomUUID(),createdAt:now.toISOString(),effectiveDate:today,
      age:old.age+Math.floor(Math.max(0,dateDistance(old.effectiveDate,today))/365.2425),baselineAnchor:this.fixedAnchor(old,today,now)};
    this.put('profiles',next.id,next);this.invalidate();return 1;
  }
  private transact<T>(fn:()=>T):T{const db=this.host.db,outer=db.isTransaction;if(!outer)db.exec('BEGIN IMMEDIATE');try{const r=fn();if(!outer)db.exec('COMMIT');return r;}catch(e){if(!outer)db.exec('ROLLBACK');throw e;}}
  saveProfile(value:unknown,now=new Date()){
    const p=energyProfileInput.parse(value);if(p.effectiveDate>this.today(now))throw new Error('计算资料不能在未来生效');
    const profile:EnergyProfile={...p,id:randomUUID(),createdAt:now.toISOString()};
    profile.baselineAnchor=this.fixedAnchor(profile,p.effectiveDate,now);
    this.put('profiles',profile.id,profile);this.invalidate();return profile;
  }
  saveSteps(value:unknown,now=new Date()){
    const p=energyStepsInput.parse(value),zone=this.host.getSettings().timezone;
    if(p.timezone!==zone)throw new Error('档案时区已变化，请重新打开步数记录。');
    if(p.date>calendarDay(now.toISOString(),zone))throw new Error('请选择今天或之前的日期。');
    const read=this.read(),estimate=this.day(p.date,read),previous=read.inputs.get(p.date);
    return this.saveDay({...previous,date:p.date,steps:p.steps,stepsScope:'all',stepCoverage:p.coverage??(p.date<calendarDay(now.toISOString(),zone)?'full':'partial'),
      walkingKm:undefined,stepSourceId:undefined,mealComplete:p.date<=this.today(now)&&estimate.mealConfirmed,activityComplete:p.date<=this.today(now)&&estimate.activityConfirmed},now);
  }
  saveDay(value:unknown,now=new Date()){
    const p=energyDayInput.parse(value),zone=this.host.getSettings().timezone;
    if(p.date>calendarDay(now.toISOString(),zone))throw new Error('不能确认未来日期已经记齐');
    if(p.date>this.today(now)&&(p.mealComplete||p.activityComplete))throw new Error('这个手记日尚未开始，请只保存自然日步数');
    const all=this.host.records();
    const records=all.filter(r=>localDay(r.occurredAt,zone)===p.date);
    const stepRecords=all.filter(r=>stepDay(r,zone)===p.date);
    if(p.stepSourceId&&!stepRecords.some(r=>r.id===p.stepSourceId&&r.analysis?.dailyActivity))throw new Error('步数来源不存在或日期不一致，请重新选择');
    if(p.excludedWorkoutIds?.some(id=>!records.some(r=>r.id===id&&isEnergyActivityRecord(r))))throw new Error('待排除训练不存在或日期不一致');
    if(p.distinctWorkoutPairs?.flat().some(id=>!records.some(r=>r.id===id&&isEnergyActivityRecord(r))))throw new Error('要核对的训练不存在或日期不一致');
    const input:DailyEnergyInput={...p,timezone:zone,dayPolicy:DAY_POLICY_VERSION,stepSources:refs(stepRecords.filter(r=>!!r.analysis?.dailyActivity)),mealSources:refs(records.filter(r=>r.kind==='meal')),activitySources:refs(records.filter(isJournalActivityRecord)),updatedAt:now.toISOString()};
    this.put('days',`${zone}:${p.date}`,input);this.invalidate();return input;
  }
  saveTarget(value:unknown,now=new Date()){
    const p=energyTargetInput.parse(value),today=this.today(now);
    if(p.effectiveDate<today)throw new Error('饮食目标从今天或未来生效，不改写历史');
    if(p.origin==='initial'&&!this.profileAt(today)?.generalAdult)throw new Error('请先确认适用的一般成年健身资料');
    const current=this.targetAt(today);
    if(p.effectiveDate===today&&current&&p.mode===current.mode&&p.kcal===current.kcal&&p.protein===current.protein){this.transact(()=>{this.cancelFutureTargets(now);this.syncTarget(now);this.invalidate();});return current;}
    const target:EnergyTarget={...p,id:randomUUID(),createdAt:now.toISOString()};
    this.transact(()=>{this.cancelFutureTargets(now);this.put('targets',target.id,target);this.syncTarget(now);this.invalidate();});return target;
  }
  rememberManualTarget(kcal:number|null,protein:number|null,now=new Date()){
    if(this.mirroring)return;
    const current=this.targetAt(this.today(now));
    if(kcal===null){if(current){this.cancelFutureTargets(now);const cleared={...current,id:randomUUID(),createdAt:now.toISOString(),effectiveDate:this.today(now),origin:'manual' as const,cleared:true,proposalId:undefined};this.put('targets',cleared.id,cleared);this.invalidate();}return;}
    if(current?.kcal===kcal&&current.protein===protein)return;
    this.cancelFutureTargets(now);this.importManualTarget(kcal,protein,now);
  }
  private cancelFutureTargets(now:Date){for(const t of this.targets().filter(t=>!t.undoneAt&&t.effectiveDate>this.today(now))){this.put('targets',t.id,{...t,undoneAt:now.toISOString()});if(t.proposalId){const p=this.proposals().find(p=>p.id===t.proposalId);if(p)this.put('proposals',p.id,{...p,status:'undone'});}}}
  importManualTarget(kcal:number,protein:number|null,now=new Date()){
    const target:EnergyTarget={id:randomUUID(),createdAt:now.toISOString(),effectiveDate:this.today(now),mode:this.targetAt(this.today(now))?.mode??'maintain',kcal,protein,origin:'manual'};
    this.put('targets',target.id,target);this.invalidate();return target;
  }
  syncTarget(now=new Date()){
    const target=this.targetAt(this.today(now));if(!target)return;
    const settings=this.host.getSettings();if(settings.goals.kcal===target.kcal&&settings.goals.protein===target.protein)return;
    this.mirroring=true;try{this.host.setSettings({...settings,goals:{...settings.goals,kcal:target.kcal,protein:target.protein}});}finally{this.mirroring=false;}
  }
  hash(from:string,to:string,read=this.read()){
    const key=from+'/'+to,cached=read.hashes.get(key);
    if(cached)return cached;
    const {zone,records,index,profiles,targets,days}=read;
    const earliest=addDays(from,-29),latest=addDays(to,1),inputStart=addDays(from,-28);
    const selected=records.filter(r=>{const d=index.dates.get(r.id)!;return d>=earliest&&d<=latest;});
    const anchors=profiles.flatMap(p=>p.baselineAnchor?[p.baselineAnchor]:[]);
    const anchorIds=new Set(anchors.flatMap(a=>Object.values(a.references).flatMap(r=>r.sources.map(s=>s.id))));
    const anchorDates=new Set(anchors.flatMap(a=>a.dayEvidence?.map(e=>e.date)??[]));
    const anchorRecords=records.filter(r=>anchorIds.has(r.id));
    const priorWeight=index.weights.find(r=>index.dates.get(r.id)!<from);
    const prior=priorWeight&&index.byId.get(priorWeight.id);
    const priorTraining=refs(records.filter(r=>r.kind==='training'&&index.dates.get(r.id)!<from));
    const hash=digest({model:ENERGY_MODEL_VERSION,recordPolicy:ENERGY_RECORD_POLICY_VERSION,dayPolicy:DAY_POLICY_VERSION,zone,records:[...new Map([...selected,...anchorRecords,...(prior?[prior]:[])].map(r=>[r.id,r])).values()].sort((a,b)=>a.id.localeCompare(b.id)).map(r=>{const {analysisError,analysisAttemptedRevision,...evidence}=r;return evidence;}),priorTraining,profiles,targets,days:days.filter(d=>d.timezone===zone&&(anchorDates.has(d.date)||d.date>=inputStart&&d.date<=to))});
    read.hashes.set(key,hash);
    return hash;
  }
  invalidate(){
    let read:EnergyRead|undefined;
    for(const m of this.host.messages()){
      const d=m.energyDependency;
      if(!m.stale&&d&&this.hash(d.from,d.to,read??=this.read())!==d.hash)this.host.putMessage({...m,stale:true});
    }
  }
  review(now=new Date(),read=this.read()):EnergyReview{
    const today=localDay(now.toISOString(),read.zone),to=addDays(today,-1),from=addDays(to,-20),target=this.targetAt(today,read);
    const days=Array.from({length:21},(_,i)=>this.day(addDays(from,i),read));
    const completeDays=days.filter(d=>d.intake.complete).length;
    const weeklyWeights=Array.from({length:3},(_,i)=>weightWeek(addDays(from,i*7),read.weights));
    const reasons:string[]=[];
    if(!target||days.some(d=>d.target?.id!==target.id))reasons.push('同一目标尚未完整执行21天');
    if(completeDays<15)reasons.push(`近21天只有 ${completeDays} 天饮食已记齐，需要至少15天`);
    if(weeklyWeights.some(w=>w.days<3))reasons.push('三周中每周需要至少3个有效体重记录日');
    if(!this.profileAt(today,read)?.generalAdult)reasons.push('未确认适用的一般成年健身资料');
    const adjustment=read.targets.filter(t=>!t.undoneAt&&t.origin==='adjustment'&&t.effectiveDate<=today).at(-1);
    if(adjustment&&dateDistance(adjustment.effectiveDate,today)<14)reasons.push('距离上一次调整生效尚不足14天');
    if(read.targets.some(t=>!t.undoneAt&&t.effectiveDate>today))reasons.push('已有待生效的目标，请先等待生效或撤销');
    return {from,to,eligible:reasons.length===0,reasons,completeDays,weeklyWeights,target};
  }
  trendWeeks(date:string,read=this.read()):EnergyTrendWeek[]{
    return Array.from({length:4},(_,i)=>{
      const from=addDays(date,-27+i*7),to=addDays(from,6),days=Array.from({length:7},(_,j)=>this.day(addDays(from,j),read));
      const weight=weightWeek(from,read.weights);
      const complete=days.filter(d=>d.intake.complete&&d.intake.kcal),sources=new Set<string>();
      for(const d of days){for(const w of d.workouts)sources.add(w.method==='app-active'?'App活动热量':w.method==='app-total'?'App总热量':'MET公式');if(d.walking?.correction)sources.add(`步数参考：${d.walking.reference?.method==='manual'?'手填':d.walking.reference?.method==='history'?'历史快照':'暂定范围'}`);}
      return {from,to,weightDays:weight.days,weightMedian:weight.median,mealCompleteDays:days.filter(d=>d.intake.complete).length,activityCompleteDays:days.filter(d=>d.activityComplete).length,intakeDays:complete.length,
        intakeMean:complete.length?{low:complete.reduce((s,d)=>s+d.intake.kcal!.low,0)/complete.length,high:complete.reduce((s,d)=>s+d.intake.kcal!.high,0)/complete.length}:null,activitySources:[...sources]};
    });
  }
  createProposal(value:unknown,messageId:string,sourceHash:string,now=new Date()){
    const p=z.object({kcal:z.number().int().min(1000).max(6000),reason:z.string().trim().min(1).max(2000)}).parse(value),read=this.read(),review=this.review(now,read);
    if(sourceHash!==this.hash(review.from,this.today(now),read))throw new Error('分析期间能量依据发生变化，请重新提问');
    if(!review.eligible||!review.target)throw new Error('尚不满足数值调整条件，请先补齐记录');
    if(Math.abs(p.kcal-review.target.kcal)>100||p.kcal===review.target.kcal)throw new Error('数值调整应为非零且单次不超过100 kcal');
    const proposal:GoalProposal={...p,id:randomUUID(),createdAt:now.toISOString(),messageId,from:review.from,to:this.today(now),sourceHash,targetId:review.target.id,status:'pending'};
    this.put('proposals',proposal.id,proposal);return proposal;
  }
  applyProposal(id:string,now=new Date()){
    const p=this.proposals().find(p=>p.id===id),read=this.read(),review=this.review(now,read);
    if(!p||p.status!=='pending')throw new Error('建议不存在或已处理');
    if(p.to!==this.today(now)||p.sourceHash!==this.hash(p.from,p.to,read)||!review.eligible||review.target?.id!==p.targetId)throw new Error('建议依据已变化或过期，请重新提问');
    const target:EnergyTarget={id:randomUUID(),createdAt:now.toISOString(),effectiveDate:addDays(this.today(now),1),mode:review.target.mode,kcal:p.kcal,protein:review.target.protein,origin:'adjustment',proposalId:p.id};
    this.transact(()=>{this.put('targets',target.id,target);this.put('proposals',p.id,{...p,status:'applied',appliedTargetId:target.id});this.invalidate();});return target;
  }
  undoTarget(id:string,now=new Date()){
    const target=this.targets().find(t=>t.id===id),latest=this.targets().filter(t=>!t.undoneAt).at(-1);
    if(!target||target.undoneAt||target.id!==latest?.id)throw new Error('只能撤销最近一次尚未被后续目标替代的修改');
    this.transact(()=>{
      // An already effective target remains part of historical comparisons.
      if(target.effectiveDate<this.today(now)){
        const previous=this.targets().filter(t=>!t.undoneAt&&t.id!==id&&t.effectiveDate<=target.effectiveDate).at(-1);
        const restored={...(previous??{...target,cleared:true}),id:randomUUID(),createdAt:now.toISOString(),effectiveDate:this.today(now),origin:'manual' as const,proposalId:undefined};this.put('targets',restored.id,restored);
      }else this.put('targets',id,{...target,undoneAt:now.toISOString()});
      if(target.proposalId){const p=this.proposals().find(p=>p.id===target.proposalId);if(p)this.put('proposals',p.id,{...p,status:'undone'});}
      const active=this.targetAt(this.today(now));
      if(active)this.syncTarget(now);else{this.mirroring=true;try{const s=this.host.getSettings();this.host.setSettings({...s,goals:{...s.goals,kcal:null,protein:null}});}finally{this.mirroring=false;}}
      this.invalidate();
    });
  }
  overview(now=new Date(),selectedDate?:string):EnergyOverview {
    const today=this.today(now),date=selectedDate===undefined?today:daySchema.parse(selectedDate);
    if(date>today)throw new Error('请选择今天或之前的手记日期。');
    const read=this.read(),stepDate=calendarDay(now.toISOString(),read.zone);
    const dates=Array.from({length:7},(_,i)=>addDays(date,i-6));
    const days=dates.map(day=>{
      const estimate=this.day(day,read);
      return {date:day,intake:estimate.intake.kcal,expenditure:estimate.expenditure,mealComplete:estimate.intake.complete};
    });
    const current=this.day(date,read);
    const steps=Array.from({length:7},(_,i)=>{
      const day=addDays(stepDate,i-6),estimate=this.day(day,read),walking=estimate.walking;
      return {date:day,count:walking?.steps??null,scope:walking?.scope,coverage:walking?.coverage,
        conflict:!walking&&estimate.missing.some(reason=>reason.includes('选择步数来源')||reason.includes('步数来源已删除'))};
    });
    return {date,today,stepDate,days,balance:current.balance,balanceState:current.balanceState,activityComplete:current.activityComplete,
      steps};
  }
  view(payload:unknown={},now=new Date()):EnergyView{
    const p=z.object({date:daySchema.optional(),days:z.union([z.literal(7),z.literal(30)]).default(7),mode:energyGoalSchema.optional()}).parse(payload),today=this.today(now),date=p.date??today;
    if(date>calendarDay(now.toISOString(),this.host.getSettings().timezone))throw new Error('请选择今天或之前的日期');
    const read=this.read();
    const selected=this.day(date,read),profile=this.profileAt(today,read),current=this.day(today,read),mode:EnergyGoal=p.mode??this.targetAt(today,read)?.mode??'maintain';
    const initialSuggestion=profile&&current.weight?initialEnergySuggestion({...profile,age:profile.age+Math.floor(Math.max(0,dateDistance(profile.effectiveDate,today))/365.2425)},current.weight,mode):null;
    const review=this.review(now,read);
    const suggestedUsualSteps=this.stepReference(date,read)?.steps.low;
    return {today,sourceLabels:Object.fromEntries(selected.sources.map(s=>{const r=read.index.byId.get(s.id)??this.host.record(s.id);return [s.id,r.text.split('\n')[0]||r.analysis?.summary||'原始记录'];})),stepToday:calendarDay(now.toISOString(),this.host.getSettings().timezone),stepReports:(read.index.civil.get(date)??[]).filter(r=>r.analysis?.dailyActivity).map(r=>read.index.byId.get(r.id)!),currentTarget:this.targetAt(today,read),selected,days:Array.from({length:p.days},(_,i)=>this.day(addDays(date,i-p.days+1),read)),profiles:read.profiles,targets:read.targets,dayInput:read.inputs.get(date)??null,initialSuggestion,review,suggestedUsualSteps,trendWeeks:this.trendWeeks(date,read),proposals:this.proposals().map(p=>({...p,stale:p.status==='pending'&&(p.to!==today||p.sourceHash!==this.hash(p.from,p.to,read))})),sourceHash:this.hash(review.from,today,read)};
  }
  chatContext(question:string,now=new Date(),read=this.read()){
    const today=this.today(now),matched=question.match(/\d{4}-\d{2}-\d{2}/)?.[0],parsed=daySchema.safeParse(matched),date=parsed.success&&parsed.data<=today?parsed.data:today;
    const review=this.review(now,read),from=date<review.from?date:review.from,to=today;
    const days=Array.from({length:21},(_,i)=>this.day(addDays(review.from,i),read));
    return {selected:this.day(date,read),currentDate:today,currentTarget:this.targetAt(today,read),generalAdult:this.profileAt(today,read)?.generalAdult??false,days:days.map(d=>({date:d.date,intake:d.intake,expenditure:d.expenditure,target:d.target?.kcal,activityComplete:d.activityComplete,weight:d.weight,sources:d.sources})),review,dependency:{from,to,hash:this.hash(from,to,read)},proposalHash:this.hash(review.from,today,read)};
  }
  export(){return {profiles:this.profiles(),targets:this.targets(),days:this.days(),proposals:this.proposals()};}
  validateBackup(value:unknown){const b=energyBackupSchema.parse(value);for(const key of ['profiles','targets','proposals'] as const){if(new Set(b[key].map(v=>v.id)).size!==b[key].length)throw new Error('能量备份包含重复编号');}if(new Set(b.days.map(d=>`${d.timezone}:${d.date}`)).size!==b.days.length)throw new Error('能量备份包含重复日期');return b;}
  restore(value:unknown){const b=this.validateBackup(value);for(const name of Object.values(TABLES))this.host.db.exec(`DELETE FROM ${name}`);for(const key of ['profiles','targets','proposals'] as const)for(const value of b[key])this.put(key,value.id,value);for(const value of b.days)this.put('days',`${value.timezone}:${value.date}`,value);}
}
