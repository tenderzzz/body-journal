import { normalizeSet, inferSession, workSetCount, resolveLoadBasis, EMPTY_RULES, extractRunText } from '../../src/shared/exercises';
import type { Analysis, DailyActivity, HealthRecord, RunEntry, SetEntry } from '../../src/shared/types';
export function parseBody(text: string): { weightKg?: number; waistCm?: number } {
  const w = text.match(/(?:体重|weight)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|公斤|千克|斤)/i);
  const c = text.match(/(?:腰围|waist)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm|厘米)/i);
  const result: { weightKg?: number; waistCm?: number } = {};
  if (w) result.weightKg = Number(w[1]) / (w[2] === '斤' ? 2 : 1);
  if (c) result.waistCm = Number(c[1]);
  return result;
}
/** Daily summaries are cumulative reports, never a sum of screenshots. */
export function parseDailyActivity(text:string):DailyActivity|undefined {
 const explicit=/(?:全天|全日|今日|今天|昨日|昨天|非跑步|非训练|日常)(?:的)?(?:累计)?(?:非跑步|非训练)?步数\s*[:：]?\s*([\d,，]+)\s*步?/.exec(text)??/(?:全天|全日|今日|今天|昨日|昨天|非跑步|非训练)(?:累计)?\s*([\d,，]+)\s*步/.exec(text);
 const generic=!/跑步|跑步机|慢跑|跑了/.test(text)?/(?:步数\s*[:：]?\s*([\d,，]+)|([\d,，]+)\s*步)/.exec(text):null;
 const match=explicit??generic;
 if(match){
  const prefix=text.slice(0,match.index??0).split(/[，,。；;\n]/).at(-1)??'';
  if(/目标|计划|预计|打算/.test(prefix)&&!/实际|累计|已走|完成/.test(prefix))return;
 }
 const distance=text.match(/(?:非跑步|非训练|步行|走路)(?:距离)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:km|公里)/i);
 if(!match&&!distance)return;
 const steps=match?Number((match[1]??match[2]).replace(/[,，]/g,'')):undefined;
 if(steps!==undefined&&(!Number.isFinite(steps)||steps<0||steps>100000))return;
 if(distance&&+distance[1]>200)return;
 const partial=/(?:截至|截止|目前|现在|半天|上午|中午|下午)/.test(text);
 const full=!partial&&/(?:全天|全日|最终|已记齐|记齐了|昨日|昨天)/.test(text);
 const scope=/非跑步|非训练|不含跑步|排除跑步/.test(text)?'nonTraining':'all';
 const asOf=text.match(/(?:截至|截止)\s*((?:\d{1,2}[:：]\d{2})|[^，,。；;\n步数]{1,20})/);
 return {...(steps!==undefined?{steps}:{}),scope,coverage:full?'full':'partial',...(distance?{walkingKm:+distance[1]}:{}),...(asOf?{asOf:asOf[1]}:{}),...(activitySource(text)?{sourceApp:activitySource(text)}:{})};
}
function activitySource(text:string):string|undefined {
 const source=text.match(/(?:来源|App|应用)\s*[:：]\s*([^，,。；;\n]{1,60})/i)?.[1]?.trim();
 return source??text.match(/\b(?:Keep|Nike Run Club|NRC|Strava|Garmin|COROS)\b|咕咚|悦跑圈|华为运动健康|小米运动健康|小米运动|苹果健康|Apple Health/i)?.[0];
}
function reportedRun(text:string):Partial<RunEntry> {
 const value=(labels:string,units='(kcal|千卡|大卡|卡路里|kJ|千焦)')=>text.match(new RegExp('(?:'+labels+')\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*'+units,'i'));
 const kcal=(m:RegExpMatchArray)=>Number(m[1])/( /^(?:kJ|千焦)$/i.test(m[2])?4.184:1);
 const active=value('活动(?:热量|能量|消耗)|动态(?:热量|能量|消耗)|运动活动热量');
 const total=value('总(?:热量|能量|消耗)|总共消耗');
 const generic=!active&&!total?value('消耗(?:热量)?|热量|卡路里'):null;
 const step=text.match(/(?<!全天|今日|今天|非训练|非跑步)(?:跑步步数|运动步数|步数)\s*[:：]?\s*([\d,，]+)/);
 const cadence=text.match(/(?:平均步频|均步频|步频)\s*[:：]?\s*(\d+(?:\.\d+)?)/);
 const sourceApp=activitySource(text),sourceId=text.match(/(?:运动编号|训练编号|活动ID|运动ID)\s*[:：]?\s*([a-zA-Z0-9_-]+)/i)?.[1];
 const hr=text.match(/(?:平均心率|均心率|心率)\s*[:：]?\s*(\d{2,3})/);
 return {...(active?{activeKcal:kcal(active)}:{}),...(total?{totalKcal:kcal(total)}:{}),...(active||total?{calorieLabel:[active?.[0],total?.[0]].filter(Boolean).join('；')}:{}),...(generic?{reportedKcal:kcal(generic),calorieLabel:generic[0]}:{}),...(step?{steps:Number(step[1].replace(/[,，]/g,''))}:{}),...(cadence?{cadence:+cadence[1]}:{}),...(hr?{avgHeartRate:+hr[1]}:{}),...(sourceApp?{sourceApp}:{}),...(sourceId?{sourceId}:{}),...(/坡度|爬升|越野|山地|上坡|下坡/.test(text)?{terrain:'hilly' as const}:/平地|平路/.test(text)?{terrain:'level' as const}:{})};
}
function durationInMinutes(text:string):number|undefined {
 const hms=text.match(/^(\d{1,2}):(\d{2}):(\d{2})/),ms=text.match(/^(\d{1,3}):(\d{2})/);
 if(hms)return +hms[1]*60 + +hms[2] + +hms[3]/60;
 if(ms)return +ms[1] + +ms[2]/60;
 const duration=text.match(/^(?:(\d+(?:\.\d+)?)\s*(?:小时|h)\s*)?(\d+(?:\.\d+)?)\s*(?:分钟|分(?!钟?\/)|min)(?:\s*(\d+(?:\.\d+)?)\s*秒)?/i);
 return duration?+(duration[1]??0)*60 + +duration[2] + +(duration[3]??0)/60:undefined;
}
export function parseTraining(text: string): Analysis | null {
 const sets:SetEntry[]=[],questions:string[]=[],assumptions:string[]=[];
 const ask=(q:string)=>{if(!questions.includes(q)&&questions.length<2)questions.push(q);};
 let lastWeight:number|null=null,lastUnit='kg';
 for(const original of text.split(/\n|[；;]/).map(x=>x.trim()).filter(Boolean)) {
  if(/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日|号)?\s*$/.test(original)||/^(?:胸|背|肩|腿)(?:部|日|训练)?\s*[：:]?$/.test(original)||/^(?:补充|更正|纠正)[：:].*(?:实际|日期|发生|这次是)/.test(original)||/^我(?:不)?(?:喜欢|习惯|偏好|通常|一般|经常)/.test(original))continue;
  if(/^(感受|RPE|RIR|状态|备注|疼痛|恢复)\s*[:：]/i.test(original)){if(sets.length){sets.at(-1)!.effort=original;const rir=original.match(/RIR\s*[:：]?\s*(\d+)/i);if(rir)sets.at(-1)!.rir=+rir[1];if(/疼痛|不适|痛/.test(original))sets.at(-1)!.pain=original;}continue;}
  if(/跑步|跑步机|慢跑|跑了|\d\s*(?:km|公里)/i.test(original))continue;
  if(/^(?:总时长|总用时|运动时长|移动时长|实际运动时长|平均配速|配速|平均心率|均心率|心率|平均步频|步频|活动热量|动态热量|总热量|消耗|热量|步数|来源|App|运动编号|训练编号)\s*[:：]?/i.test(original)||parseDailyActivity(original))continue;
  const line=original.replace(/[*xX×]/g,'×');
  if(/→|递减/.test(line)&&/\d(?:\.\d+)?\s*(?:→)/.test(line)){ask('递减组各档重量、次数以及重复轮数分别是多少？');continue;}
  let m=line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(kg|公斤|千克|lb|磅)\s*(.+)$/i);
  let exercise='',kg:number|null=null,tail='';
  if(m){exercise=m[1];kg=+m[2]*(/lb|磅/i.test(m[3])?.45359237:1);kg=Math.round(kg*1000)/1000;lastWeight=kg;lastUnit=m[3];tail=m[4];}
  else {const bw=line.match(/^(.+?)\s+(\d+\s*(?:组\s*×?\s*\d+\s*次|×\s*\d+)(?:\s*\+.*)?)$/);if(!bw){if(/训练用时|训练时长|力量训练.*分钟/.test(line))continue;ask('有些训练记号还不明确，请补充动作、重量口径和组次数。');continue;}exercise=bw[1];tail=bw[2];}
  const warmup=/热身/.test(exercise+' '+tail);exercise=exercise.replace(/^[\d.、\s]+/,'').replace(/热身(?:组)?|正式(?:组)?/g,'').trim();
  const explicitTotal=/总重|双手合计|两只合计|总负重|合计重量|合计重/.test(original);
  exercise=exercise.replace(/\s*(?:单手|每手|单只|总重|双手合计|两只合计|总负重|合计重量)\s*/g,'').trim();
  const bodyweight=kg===null&&/卷腹|举腿|俯卧撑|引体向上|自重/.test(exercise);
  // 哑铃按单只、杠铃/史密斯按总重、器械按标重；原文明确写总重时保留总重。不再逐条追问哑铃口径。
  const basis:SetEntry['loadBasis']=bodyweight?'bodyweight':resolveLoadBasis(exercise,{loadBasis:'unknown',kg,explicitTotal},EMPTY_RULES,true).loadBasis;
  if(basis==='unknown')ask('这项动作的重量和计重方式是什么？');
  const clean=tail.replace(/(?:RIR|RPE|感受)[:：]?.*$/i,'').replace(/热身(?:组)?|正式(?:组)?/g,'').trim();
  let blocks:{sets:number;reps:number}[]=[];
  const explicit=clean.match(/^(\d+)\s*组\s*×?\s*(\d+)\s*次$|^(\d+)\s*次\s*×?\s*(\d+)\s*组$/);
  if(explicit)blocks=[{sets:+(explicit[1]??explicit[4]),reps:+(explicit[2]??explicit[3])}];
  else if(/^\d+\s*×\s*\d+(?:\s*\+\s*(?:\d+\s*×\s*)?\d+)*$/.test(clean))blocks=clean.split('+').map(b=>{const n=b.trim().split('×').map(Number);return n.length===2?{sets:n[0],reps:n[1]}:{sets:1,reps:n[0]};});
  else {ask('这行组次记号无法确定，请补充“组×次数”。');continue;}
  for(const b of blocks){if(b.sets<1||b.sets>100||b.reps<1||b.reps>200){ask('组数或次数超出可识别范围，请核对原文。');continue;}sets.push(normalizeSet({exercise,kg,reps:b.reps,sets:b.sets,loadBasis:basis,confirmed:basis!=='unknown',setType:warmup?'warmup':'work',...(tail.match(/RIR\s*[:：]?\s*(\d+)/i)?{rir:+tail.match(/RIR\s*[:：]?\s*(\d+)/i)![1]}:{})},[],{text:original,explicitTotal}));}
 }
 const runLines=text.split(/\n|[；;]/),firstRun=runLines.findIndex(line=>/跑步|跑步机|慢跑|跑了/.test(line)||(/^\s*\d+(?:\.\d+)?\s*(?:km|公里)/i.test(line)&&!/步行|走路|骑车|骑行|游泳/.test(line)));
 const runText=extractRunText(text);
 const nextStrength=runLines.findIndex((line,i)=>i>firstRun&&(/力量训练|训练用时|训练时长/.test(line)||/(?:kg|公斤|千克)\s*\d+.*(?:x|×|组)/i.test(line)));
 const runDetails=firstRun<0?'':runLines.slice(firstRun,nextStrength>firstRun?nextStrength:undefined).map(line=>line.replace(/(?:全天|全日|今日|今天|非跑步|非训练)(?:的)?(?:累计)?步数\s*[:：]?\s*[\d,，]+\s*步?/g,'')).join('\n');
 const km=runText.match(/(?:跑步(?:机)?\s*)?(\d+(?:\.\d+)?)\s*(?:km|公里)/i);
 const pace=runText.match(/(\d{1,2})\s*['′’](?:(\d{1,2})\s*["″”])?/),paceLabel=runDetails.match(/(?:平均)?配速\s*[:：]?\s*(\d{1,2})[:：](\d{2})/),paceChinese=runDetails.match(/(?:平均)?配速\s*[:：]?\s*(\d{1,2})\s*分(?:钟)?(?:\s*(\d{1,2})\s*秒)?/);
 const seconds=paceLabel?+paceLabel[1]*60 + +paceLabel[2]:pace?+pace[1]*60 + +(pace[2]??0):paceChinese?+paceChinese[1]*60 + +(paceChinese[2]??0):undefined;
 const moving=runDetails.match(/(?:实际运动时长|移动时长|运动时长|跑步用时|跑步时长)\s*[:：]?\s*([^，,。\n]+)/);
 const elapsed=runDetails.match(/(?:总时长|总用时|经过时长)\s*[:：]?\s*([^，,。\n]+)/);
 const unlabelled=runText.replace(/(?:总时长|总用时|经过时长)\s*[:：]?\s*[^，,。\n]+/g,'').replace(/(?:平均)?配速\s*[:：]?\s*\d{1,2}\s*分(?:钟)?(?:\s*\d{1,2}\s*秒)?(?:\s*\/\s*(?:km|公里))?/gi,'').match(/(?:用时|时长)?\s*(\d+(?:\.\d+)?)\s*(?:分钟|min)/i);
 const minutes=moving?durationInMinutes(moving[1]):unlabelled?+unlabelled[1]:undefined;
 const elapsedMinutes=elapsed?durationInMinutes(elapsed[1]):undefined;
 const run:RunEntry|undefined=firstRun>=0&&(km||minutes||elapsedMinutes)?{...(km?{km:+km[1]}:{}),completion:inferSession(runText).completion,...(minutes?{minutes}:!elapsedMinutes&&seconds&&km?{minutes:Math.round(+km[1]*seconds/60*100)/100}:{}),...(elapsedMinutes?{elapsedMinutes}:{}),...(seconds?{paceSecondsPerKm:seconds}:{}),...reportedRun(runDetails)}:undefined;
 const dailyActivity=parseDailyActivity(text);
 const session=inferSession(text,sets);
 if(!sets.length&&!run&&!session.durationMinutes&&!dailyActivity)return null;
 const work=sets.filter(s=>s.setType!=='warmup');
 const analysis:Analysis={summary:[work.length?`识别 ${new Set(work.map(s=>s.exerciseId)).size} 个动作，共 ${workSetCount(work)} 个非热身组。`:session.durationMinutes?`力量训练 ${session.durationMinutes} 分钟。`:dailyActivity?`日常活动 ${dailyActivity.steps??''} 步。`:'',run?`跑步${run.km?` ${run.km} 公里`:""}${run.minutes?`，用时 ${run.minutes} 分钟`:''}。`:''].join(''),sets,run,...(dailyActivity?{dailyActivity}:{}),questions,assumptions,training:session,engine:'local',at:new Date().toISOString()};
 return analysis;
}
export function splitHistorical(text: string, zone = 'Asia/Shanghai'): { text: string; occurredAt: string; timezone: string }[] {
  const parts: {text:string;occurredAt:string;timezone:string}[]=[];
  let date = ''; let lines: string[]=[];
  const flush=()=>{ if (lines.join('\n').trim()) { if (!date) throw new Error('历史笔记请用 YYYY-MM-DD 单独一行标明每次训练日期。'); parts.push({text:lines.join('\n').trim(), occurredAt: `${date}T12:00:00+08:00`, timezone:zone}); } lines=[]; };
  for (const line of text.split('\n')) { const m=line.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/); if (m) { flush(); date=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; const d=new Date(`${date}T12:00:00+08:00`); if (!Number.isFinite(d.valueOf()) || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)!==date) throw new Error('历史笔记包含不存在的日期。'); } else lines.push(line); }
  flush(); if (!parts.length) throw new Error('没有找到可导入的训练内容。'); return parts;
}
export function localRecordStatus(record: Pick<HealthRecord,'kind'|'text'|'body'>): { analysis:Analysis|null; status:HealthRecord['status'] } {
  if (record.kind==='training') { const a=parseTraining(record.text); return {analysis:a,status:a?(a.questions.length?'needs_info':'ready'):'pending'}; }
  if (record.kind==='body') return {analysis:null,status:record.body && Object.keys(record.body).length?'ready':'needs_info'};
  if (record.kind==='note') {const dailyActivity=parseDailyActivity(record.text);return dailyActivity?{analysis:{summary:`记录日常活动 ${dailyActivity.steps??''} 步（${dailyActivity.coverage==='full'?'全天':'截至目前'}）`,questions:[],assumptions:[],dailyActivity,engine:'local',at:new Date().toISOString()},status:'ready'}:{analysis:null,status:'pending'};}
  return {analysis:null,status:'pending'};
}
