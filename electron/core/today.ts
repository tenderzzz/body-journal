import type {HealthStore} from './store';
import type {HealthRecord,TodaySummary} from '../../src/shared/types';
import {addCalendarDays,dayBounds,journalDay} from '../../src/shared/dates';
import {inferSession,runCompletion,trainingProgress} from '../../src/shared/exercises';
import {computeStats} from '../../src/shared/stats';
import {weightWeek} from './energy-store';

export function todaySummary(store:HealthStore,now=new Date()):TodaySummary {
  const timezone=store.getSettings().timezone,date=journalDay(now.toISOString(),timezone);
  const bounds=dayBounds(date,date,timezone);
  const split=store.trainingSplit(),rules=store.exerciseRules();
  const select='SELECT r.doc FROM records_lookup l JOIN records r ON r.id=l.id WHERE l.deleted=0';
  const order=' ORDER BY l.occurred_ms DESC,l.id DESC';
  let progress:ReturnType<typeof trainingProgress>|undefined;
  let reference:TodaySummary['reference']=null,foundSession=false;
  let completed:TodaySummary['completed']=null;
  const trainingRows=select+" AND l.occurred_ms<? AND (l.kind='training' OR (l.kind='note' AND l.occurred_ms>=? AND json_type(r.doc,'$.analysis.run')='object'))"+order;
  for(const row of store.db.prepare(trainingRows).iterate(bounds.until,bounds.from)){
    const record=JSON.parse(String(row.doc)) as HealthRecord;
    const day=journalDay(record.occurredAt,timezone);
    if(day<date&&progress&&(foundSession||!progress.next))break;
    const sets=record.analysis?.sets;
    const session=record.analysis?.training??inferSession(record.text,sets);
    const strength=record.kind==='training'&&session.completion==='completed'&&(!!sets?.length||!!record.analysis?.training?.durationMinutes);
    if(day===date&&!completed&&!record.timeSource&&(strength||runCompletion(record)==='completed')){
      completed={id:record.id,part:strength?session.part:'cardio'};
    }
    if(!sets?.length||session.completion==='planned')continue;
    if(!progress){
      progress=record.timeSource?{next:null,lastId:record.id,lastPart:session.part,reason:'最近力量训练的日期待确认'}:trainingProgress([record],split);
    }
    if(!foundSession&&progress.next===session.part&&strength&&!record.timeSource){
      const candidates=Object.values(computeStats([record],timezone,{rules}).exercises).flat();
      const set=candidates.find(s=>s.volume!==null);
      if(set){
        reference={id:record.id,date:day,exercise:set.set.exercise,kg:set.kg!,sets:set.sets,reps:set.reps,basis:set.baselineLabel};
        foundSession=true;
      }
    }
  }
  const meals=store.db.prepare(select+" AND l.kind='meal' AND l.occurred_ms>=? AND l.occurred_ms<?"+order).all(bounds.from,bounds.until).map(row=>JSON.parse(String(row.doc)) as HealthRecord);
  const estimated=meals.filter(r=>r.analysis?.macros&&!r.timeSource);
  const unresolved=meals.filter(r=>!r.analysis?.macros||r.analysis.unmatched?.length||r.timeSource);
  const protein=estimated.length?estimated.reduce((sum,r)=>({low:sum.low+r.analysis!.macros!.protein.low,high:sum.high+r.analysis!.macros!.protein.high}),{low:0,high:0}):null;
  const target=store.energy.targetAt(date)?.protein??null;

  const from=addCalendarDays(date,-14),start=dayBounds(from,from,timezone).from;
  const measured=select+" AND l.kind='body' AND json_extract(r.doc,'$.body.weightKg')>0 AND json_extract(r.doc,'$.timeSource') IS NULL";
  const rows=store.db.prepare(measured+' AND l.occurred_ms>=? AND l.occurred_ms<?'+order).all(start,bounds.until);
  const latest=rows[0]??store.db.prepare(measured+' AND l.occurred_ms<?'+order+' LIMIT 1').get(start);
  const weights=new Map<string,number[]>();
  for(const row of rows){
    const r=JSON.parse(String(row.doc)) as HealthRecord,day=journalDay(r.occurredAt,timezone);
    const group=weights.get(day);
    if(group)group.push(r.body!.weightKg!);
    else weights.set(day,[r.body!.weightKg!]);
  }
  const previous=weightWeek(from,weights),recent=weightWeek(addCalendarDays(date,-7),weights);
  const last=latest&&JSON.parse(String(latest.doc)) as HealthRecord|undefined;
  const rest=store.getConfig<{date:string;timezone:string}>('todayRest');
  return {date,timezone,rest:rest?.date===date&&rest.timezone===timezone,completed,next:progress?.next??null,
    uncertainTrainingId:progress?.reason?progress.lastId:null,reference,
    protein:{target,logged:protein,meals:meals.length,pending:unresolved.length,pendingId:unresolved[0]?.id??null},
    weight:{latest:last?{id:last.id,kg:last.body!.weightKg!,date:journalDay(last.occurredAt,timezone)}:null,
      change:previous.days>=3&&recent.days>=3?Math.round((recent.median!-previous.median!)*10)/10:null}};
}

export function setTodayRest(store:HealthStore,choice:{date:string;timezone:string;rest:boolean},now=new Date()){
  const timezone=store.getSettings().timezone,date=journalDay(now.toISOString(),timezone);
  if(choice.timezone!==timezone||choice.date!==date)throw new Error('手记日或时区已变化，请重新查看今天。');
  store.setConfig('todayRest',choice.rest?{date,timezone}:null);
}
