import type {DatabaseSync} from 'node:sqlite';
import type {Memory,Message,HealthRecord} from '../../src/shared/types';
import {localDay} from '../../src/shared/stats';
import {addDays,dateDistance} from '../../src/shared/energy';
import {atTime} from './dates';

export const RECALL_VERSION='recall-v06-1';
export type QueryPeriod={from:string;to:string;asOf:string};
export type RecallQuery={period?:QueryPeriod;clarification?:string;historical:boolean};
export function queryPeriod(text:string,zone:string,now=new Date()):RecallQuery{
  const today=localDay(now.toISOString(),zone),year=Number(today.slice(0,4));
  const dates=[...text.matchAll(/(?:(\d{4})\s*[-/.年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})(?:日|号)?/g)];
  const days:string[]=[];
  for(const m of dates){
    let y=m[1]?+m[1]:year;
    let day=`${y}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
    if(!m[1]&&day>today){y--;day=String(y)+day.slice(4);}
    if(!Number.isFinite(Date.parse(day+'T12:00:00Z'))||new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day)return {historical:false,clarification:'这个日期不存在，请确认要查哪一天。'};
    days.push(day);
  }
  let from=days[0],to=days.at(-1);
  if(days.length>1&&!/到|至|~|～|—/.test(text))return {historical:false,clarification:'你提到了多个日期，要查哪一天，还是比较这几天？'};
  if(!from){
    const relative=text.match(/前天|昨天|昨日|今天|今日/);
    if(relative)from=to=addDays(today,relative[0]==='前天'?-2:/昨/.test(relative[0])?-1:0);
    if(/(?:本|这|上)周/.test(text)){
      const weekday=new Date(today+'T12:00:00Z').getUTCDay();
      from=addDays(today,-((weekday+6)%7)-(/上周/.test(text)?7:0));
      to=/上周/.test(text)?addDays(from,6):today;
    }else if(/上个月|本月|这个月/.test(text)){
      const d=new Date(today.slice(0,7)+'-01T12:00:00Z');if(/上个月/.test(text))d.setUTCMonth(d.getUTCMonth()-1);
      from=d.toISOString().slice(0,10);d.setUTCMonth(d.getUTCMonth()+1);to=addDays(d.toISOString().slice(0,10),-1);if(to>today)to=today;
    }
  }
  if(!from||!to)return {historical:/以前|当时|上次|那周|那天|曾经|过去|历史/.test(text)};
  if(from>to)return {historical:false,clarification:'日期范围的先后顺序不明确，请确认起止日期。'};
  const next=atTime(addDays(to,1),0,0,zone);if(!next)return {historical:false,clarification:'请确认这个日期所在的时区。'};
  return {period:{from,to,asOf:new Date(Math.min(+now,Date.parse(next)-1)).toISOString()},historical:to<today};
}
export function periodBounds(period:QueryPeriod,zone:string){
  const from=atTime(period.from,0,0,zone),until=atTime(addDays(period.to,1),0,0,zone);
  if(!from||!until)throw new Error('无法确定日期边界，请确认时区');return {from:Date.parse(from),until:Date.parse(until)};
}
export function createRecordIndex(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS records_lookup(id TEXT PRIMARY KEY,occurred_ms INTEGER NOT NULL,kind TEXT NOT NULL,deleted INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS records_lookup_date ON records_lookup(occurred_ms,kind,deleted);
    CREATE TRIGGER IF NOT EXISTS records_lookup_insert AFTER INSERT ON records BEGIN
      INSERT OR REPLACE INTO records_lookup VALUES(new.id,CAST(ROUND((julianday(json_extract(new.doc,'$.occurredAt'))-2440587.5)*86400000) AS INTEGER),json_extract(new.doc,'$.kind'),coalesce(json_extract(new.doc,'$.deleted'),0)); END;
    CREATE TRIGGER IF NOT EXISTS records_lookup_update AFTER UPDATE OF doc ON records BEGIN
      INSERT OR REPLACE INTO records_lookup VALUES(new.id,CAST(ROUND((julianday(json_extract(new.doc,'$.occurredAt'))-2440587.5)*86400000) AS INTEGER),json_extract(new.doc,'$.kind'),coalesce(json_extract(new.doc,'$.deleted'),0)); END;
    CREATE TRIGGER IF NOT EXISTS records_lookup_delete AFTER DELETE ON records BEGIN DELETE FROM records_lookup WHERE id=old.id; END;
    INSERT OR REPLACE INTO records_lookup SELECT id,CAST(ROUND((julianday(json_extract(doc,'$.occurredAt'))-2440587.5)*86400000) AS INTEGER),json_extract(doc,'$.kind'),coalesce(json_extract(doc,'$.deleted'),0) FROM records;
    DELETE FROM records_lookup WHERE id NOT IN(SELECT id FROM records);`);
}
export function queryKind(text:string):HealthRecord['kind']|undefined{
  if(/训练|练|动作|肩推|卧推|深蹲|跑步|几组|组数/.test(text))return 'training';
  if(/吃|餐|食物|饮食/.test(text))return 'meal';
  if(/体重|腰围|测量/.test(text))return 'body';
}

export type Episode={id:string;topic:string;quote:string;occurredAt:string;recordedAt:string;expiresAt:string|null;messageId?:string;recordId?:string;recordRevision?:number;condition?:string;status?:'open'|'context'|'resolved';openQuestion?:string;subject?:string};
export function topicOf(text:string){
  if(/训练|健身|练|卧推|肩推|深蹲|哑铃|组次|组数/.test(text))return 'training';
  if(/吃|餐|食物|饮食|蛋白|补剂/.test(text))return 'eating';
  if(/睡|疲劳|疼|不适|恢复/.test(text))return 'health';
  if(/课程|考试|赶课|期中|期末|学业/.test(text))return 'study';
  return undefined;
}
export function temporalScope(quote:string,recordedAt:string,zone:string){
  const now=new Date(recordedAt),q=queryPeriod(quote,zone,now);
  const explicit=!!q.period&&!/以后|从今|今后/.test(quote);
  const occurredAt=explicit?atTime(q.period!.from,0,0,zone)!:recordedAt;
  let until=q.period?.to;
  if(explicit&&/(?:本|这)周/.test(quote))until=addDays(q.period!.from,6);
  if(explicit&&/本月|这个月/.test(quote)){const next=new Date(q.period!.from+'T12:00:00Z');next.setUTCMonth(next.getUTCMonth()+1);until=addDays(next.toISOString().slice(0,10),-1);}
  const expiresAt=explicit?atTime(addDays(until!,1),0,0,zone)!:new Date(+now+7*86400000).toISOString();
  return {occurredAt,expiresAt};
}
export function episodeFrom(text:string,recordedAt:string,zone:string,source:{messageId?:string;recordId?:string;recordRevision?:number},quote?:string):Episode|undefined{
  const statement=quote??text;
  const topic=topicOf(statement);
  const question=/[？?]|吗|如果|假如|要不要|能不能|怎么|如何/.test(statement);
  if(!topic||statement.length>2000||!question&&!(/我|这周|最近|今天|昨天|上个月|以后|最多|分钟|小时|赶课|考试|期中|期末/.test(statement)))return;
  if(quote&&!text.includes(quote))return;
  const scope=temporalScope(statement,recordedAt,zone);
  const occurredAt=scope.occurredAt,expiresAt=queryPeriod(statement,zone,new Date(recordedAt)).period?scope.expiresAt:new Date(Date.parse(recordedAt)+14*86400000).toISOString();
  const condition=/赶课|考试|期中|期末/.test(statement)?'study_busy':undefined;
  const subject=topic==='training'?statement.match(/胸|背|肩|腿|膝|腕/)?.[0]:undefined;
  return {id:`${source.messageId??source.recordId}:${topic}`,topic,quote:statement,occurredAt,recordedAt,expiresAt,...source,condition,status:question?'open':'context',openQuestion:question?statement:undefined,subject};
}

export function sanitizeSource(text:string,blockedQuotes:string[]){
  if(!blockedQuotes.length)return text;
  return text.split(/(?<=[。！？!?；;\n，,])/).filter(part=>{
    const compact=part.replace(/[\s。！？!?；;，,]/g,'');
    return !blockedQuotes.some(q=>{const blocked=q.replace(/[\s。！？!?；;，,]/g,'');return compact.length>1&&(blocked.includes(compact)||compact.includes(blocked));});
  }).join('').trim();
}
export function memoryEvidenceSources(selected:Memory[],messages:Message[]){
  const byId=new Map(messages.map(m=>[m.id,m]));
  return selected.flatMap(m=>(m.evidence??[]).flatMap(e=>{
    const source=e.messageId?byId.get(e.messageId):undefined;
    return source?.role==='user'&&source.text.includes(e.quote)&&e.quote?[{id:source.id,text:e.quote,createdAt:source.createdAt,memoryId:m.id,revision:m.revision??1,startsAt:m.startsAt,expiresAt:m.expiresAt}]:[];
  }));
}
export function habitFamiliarity(memory:Memory,records:HealthRecord[],now:Date){
  const seen=new Map<string,HealthRecord>();
  for(const r of records)if(memory.sourceIds.includes(r.id)&&!r.deleted)seen.set(localDay(r.occurredAt,r.timezone),r);
  const days=[...seen.keys()].sort(),latest=days.at(-1),age=latest?dateDistance(latest,localDay(now.toISOString(),'UTC')):Infinity;
  return {days:days.length,lastSeen:latest,age,level:days.length>=3&&age<=30?'familiar':days.length>=2?'reference':'single',historical:age>30};
}
