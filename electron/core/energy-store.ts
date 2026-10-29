import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {HealthStore} from './store';
import type {DailyEnergyInput,EnergyProfile,EnergyTarget,GoalProposal,EnergyReview,EnergyView,EnergyGoal,StepReference,ActivityLevel,EnergyBaselineAnchor,EnergyTrendWeek} from '../../src/shared/types';
import {localDay} from '../../src/shared/stats';
import {addDays,dateDistance,estimateDay,initialEnergySuggestion,refs,sameRefs,ENERGY_MODEL_VERSION,isEnergyActivityRecord,ACTIVITY_LEVELS,ASSUMED_REFERENCE_STEPS} from '../../src/shared/energy';
import {daySchema,energyDayInput,energyProfileInput,energyTargetInput,energyBackupSchema,energyGoalSchema} from './energy-validation';
const TABLES={profiles:'energy_profiles',targets:'energy_targets',days:'energy_days',proposals:'energy_proposals'} as const;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median=(values:number[])=>{const a=[...values].sort((x,y)=>x-y),n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):null;};
export class EnergyStore{
  mirroring=false;
  constructor(private host:HealthStore){
    for(const name of Object.values(TABLES))host.db.exec(`CREATE TABLE IF NOT EXISTS ${name}(id TEXT PRIMARY KEY,doc TEXT NOT NULL)`);
  }
  today(now=new Date()){return localDay(now.toISOString(),this.host.getSettings().timezone);}
  private rows<K extends keyof typeof TABLES,T>(kind:K):T[]{return this.host.db.prepare(`SELECT doc FROM ${TABLES[kind]} ORDER BY rowid`).all().map(r=>JSON.parse(String(r.doc)));}
  private put(kind:keyof typeof TABLES,id:string,value:unknown){this.host.db.prepare(`INSERT INTO ${TABLES[kind]} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc`).run(id,JSON.stringify(value));}
  profiles(){return this.rows<'profiles',EnergyProfile>('profiles');}
  targets(){return this.rows<'targets',EnergyTarget>('targets');}
  proposals(){return this.rows<'proposals',GoalProposal>('proposals');}
  days(){return this.rows<'days',DailyEnergyInput>('days');}
  profileAt(date:string){return this.profiles().filter(p=>p.effectiveDate<=date).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate)).at(-1);}
  targetAt(date:string){const t=this.targets().filter(t=>!t.undoneAt&&t.effectiveDate<=date).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate)).at(-1);return t&&!t.cleared?t:null;}
  private inputAt(date:string){return this.days().find(d=>d.date===date&&d.timezone===this.host.getSettings().timezone);}
  private stepReference(date:string,activityOverride?:ActivityLevel,fallbackProfile?:EnergyProfile):StepReference|undefined{
    const records=this.host.records(),zone=this.host.getSettings().timezone,profile=this.profileAt(date)??fallbackProfile;
    if(!profile)return;
    const activity=activityOverride??this.inputAt(date)?.activity??profile.activity;
    const samples=this.days().filter(d=>d.timezone===zone&&d.date<date&&d.date>=addDays(date,-28)&&d.activityComplete).flatMap(input=>{
      const p=this.profileAt(input.date)??fallbackProfile;if(!p||(input.activity??p.activity)!==activity)return [];
      // Call the pure calculation directly: reference extraction must not recursively consume older references.
      const day=estimateDay(input.date,zone,records,p,input,null);
      return day.activityConfirmed&&day.activityComplete&&day.walking?.coverage==='full'&&day.walking.nonTrainingSteps!==undefined&&!day.walking.pending
        ?[{date:input.date,steps:day.walking.nonTrainingSteps,sources:input.activitySources}]:[];
    });
    if(samples.length<7)return;
    const steps=Math.round(median(samples.map(s=>s.steps))!);
    return {method:'history',steps:{low:steps,high:steps},dates:samples.map(s=>s.date).sort(),sources:[...new Map(samples.flatMap(s=>s.sources).map(s=>[s.id,s])).values()]};
  }
  day(date:string){
    daySchema.parse(date);const profile=this.profileAt(date);
    const estimate=estimateDay(date,this.host.getSettings().timezone,this.host.records(),profile,this.inputAt(date),this.targetAt(date),!profile?.baselineAnchor&&profile?.usualSteps===undefined?this.stepReference(date):undefined);
    if(profile?.baselineAnchor?.dayEvidence?.some(e=>digest(this.inputAt(e.date)??null)!==e.hash))estimate.assumptions.push('固定参考采用的历史核对资料已有变化；保留原快照，请核对滚动建议并保存新版资料。');
    return estimate;
  }
  private fixedAnchor(profile:EnergyProfile,date:string,now:Date):EnergyBaselineAnchor{
    const levels=Object.keys(ACTIVITY_LEVELS) as ActivityLevel[];
    const references=Object.fromEntries(levels.map(activity=>[activity,profile.usualSteps!==undefined
      ?{method:'manual',steps:{low:profile.usualSteps,high:profile.usualSteps},dates:[],sources:[]}
      :this.stepReference(date,activity,profile)??{method:'assumed',steps:{...ASSUMED_REFERENCE_STEPS[activity]},dates:[],sources:[]}])) as EnergyBaselineAnchor['references'];
    const factors=Object.fromEntries(levels.map(activity=>[activity,{...ACTIVITY_LEVELS[activity].factor}])) as EnergyBaselineAnchor['factors'];
    const dates=[...new Set(Object.values(references).flatMap(r=>r.dates))];
    return {modelVersion:ENERGY_MODEL_VERSION,capturedAt:now.toISOString(),references,factors,dayEvidence:dates.map(date=>({date,hash:digest(this.inputAt(date)??null)}))};
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
  saveDay(value:unknown,now=new Date()){
    const p=energyDayInput.parse(value),zone=this.host.getSettings().timezone;
    if(p.date>this.today(now))throw new Error('不能确认未来日期已经记齐');
    const records=this.host.records().filter(r=>localDay(r.occurredAt,zone)===p.date);
    if(p.stepSourceId&&!records.some(r=>r.id===p.stepSourceId&&r.analysis?.dailyActivity))throw new Error('步数来源不存在或日期不一致，请重新选择');
    if(p.excludedWorkoutIds?.some(id=>!records.some(r=>r.id===id&&isEnergyActivityRecord(r))))throw new Error('待排除训练不存在或日期不一致');
    if(p.distinctWorkoutPairs?.flat().some(id=>!records.some(r=>r.id===id&&isEnergyActivityRecord(r))))throw new Error('要核对的训练不存在或日期不一致');
    const input:DailyEnergyInput={...p,timezone:zone,mealSources:refs(records.filter(r=>r.kind==='meal')),activitySources:refs(records.filter(isEnergyActivityRecord)),updatedAt:now.toISOString()};
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
  hash(from:string,to:string){
    const zone=this.host.getSettings().timezone,records=this.host.records();
    const selected=records.filter(r=>{const d=localDay(r.occurredAt,zone);return d>=addDays(from,-28)&&d<=to;});
    const anchors=this.profiles().flatMap(p=>p.baselineAnchor?[p.baselineAnchor]:[]);
    const anchorIds=new Set(anchors.flatMap(a=>Object.values(a.references).flatMap(r=>r.sources.map(s=>s.id))));
    const anchorDates=new Set(anchors.flatMap(a=>a.dayEvidence?.map(e=>e.date)??[]));
    const anchorRecords=records.filter(r=>anchorIds.has(r.id));
    const prior=records.filter(r=>r.kind==='body'&&r.body?.weightKg&&!r.timeSource&&localDay(r.occurredAt,zone)<from).sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt))[0];
    const priorTraining=refs(records.filter(r=>r.kind==='training'&&localDay(r.occurredAt,zone)<from));
    return digest({model:ENERGY_MODEL_VERSION,zone,records:[...new Map([...selected,...anchorRecords,...(prior?[prior]:[])].map(r=>[r.id,r])).values()].sort((a,b)=>a.id.localeCompare(b.id)),priorTraining,profiles:this.profiles(),targets:this.targets(),days:this.days().filter(d=>d.timezone===zone&&(anchorDates.has(d.date)||d.date>=addDays(from,-28)&&d.date<=to))});
  }
  invalidate(){for(const m of this.host.messages()){const d=m.energyDependency;if(!m.stale&&d&&this.hash(d.from,d.to)!==d.hash)this.host.putMessage({...m,stale:true});}}
  review(now=new Date()):EnergyReview{
    const to=addDays(this.today(now),-1),from=addDays(to,-20),target=this.targetAt(this.today(now)),records=this.host.records(),zone=this.host.getSettings().timezone;
    const days=Array.from({length:21},(_,i)=>this.day(addDays(from,i)));
    const completeDays=days.filter(d=>d.intake.complete).length;
    const weeklyWeights=Array.from({length:3},(_,i)=>{
      const start=addDays(from,i*7),end=addDays(start,6),daily=new Map<string,number[]>();
      for(const r of records){const date=localDay(r.occurredAt,zone);if(r.kind==='body'&&r.body?.weightKg&&!r.timeSource&&date>=start&&date<=end)daily.set(date,[...(daily.get(date)??[]),r.body.weightKg]);}
      return {from:start,days:daily.size,median:median([...daily.values()].map(v=>median(v)!))};
    });
    const reasons:string[]=[];
    if(!target||days.some(d=>d.target?.id!==target.id))reasons.push('同一目标尚未完整执行21天');
    if(completeDays<15)reasons.push(`近21天只有 ${completeDays} 天饮食已记齐，需要至少15天`);
    if(weeklyWeights.some(w=>w.days<3))reasons.push('三周中每周需要至少3个有效体重记录日');
    if(!this.profileAt(this.today(now))?.generalAdult)reasons.push('未确认适用的一般成年健身资料');
    const adjustment=this.targets().filter(t=>!t.undoneAt&&t.origin==='adjustment'&&t.effectiveDate<=this.today(now)).at(-1);
    if(adjustment&&dateDistance(adjustment.effectiveDate,this.today(now))<14)reasons.push('距离上一次调整生效尚不足14天');
    if(this.targets().some(t=>!t.undoneAt&&t.effectiveDate>this.today(now)))reasons.push('已有待生效的目标，请先等待生效或撤销');
    return {from,to,eligible:reasons.length===0,reasons,completeDays,weeklyWeights,target};
  }
  trendWeeks(date:string):EnergyTrendWeek[]{
    const records=this.host.records(),zone=this.host.getSettings().timezone;
    return Array.from({length:4},(_,i)=>{
      const from=addDays(date,-27+i*7),to=addDays(from,6),days=Array.from({length:7},(_,j)=>this.day(addDays(from,j)));
      const dailyWeights=new Map<string,number[]>();
      for(const r of records){const d=localDay(r.occurredAt,zone);if(r.kind==='body'&&r.body?.weightKg&&!r.timeSource&&d>=from&&d<=to)dailyWeights.set(d,[...(dailyWeights.get(d)??[]),r.body.weightKg]);}
      const complete=days.filter(d=>d.intake.complete&&d.intake.kcal),sources=new Set<string>();
      for(const d of days){for(const w of d.workouts)sources.add(w.method==='app-active'?'App活动热量':w.method==='app-total'?'App总热量':'MET公式');if(d.walking?.correction)sources.add(`步数参考：${d.walking.reference?.method==='manual'?'手填':d.walking.reference?.method==='history'?'历史快照':'暂定范围'}`);}
      return {from,to,weightDays:dailyWeights.size,weightMedian:median([...dailyWeights.values()].map(v=>median(v)!)),mealCompleteDays:days.filter(d=>d.intake.complete).length,activityCompleteDays:days.filter(d=>d.activityComplete).length,intakeDays:complete.length,
        intakeMean:complete.length?{low:complete.reduce((s,d)=>s+d.intake.kcal!.low,0)/complete.length,high:complete.reduce((s,d)=>s+d.intake.kcal!.high,0)/complete.length}:null,activitySources:[...sources]};
    });
  }
  createProposal(value:unknown,messageId:string,sourceHash:string,now=new Date()){
    const p=z.object({kcal:z.number().int().min(1000).max(6000),reason:z.string().trim().min(1).max(2000)}).parse(value),review=this.review(now);
    if(sourceHash!==this.hash(review.from,this.today(now)))throw new Error('分析期间能量依据发生变化，请重新提问');
    if(!review.eligible||!review.target)throw new Error('尚不满足数值调整条件，请先补齐记录');
    if(Math.abs(p.kcal-review.target.kcal)>100||p.kcal===review.target.kcal)throw new Error('数值调整应为非零且单次不超过100 kcal');
    const proposal:GoalProposal={...p,id:randomUUID(),createdAt:now.toISOString(),messageId,from:review.from,to:this.today(now),sourceHash,targetId:review.target.id,status:'pending'};
    this.put('proposals',proposal.id,proposal);return proposal;
  }
  applyProposal(id:string,now=new Date()){
    const p=this.proposals().find(p=>p.id===id),review=this.review(now);
    if(!p||p.status!=='pending')throw new Error('建议不存在或已处理');
    if(p.to!==this.today(now)||p.sourceHash!==this.hash(p.from,p.to)||!review.eligible||review.target?.id!==p.targetId)throw new Error('建议依据已变化或过期，请重新提问');
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
  view(payload:unknown={},now=new Date()):EnergyView{
    const p=z.object({date:daySchema.optional(),days:z.union([z.literal(7),z.literal(30)]).default(7),mode:energyGoalSchema.optional()}).parse(payload),today=this.today(now),date=p.date??today;
    if(date>today)throw new Error('请选择今天或之前的日期');
    const selected=this.day(date),profile=this.profileAt(today),current=this.day(today),mode:EnergyGoal=p.mode??this.targetAt(today)?.mode??'maintain';
    const initialSuggestion=profile&&current.weight?initialEnergySuggestion({...profile,age:profile.age+Math.floor(Math.max(0,dateDistance(profile.effectiveDate,today))/365.2425)},current.weight,mode):null;
    const review=this.review(now);
    const suggestedUsualSteps=this.stepReference(date)?.steps.low;
    return {today,currentTarget:this.targetAt(today),selected,days:Array.from({length:p.days},(_,i)=>this.day(addDays(date,i-p.days+1))),profiles:this.profiles(),targets:this.targets(),dayInput:this.inputAt(date)??null,initialSuggestion,review,suggestedUsualSteps,trendWeeks:this.trendWeeks(date),proposals:this.proposals().map(p=>({...p,stale:p.status==='pending'&&(p.to!==today||p.sourceHash!==this.hash(p.from,p.to))})),sourceHash:this.hash(review.from,today)};
  }
  chatContext(question:string,now=new Date()){
    const today=this.today(now),matched=question.match(/\d{4}-\d{2}-\d{2}/)?.[0],parsed=daySchema.safeParse(matched),date=parsed.success&&parsed.data<=today?parsed.data:today;
    const review=this.review(now),from=date<review.from?date:review.from,to=today;
    const days=Array.from({length:21},(_,i)=>this.day(addDays(review.from,i)));
    return {selected:this.day(date),currentDate:today,currentTarget:this.targetAt(today),generalAdult:this.profileAt(today)?.generalAdult??false,days:days.map(d=>({date:d.date,intake:d.intake,expenditure:d.expenditure,target:d.target?.kcal,activityComplete:d.activityComplete,weight:d.weight,sources:d.sources})),review,dependency:{from,to,hash:this.hash(from,to)},proposalHash:this.hash(review.from,today)};
  }
  export(){return {profiles:this.profiles(),targets:this.targets(),days:this.days(),proposals:this.proposals()};}
  validateBackup(value:unknown){const b=energyBackupSchema.parse(value);for(const key of ['profiles','targets','proposals'] as const){if(new Set(b[key].map(v=>v.id)).size!==b[key].length)throw new Error('能量备份包含重复编号');}if(new Set(b.days.map(d=>`${d.timezone}:${d.date}`)).size!==b.days.length)throw new Error('能量备份包含重复日期');return b;}
  restore(value:unknown){const b=this.validateBackup(value);for(const name of Object.values(TABLES))this.host.db.exec(`DELETE FROM ${name}`);for(const key of ['profiles','targets','proposals'] as const)for(const value of b[key])this.put(key,value.id,value);for(const value of b.days)this.put('days',`${value.timezone}:${value.date}`,value);}
}
