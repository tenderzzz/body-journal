import { localDay } from '../../src/shared/stats';
export type ResolvedDate = { occurredAt:string; matchedText:string; dateOnly:boolean };
const pad=(n:number)=>String(n).padStart(2,'0');
function validDay(y:number,m:number,d:number){const date=`${y}-${pad(m)}-${pad(d)}`;const value=new Date(`${date}T12:00:00Z`);return Number.isFinite(+value)&&value.toISOString().slice(0,10)===date?date:null;}
function atTime(day:string,hour:number,minute:number,zone:string):string|null {
 const target=Date.parse(`${day}T${pad(hour)}:${pad(minute)}:00Z`);if(!Number.isFinite(target)||hour>23||minute>59)return null;
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 let value=target;
 for(let i=0;i<3;i++){const p=Object.fromEntries(formatter.formatToParts(new Date(value)).map(x=>[x.type,x.value]));const shown=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);const diff=target-shown;if(!diff)return new Date(value).toISOString();value+=diff;}
 return null;
}
/** Only event headings / explicit date corrections. Incidental comparisons and plans do not move records. */
export function resolveRecordDate(text:string,referenceAt:string,zone:string):ResolvedDate|null {
 const today=localDay(referenceAt,zone),year=Number(today.slice(0,4));
 const candidates:{value:ResolvedDate;correction:boolean}[]=[];
 for(const raw of text.split(/\n/)) {
  const line=raw.trim();if(!line||/计划|打算|准备|将于|将要|目标|预计|相比|对比|比较/.test(line))continue;
  const absolute=/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日|号)?/.exec(line);
  const short=absolute?null:/(?<![\d.])(\d{1,2})\s*[月/-]\s*(\d{1,2})(?:日|号)?(?![\d.])/.exec(line);
  const relative=absolute||short?null:/(今天|今日|昨天|昨日|前天)(?=\s|[的，,：:]|训练|练|跑|午餐|晚餐|早餐|早饭|午饭|晚饭|吃|体重|测量)/.exec(line);
  const match=absolute??short??relative;if(!match)continue;
  const prefix=line.slice(0,match.index);
  if(prefix.trim()&&!/^(?:(?:补记|补录|补充|更正|纠正|日期|时间|记录日期|实际日期|发生日期|实际|这次|这条|这顿|其实|是|在|的|训练|记录|餐食|吃饭|测量|[：:,，\s]){1,18})$/.test(prefix))continue;
  let day:string|null=null;
  if(absolute)day=validDay(+absolute[1],+absolute[2],+absolute[3]);
  else if(short){day=validDay(year,+short[1],+short[2]);if(day&&day>today&&+short[1]>=11&&Number(today.slice(5,7))<=2)day=validDay(year-1,+short[1],+short[2]);}
  else {const offset=/前天/.test(match[0])?2:/昨天|昨日/.test(match[0])?1:0;day=new Date(Date.parse(`${today}T12:00:00Z`)-offset*86400000).toISOString().slice(0,10);}
  if(!day||day>today)continue;
  const tail=line.slice(match.index+match[0].length);
  if(short&&/^\s*(?:kg|g|克|公斤|千克|斤|cm|厘米|组|次|%|[×*x])/i.test(tail))continue;
  const clock=/^\s*(?:[T，,：:]\s*)?(?:(上午|下午|晚上|中午)\s*)?(\d{1,2})[:：](\d{2})/.exec(tail);
  let hour=clock?+clock[2]:12;if(clock&&/下午|晚上|中午/.test(clock[1]??'')&&hour<12)hour+=12;
  const occurredAt=atTime(day,hour,clock?+clock[3]:0,zone);if(!occurredAt)continue;
  candidates.push({value:{occurredAt,matchedText:line.slice(0,match.index+match[0].length+(clock?.[0].length??0)),dateOnly:!clock},correction:/补充|更正|纠正|实际|其实/.test(prefix)});
 }
 const corrections=candidates.filter(c=>c.correction);if(corrections.length)return corrections.at(-1)!.value;
 return candidates.length&&new Set(candidates.map(c=>localDay(c.value.occurredAt,zone))).size===1?candidates[0].value:null;
}
