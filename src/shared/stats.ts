import { normalizeSet, baselineKey, baselineLabel, inferSession, workSetCount, EMPTY_RULES, runCompletion } from './exercises';
import type { HealthRecord, Memory, SetEntry, ExerciseRules } from './types';
const dayFormatters=new Map<string,Intl.DateTimeFormat>();
export function localDay(iso:string, zone='Asia/Shanghai') {let formatter=dayFormatters.get(zone);if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});if(dayFormatters.size>=32)dayFormatters.clear();dayFormatters.set(zone,formatter);}return formatter.format(new Date(iso)); }
export function validMemory(m:Memory, now=new Date()) { return m.active && !m.stale && Date.parse(m.startsAt)<=now.valueOf() && (!m.expiresAt || Date.parse(m.expiresAt)>now.valueOf()); }
export function computeStats(records:HealthRecord[], zone='Asia/Shanghai', options:{rules?:ExerciseRules}={}) {
  const rules=options.rules??EMPTY_RULES,archived=new Set(rules.archived);
  const active=records.filter(r=>!r.deleted).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const measurements=active.filter(r=>r.kind==='body' && r.body).map(r=>({id:r.id,date:localDay(r.occurredAt,zone),time:r.occurredAt,...r.body}));
  const exercises=new Map<string,{id:string;date:string;kg:number|null;reps:number;sets:number;volume:number|null;basis:string;baseline:string;baselineLabel:string;set:SetEntry}[]>();
  const daily=new Map<string,{date:string;meals:number;estimated:number;unmatched:number;estimatedItems:number;kcal:{low:number;high:number};protein:{low:number;high:number};carbs:{low:number;high:number};fat:{low:number;high:number}}>();
  for(const r of active) {
    const date=localDay(r.occurredAt,zone);
    const training=r.analysis?.training??inferSession(r.text,r.analysis?.sets);
    if(r.kind==='training'&&training.completion==='completed')for(const raw of r.analysis?.sets??[]) {const s=normalizeSet(raw,[],{rules});if(s.setType==='warmup'||archived.has(s.exercise))continue;const key=s.exercise,rows=exercises.get(key)??[];const comparable=s.confirmed&&s.kg!==null&&!['unknown','bodyweight'].includes(s.loadBasis)&&!s.classificationNeeded;rows.push({id:r.id,date,kg:s.kg,reps:s.reps,sets:s.sets,volume:comparable?Math.round(s.kg!*s.reps*s.sets*100)/100:null,basis:s.loadBasis,baseline:baselineKey(s),baselineLabel:baselineLabel(s),set:s});exercises.set(key,rows);}
    if(r.kind==='meal') { const d=daily.get(date)??{date,meals:0,estimated:0,unmatched:0,estimatedItems:0,kcal:{low:0,high:0},protein:{low:0,high:0},carbs:{low:0,high:0},fat:{low:0,high:0}}; d.meals++; if(r.analysis?.macros) { d.estimated++; for(const k of ['kcal','protein','carbs','fat'] as const) {d[k].low+=r.analysis.macros[k].low;d[k].high+=r.analysis.macros[k].high;} } d.unmatched+=r.analysis?.unmatched?.length??0; d.estimatedItems+=r.analysis?.estimatedFoods?.length??0; daily.set(date,d); }
  }
  for(const d of daily.values())for(const k of ['kcal','protein','carbs','fat'] as const){d[k].low=Math.round(d[k].low*10)/10;d[k].high=Math.round(d[k].high*10)/10;}
  const completed=active.filter(r=>r.kind==='training'&&(r.analysis?.sets?.length??0)>0&&(r.analysis?.training??inferSession(r.text,r.analysis?.sets)).completion==='completed');
  const byPart:Record<string,number>={};for(const r of completed){const part=(r.analysis?.training??inferSession(r.text,r.analysis?.sets)).part;byPart[part]=(byPart[part]??0)+1;}
  return { trainingParts:byPart,trainingDetails:completed.map(r=>({id:r.id,date:localDay(r.occurredAt,zone),...r.analysis?.training,workSets:workSetCount(r.analysis?.sets??[]),totalReps:(r.analysis?.sets??[]).filter(s=>s.setType!=='warmup').reduce((n,s)=>n+s.sets*s.reps,0)})),measurements, exercises:Object.fromEntries(exercises), nutrition:[...daily.values()], recordCount:active.length, pending:active.filter(r=>r.status!=='ready').length, trainingSessions:active.filter(r=>r.kind==='training'&&(r.analysis?.sets?.length??0)>0&&(r.analysis?.training??inferSession(r.text,r.analysis?.sets)).completion==='completed').length, runs:active.filter(r=>r.analysis?.run&&runCompletion(r)==='completed').map(r=>({id:r.id,date:localDay(r.occurredAt,zone),...r.analysis!.run!})) };
}

export function needsAnalysis(r:HealthRecord){return !r.deleted&&r.kind!=='body'&&(!!r.analysisPending||r.status==='pending'||(r.kind==='meal'&&!!r.analysis?.unmatched?.length)||(r.status==='needs_info'&&r.analysis?.engine==='local'&&r.analysisPending===undefined));}

export function recentRecordDays(records:HealthRecord[],zone='Asia/Shanghai',now=new Date()) {
 const today=localDay(now.toISOString(),zone);
 return Array.from({length:7},(_,i)=>{const stamp=new Date(Date.parse(`${today}T12:00:00Z`)-(6-i)*86400000);const date=stamp.toISOString().slice(0,10);return {date,day:Number(date.slice(8)),weekday:new Intl.DateTimeFormat('zh-CN',{weekday:'narrow',timeZone:'UTC'}).format(stamp),count:records.filter(r=>!r.deleted&&localDay(r.occurredAt,zone)===date).length};});
}
