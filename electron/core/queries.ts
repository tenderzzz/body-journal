import {z} from 'zod';
import type {HealthStore} from './store';
import type {HealthRecord,Message,RecordPage,MessagePage,OverviewSummary} from '../../src/shared/types';
import {daySchema} from './energy-validation';
import {idSchema} from './validation';
import {dayBounds,journalDay,addCalendarDays} from '../../src/shared/dates';
import {computeStats} from '../../src/shared/stats';

export const recordQuerySchema=z.object({
  date:daySchema.optional(),kind:z.enum(['all','meal','training','body','note','needs_info']).default('all'),
  search:z.string().max(1000).default(''),includeDeleted:z.boolean().default(false),
  cursor:z.object({time:z.number().finite(),id:idSchema}).optional(),limit:z.number().int().min(1).max(50).default(50),
}).strict();
export const messageQuerySchema=z.object({history:z.boolean().default(false),before:z.number().int().positive().optional(),limit:z.number().int().min(1).max(30).default(30)}).strict();
export const calendarQuerySchema=z.object({anchor:daySchema}).strict();
export const trendQuerySchema=z.object({days:z.union([z.literal(0),z.literal(7),z.literal(30),z.literal(90)])}).strict();

const pending=`json_extract(doc,'$.kind')!='body' AND (json_extract(doc,'$.analysisPending')=1 OR json_extract(doc,'$.status')='pending' OR (json_extract(doc,'$.kind')='meal' AND coalesce(json_array_length(json_extract(doc,'$.analysis.unmatched')),0)>0) OR (json_extract(doc,'$.status')='needs_info' AND json_extract(doc,'$.analysis.engine')='local' AND json_extract(doc,'$.analysisPending') IS NULL))`;
export class JournalQueries {
  constructor(private store:HealthStore){}
  records(value:unknown={}):RecordPage {
    const p=recordQuerySchema.parse(value),zone=this.store.getSettings().timezone;
    const clauses:string[]=[],args:(number|string)[]=[];
    if(!p.includeDeleted)clauses.push('l.deleted=0');
    if(p.date){const b=dayBounds(p.date,p.date,zone);clauses.push('l.occurred_ms>=? AND l.occurred_ms<?');args.push(b.from,b.until);}
    if(p.kind==='needs_info')clauses.push("json_extract(r.doc,'$.status')='needs_info'");
    else if(p.kind!=='all'){clauses.push('l.kind=?');args.push(p.kind);}
    if(p.search){clauses.push("instr(lower(json_extract(r.doc,'$.text')||' '||coalesce(json_extract(r.doc,'$.analysis.summary'),'')),lower(?))>0");args.push(p.search);}
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
    const base=' FROM records_lookup l JOIN records r ON r.id=l.id';
    const total=Number(this.store.db.prepare('SELECT count(*) AS n'+base+where).get(...args)!.n);
    if(p.cursor){clauses.push('(l.occurred_ms<? OR (l.occurred_ms=? AND l.id<?))');args.push(p.cursor.time,p.cursor.time,p.cursor.id);}
    const pageWhere=clauses.length?' WHERE '+clauses.join(' AND '):'';
    const rows=this.store.db.prepare('SELECT r.doc,l.occurred_ms'+base+pageWhere+' ORDER BY l.occurred_ms DESC,l.id DESC LIMIT ?').all(...args,p.limit+1);
    const items=rows.slice(0,p.limit).map(r=>JSON.parse(String(r.doc)) as HealthRecord),last=items.at(-1);
    return {items,total,next:rows.length>p.limit&&last?{time:Date.parse(last.occurredAt),id:last.id}:undefined};
  }
  messages(value:unknown={}):MessagePage {
    const p=messageQuerySchema.parse(value),clauses:string[]=[],args:(string|number)[]=[];
    if(p.before){clauses.push('rowid<?');args.push(p.before);}
    const since=this.store.getConfig<string>('conversationStart');
    if(!p.history&&since){clauses.push("json_extract(doc,'$.createdAt')>=?");args.push(since);}
    const rows=this.store.db.prepare('SELECT rowid,doc FROM messages'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' ORDER BY rowid DESC LIMIT ?').all(...args,p.limit+1);
    return {items:rows.slice(0,p.limit).reverse().map(r=>JSON.parse(String(r.doc)) as Message),before:rows.length>p.limit?Number(rows[p.limit-1].rowid):undefined};
  }
  calendar(value:unknown) {
    const {anchor}=calendarQuerySchema.parse(value),zone=this.store.getSettings().timezone;
    const b=dayBounds(addCalendarDays(anchor,-49),addCalendarDays(anchor,49),zone),counts:Record<string,number>={};
    for(const r of this.store.db.prepare('SELECT occurred_ms FROM records_lookup WHERE deleted=0 AND occurred_ms>=? AND occurred_ms<?').iterate(b.from,b.until)){
      const day=journalDay(new Date(Number(r.occurred_ms)).toISOString(),zone);counts[day]=(counts[day]??0)+1;
    }
    return counts;
  }
  summary(now=new Date()):OverviewSummary {
    const active="coalesce(json_extract(doc,'$.deleted'),0)=0";
    const counts=this.store.db.prepare(`SELECT count(*) AS total,sum(CASE WHEN ${pending} THEN 1 ELSE 0 END) AS pending,sum(CASE WHEN json_extract(doc,'$.status')='needs_info' AND NOT (${pending}) THEN 1 ELSE 0 END) AS needsInfo,sum(CASE WHEN json_extract(doc,'$.timeSource')='file_modified' THEN 1 ELSE 0 END) AS uncertain FROM records WHERE ${active}`).get()!;
    const row=this.store.db.prepare(`SELECT doc FROM records WHERE ${active} AND json_extract(doc,'$.kind')='body' AND json_extract(doc,'$.body.weightKg') IS NOT NULL ORDER BY json_extract(doc,'$.occurredAt') DESC LIMIT 1`).get();
    const weight=row?JSON.parse(String(row.doc)) as HealthRecord:undefined,zone=this.store.getSettings().timezone,today=journalDay(now.toISOString(),zone),days=this.calendar({anchor:today});
    const week=Array.from({length:7},(_,i)=>{const date=addCalendarDays(today,i-6);return {date,day:Number(date.slice(8)),weekday:new Intl.DateTimeFormat('zh-CN',{weekday:'narrow',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')),count:days[date]??0};});
    return {total:Number(counts.total),pending:Number(counts.pending??0),needsInfo:Number(counts.needsInfo??0),uncertain:Number(counts.uncertain??0),needsInfoId:(this.store.db.prepare("SELECT id FROM records WHERE "+active+" AND json_extract(doc,'$.status')='needs_info' AND NOT ("+pending+") LIMIT 1").get()?.id as string|undefined),uncertainId:(this.store.db.prepare("SELECT id FROM records WHERE "+active+" AND json_extract(doc,'$.timeSource')='file_modified' LIMIT 1").get()?.id as string|undefined),latestWeight:weight?{id:weight.id,time:weight.occurredAt,...weight.body}:undefined,week};
  }
  trends(value:unknown,now=new Date()) {
    const {days}=trendQuerySchema.parse(value),zone=this.store.getSettings().timezone;
    const from=days?dayBounds(addCalendarDays(journalDay(now.toISOString(),zone),1-days),journalDay(now.toISOString(),zone),zone).from:0;
    const records=this.store.db.prepare('SELECT r.doc FROM records_lookup l JOIN records r ON r.id=l.id WHERE l.deleted=0 AND l.occurred_ms>=?').all(from).map(r=>JSON.parse(String(r.doc)) as HealthRecord);
    return computeStats(records,zone,{rules:this.store.exerciseRules()});
  }
}
