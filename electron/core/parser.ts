import {CARDIO_PLAN_HEADING,CARDIO_TEXT,LAND_CARDIO_TEXT,SWIMMING_TEXT,SWIM_STROKE_LABELS,cardioComponent,normalizeCardio,swimmingCompletion} from '../../src/shared/cardio';
import { normalizeSet, inferSession, workSetCount, resolveLoadBasis, EMPTY_RULES, extractRunText } from '../../src/shared/exercises';
import type { Analysis, BodyMeasurement, DailyActivity, HealthRecord, RunEntry, SetEntry } from '../../src/shared/types';
import {detectTrainingNotation,isTrainingNotationLine,expandInlineWeightGroups,type TrainingNotation} from './training-notation';
export function parseBody(text: string): BodyMeasurement {
  const w = text.match(/(?:体重|weight)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|公斤|千克|斤)/i);
  const c = text.match(/(?:腰围|waist)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm|厘米)/i);
  const fat = text.normalize('NFKC').match(/(?:体脂率?|body fat(?: percentage)?)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*%/i);
  const result: BodyMeasurement = {};
  if (w) result.weightKg = Number(w[1]) / (w[2] === '斤' ? 2 : 1);
  if (c) result.waistCm = Number(c[1]);
  if (fat) result.bodyFatPercent = Number(fat[1].replace(',','.'));
  return result;
}
/** Daily summaries are cumulative reports, never a sum of screenshots. */
export function parseDailyActivity(text:string):DailyActivity|undefined {
 const explicit=/(?:全天|全日|今日|今天|昨日|昨天|非跑步|非训练|日常)(?:的)?(?:累计)?(?:非跑步|非训练)?步数\s*[:：]?\s*([\d,，]+)\s*步?/.exec(text)??/(?:全天|全日|今日|今天|昨日|昨天|非跑步|非训练)(?:累计)?\s*([\d,，]+)\s*步/.exec(text);
 const generic=!/跑步|跑步机|慢跑|跑了|爬坡|有氧/.test(text)?/(?:步数\s*[:：]?\s*([\d,，]+)|([\d,，]+)\s*步)/.exec(text):null;
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
 const reportDate=text.match(/步数日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1];
 if(reportDate&&(!Number.isFinite(Date.parse(reportDate))||new Date(reportDate).toISOString().slice(0,10)!==reportDate))return;
 const recordedAt=text.match(/记录时间\s*[:：]\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/)?.[1];
 return {...(reportDate?{reportDate}:{}),...(steps!==undefined?{steps}:{}),scope,coverage:full?'full':'partial',...(distance?{walkingKm:+distance[1]}:{}),...(recordedAt&&Number.isFinite(Date.parse(recordedAt))?{asOf:recordedAt}:asOf?{asOf:asOf[1]}:{}),...(activitySource(text)?{sourceApp:activitySource(text)}:{})};
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
function swimmingDuration(text:string):number|undefined {
 const digits='零一二三四五六七八九';
 const value=text.trim().replace(/两/g,'二').replace(/[零一二三四五六七八九十]+(?=\s*(?:个?[半小]|分钟?))/g,number=>{
  if(!number.includes('十'))return String(digits.indexOf(number));
  const [tens,ones]=number.split('十');
  return String(10*(tens?digits.indexOf(tens):1)+(ones?digits.indexOf(ones):0));
 });
 const hours=value.match(/^(?:(\d+(?:\.\d+)?)\s*个?\s*(半)?\s*(?:小时|h)|(半)\s*个?\s*小时)\s*(?:又?\s*(\d+)\s*(?:分钟|分|min))?/i);
 const minutes=hours?Number(hours[1]??0)*60+(hours[2]||hours[3]?30:0)+Number(hours[4]??0):durationInMinutes(value);
 return minutes&&minutes>0&&minutes<=1440?minutes:undefined;
}

function reportedSwimming(text:string):RunEntry|undefined {
 const fragments=text.normalize('NFKC').replace(/(\d)[,，](?=\d{3}(?:\D|$))/g,'$1').split(/[\n；;。，,]/).map(line=>line.trim());
 const start=fragments.findIndex(line=>SWIMMING_TEXT.test(line)&&!LAND_CARDIO_TEXT.test(line));
 if(start<0)return;
 const nextWorkout=fragments.findIndex((line,i)=>i>start&&(
  LAND_CARDIO_TEXT.test(line)||/^(?:力量训练|力量时长|训练用时|训练时长|骑行|骑车)|\d+\s*(?:kg|公斤|千克)\s*\d+\s*(?:[x×*]|组)/i.test(line)
 ));
 const first=start>0&&CARDIO_PLAN_HEADING.test(fragments[start-1])?start-1:start;
 const swim=fragments.slice(first,nextWorkout<0?undefined:nextWorkout).join('\n');
 const duration=(label:RegExp)=>{
  const match=swim.match(label);
  return match?swimmingDuration(match[1]):undefined;
 };
 const minutes=duration(/(?:实际(?:游泳|游动|游了|运动)(?:时长|用时)?|(?:游动|移动|运动)时长)\s*[:：]?\s*([^\n]+)/);
 const elapsedMinutes=duration(/(?:总时长|总用时|经过时长)\s*[:：]?\s*([^\n]+)/)
  ??duration(/(?<!实际)(?:游泳|游了|蛙泳|自由泳|仰泳|蝶泳|混合泳|swimming)\s*(?:共|约|了|用时|时长)*\s*[:：]?\s*([^\n]+)/i);
 const distance=swim.match(/(?:距离|游了|游泳|蛙泳|自由泳|仰泳|蝶泳|混合泳|swimming)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)(?=$|[^a-zA-Z])/i);
 const km=distance?Number(distance[1])*(/^(?:米|m)$/i.test(distance[2]) ? .001 : 1):undefined;
 const strokes=(Object.entries(SWIM_STROKE_LABELS) as [NonNullable<RunEntry['swimStroke']>,string][]).filter(([,label])=>swim.includes(label));
 const swimStroke=strokes.length>1?'mixed':strokes[0]?.[0];
 const effort=swim.match(/强度\s*[:：]?\s*[^\n]{1,40}/)?.[0]??swim.match(/轻松|低强度|休闲/)?.[0];
 const {activeKcal,totalKcal,reportedKcal,calorieLabel,avgHeartRate,sourceApp,sourceId}=reportedRun(swim);
 const recorded=minutes!==undefined||elapsedMinutes!==undefined||km!==undefined||activeKcal!==undefined||totalKcal!==undefined||/游了|已游|游完|已完成/.test(swim);
 return {activity:'swimming',swimStroke,effort,km:km&&km<=1000?km:undefined,minutes,elapsedMinutes,stepsIncluded:false,
  completion:swimmingCompletion(swim,recorded?'completed':'unknown'),activeKcal,totalKcal,reportedKcal,calorieLabel,avgHeartRate,sourceApp,sourceId};
}

export function parseTraining(text: string,notation:TrainingNotation={}): Analysis | null {
 const convention={...notation,...detectTrainingNotation(text)};
 const swimming=reportedSwimming(text);
 const sets:SetEntry[]=[],questions:string[]=[],assumptions:string[]=[];
 const ask=(q:string)=>{if(!questions.includes(q)&&questions.length<2)questions.push(q);};
 let sawTrainingCandidate=false,usedSingleNumber=false;
 for(const original of text.split(/\n|[；;]/).map(x=>x.trim()).filter(Boolean).flatMap(expandInlineWeightGroups)) {
  if(isTrainingNotationLine(original)||CARDIO_PLAN_HEADING.test(original))continue;
  if(/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日|号)?\s*$/.test(original)||/^(?:胸|背|肩|腿)(?:部|日|训练)?\s*[：:]?$/.test(original)||/^(?:补充|更正|纠正)[：:].*(?:实际|日期|发生|这次是)/.test(original)||/^我(?:不)?(?:喜欢|习惯|偏好|通常|一般|经常)/.test(original))continue;
  if(/^(感受|RPE|RIR|状态|备注|疼痛|恢复)\s*[:：]/i.test(original)){if(sets.length){sets.at(-1)!.effort=original;const rir=original.match(/RIR\s*[:：]?\s*(\d+)/i);if(rir)sets.at(-1)!.rir=+rir[1];if(/疼痛|不适|痛/.test(original))sets.at(-1)!.pain=original;}continue;}
  if(CARDIO_TEXT.test(original)||/\d\s*(?:km|公里)/i.test(original))continue;
  if(swimming&&/^(?:泳姿|强度|距离|游动时长|实际游动|实际游了|休息)/.test(original))continue;
  if(/^(?:总时长|总用时|运动时长|移动时长|实际运动时长|平均配速|配速|平均心率|均心率|心率|平均步频|步频|活动热量|动态热量|总热量|消耗|热量|步数|来源|App|运动编号|训练编号)\s*[:：]?/i.test(original)||parseDailyActivity(original))continue;
  const line=original.replace(/[*xX×]/g,'×');
  if(/→|递减/.test(line)&&/\d(?:\.\d+)?\s*(?:→)/.test(line)){ask('递减组各档重量、次数以及重复轮数分别是多少？');continue;}
  let m=line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(kg|公斤|千克|lb|磅)\s*(.+)$/i);
  let exercise='',kg:number|null=null,tail='';
  if(m){exercise=m[1];kg=+m[2]*(/lb|磅/i.test(m[3])?.45359237:1);kg=Math.round(kg*1000)/1000;tail=m[4];sawTrainingCandidate=true;}
  else {const bw=line.match(/^(.+?)\s+(\d+\s*(?:组\s*×?\s*\d+\s*次|×\s*\d+)(?:\s*\+.*)?)$/)??line.match(/^(.+?)\s+(\d+\s*次)$/)??(convention.singleNumberIsReps?line.match(/^(.+?)\s+(\d+)$/):null);if(!bw){if(/训练用时|训练时长|力量训练.*分钟/.test(line))continue;ask('有些训练记号还不明确，请补充动作、重量口径和组次数。');continue;}exercise=bw[1];tail=bw[2];sawTrainingCandidate=true;}
  const warmup=/热身/.test(exercise+' '+tail);exercise=exercise.replace(/^[\d.、\s]+/,'').replace(/热身(?:组)?|正式(?:组)?/g,'').trim();
  const explicitTotal=/总重|双手合计|两只合计|总负重|合计重量|合计重/.test(original);
  exercise=exercise.replace(/\s*(?:单手|每手|单只|总重|双手合计|两只合计|总负重|合计重量)\s*/g,'').trim();
  const bodyweight=kg===null&&/卷腹|举腿|俯卧撑|引体向上|自重/.test(exercise);
  // 哑铃按单只、杠铃/史密斯按总重、器械按标重；原文明确写总重时保留总重。不再逐条追问哑铃口径。
  const basis:SetEntry['loadBasis']=bodyweight?'bodyweight':resolveLoadBasis(exercise,{loadBasis:'unknown',kg,explicitTotal},EMPTY_RULES,true).loadBasis;
  if(basis==='unknown')ask('这项动作的重量和计重方式是什么？');
  if(kg===null&&!bodyweight)ask('这项动作的实际重量尚未提供，未沿用历史重量。');
  const clean=tail.replace(/(?:RIR|RPE|感受)[:：]?.*$/i,'').replace(/热身(?:组)?|正式(?:组)?/g,'').trim();
  let blocks:{sets:number;reps:number}[]=[];
  const explicit=clean.match(/^(\d+)\s*组\s*×?\s*(\d+)\s*次$|^(\d+)\s*次\s*×?\s*(\d+)\s*组$/);
  if(explicit)blocks=[{sets:+(explicit[1]??explicit[4]),reps:+(explicit[2]??explicit[3])}];
  else if(/^\d+\s*×\s*\d+(?:\s*\+\s*(?:\d+\s*×\s*)?\d+)*$/.test(clean))blocks=clean.split('+').map(b=>{const n=b.trim().split('×').map(Number);return n.length===2?(convention.setsFirst===false?{sets:n[1],reps:n[0]}:{sets:n[0],reps:n[1]}):{sets:1,reps:n[0]};});
  else if(/^\d+\s*次$/.test(clean))blocks=[{sets:1,reps:Number(clean.replace(/\s*次$/,''))}];
  else if(/^\d+$/.test(clean)&&convention.singleNumberIsReps){blocks=[{sets:1,reps:Number(clean)}];usedSingleNumber=true;}
  else {ask('这行组次记号无法确定，请补充“组×次数”。');continue;}
  for(const b of blocks){if(b.sets<1||b.sets>100||b.reps<1||b.reps>200){ask('组数或次数超出可识别范围，请核对原文。');continue;}sets.push(normalizeSet({exercise,kg,reps:b.reps,sets:b.sets,loadBasis:basis,confirmed:basis!=='unknown'&&(kg!==null||bodyweight),setType:warmup?'warmup':'work',...(tail.match(/RIR\s*[:：]?\s*(\d+)/i)?{rir:+tail.match(/RIR\s*[:：]?\s*(\d+)/i)![1]}:{})},[],{text:original,explicitTotal}));}
 }
 const runLines=text.split(/\n|[；;]/),firstRun=runLines.findIndex(line=>CARDIO_TEXT.test(cardioComponent(line))||(/^\s*\d+(?:\.\d+)?\s*(?:km|公里)/i.test(line)&&!/步行|走路|骑车|骑行|游泳/.test(line)));
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
 const parsedRun:RunEntry|undefined=firstRun>=0&&(km||minutes||elapsedMinutes)?{...(km?{km:+km[1]}:{}),completion:inferSession(runText).completion,...(minutes?{minutes}:!elapsedMinutes&&seconds&&km?{minutes:Math.round(+km[1]*seconds/60*100)/100}:{}),...(elapsedMinutes?{elapsedMinutes}:{}),...(seconds?{paceSecondsPerKm:seconds}:{}),...reportedRun(runDetails)}:undefined;
 const run=swimming??(parsedRun?normalizeCardio(parsedRun,text):undefined);
 const dailyActivity=parseDailyActivity(text);
 const session=inferSession(text,sets);
 if(swimming&&!sets.length&&!session.durationMinutes)session.completion=swimming.completion!;
 if(swimming?.completion==='unknown')ask('这次游泳完成了吗？有记录的话也可以补充时长或距离。');
 if(swimming&&text.split(/[\n；;。，,]/).some(line=>LAND_CARDIO_TEXT.test(line)&&/\d/.test(line)&&!parseDailyActivity(line)))ask('这条记录还有其他有氧活动，请分开记录以便分别计算。');
 if(!sets.length&&!run&&!session.durationMinutes&&!dailyActivity&&!(sawTrainingCandidate&&questions.length))return null;
 if(usedSingleNumber)assumptions.push('按已明确确认的个人记法：单个数字表示1组的次数；重量仅取本次原文明确提供的数值。');
 if(convention.setsFirst===false&&sets.length)assumptions.push('按已明确确认的个人记法读取“次数×组数”；带“组／次”单位的记号仍以单位为准。');
 const work=sets.filter(s=>s.setType!=='warmup');
 const swimSummary=swimming?[
  swimming.swimStroke?SWIM_STROKE_LABELS[swimming.swimStroke]:'游泳',
  swimming.elapsedMinutes?`总时长 ${swimming.elapsedMinutes} 分钟`:undefined,
  swimming.minutes?`游动 ${swimming.minutes} 分钟`:undefined,
  swimming.km?`${Math.round(swimming.km*1000)} 米`:undefined,swimming.effort
 ].filter(Boolean).join(' · ')+'。':'';
 const analysis:Analysis={summary:[work.length?`识别 ${new Set(work.map(s=>s.exerciseId)).size} 个动作，共 ${workSetCount(work)} 个非热身组。`:session.durationMinutes?`力量训练 ${session.durationMinutes} 分钟。`:dailyActivity?`日常活动 ${dailyActivity.steps??''} 步。`:'',swimSummary||(run?`有氧${run.km?` ${run.km} 公里`:""}${run.minutes?`，用时 ${run.minutes} 分钟`:''}。`:'')].join(''),sets,run,...(dailyActivity?{dailyActivity}:{}),questions,assumptions,training:session,engine:'local',at:new Date().toISOString()};
 return analysis;
}
export function splitHistorical(text: string, zone = 'Asia/Shanghai'): { text: string; occurredAt: string; timezone: string }[] {
  const parts: {text:string;occurredAt:string;timezone:string}[]=[];
  let date = ''; let lines: string[]=[];
  const flush=()=>{ if (lines.join('\n').trim()) { if (!date) throw new Error('历史笔记请用 YYYY-MM-DD 单独一行标明每次训练日期。'); parts.push({text:lines.join('\n').trim(), occurredAt: `${date}T12:00:00+08:00`, timezone:zone}); } lines=[]; };
  for (const line of text.split('\n')) { const m=line.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/); if (m) { flush(); date=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`; const d=new Date(`${date}T12:00:00+08:00`); if (!Number.isFinite(d.valueOf()) || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)!==date) throw new Error('历史笔记包含不存在的日期。'); } else lines.push(line); }
  flush(); if (!parts.length) throw new Error('没有找到可导入的训练内容。'); return parts;
}
export function localRecordStatus(record: Pick<HealthRecord,'kind'|'text'|'body'>,notation:TrainingNotation={}): { analysis:Analysis|null; status:HealthRecord['status'] } {
  if (record.kind==='training') { const a=parseTraining(record.text,notation); return {analysis:a,status:a?(a.questions.length?'needs_info':'ready'):'pending'}; }
  if (record.kind==='body') return {analysis:null,status:record.body && Object.keys(record.body).length?'ready':'needs_info'};
  if (record.kind==='note') {const dailyActivity=parseDailyActivity(record.text);return dailyActivity?{analysis:{summary:`记录日常活动 ${dailyActivity.steps??''} 步（${dailyActivity.coverage==='full'?'全天':'截至目前'}）`,questions:[],assumptions:[],dailyActivity,engine:'local',at:new Date().toISOString()},status:'ready'}:{analysis:null,status:'pending'};}
  return {analysis:null,status:'pending'};
}
