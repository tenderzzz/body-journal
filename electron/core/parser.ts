import { normalizeSet, inferSession, workSetCount, resolveLoadBasis, EMPTY_RULES } from '../../src/shared/exercises';
import type { Analysis, HealthRecord, SetEntry } from '../../src/shared/types';
export function parseBody(text: string): { weightKg?: number; waistCm?: number } {
  const w = text.match(/(?:体重|weight)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|公斤|千克|斤)/i);
  const c = text.match(/(?:腰围|waist)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm|厘米)/i);
  const result: { weightKg?: number; waistCm?: number } = {};
  if (w) result.weightKg = Number(w[1]) / (w[2] === '斤' ? 2 : 1);
  if (c) result.waistCm = Number(c[1]);
  return result;
}
export function parseTraining(text: string): Analysis | null {
 const sets:SetEntry[]=[],questions:string[]=[],assumptions:string[]=[];
 const ask=(q:string)=>{if(!questions.includes(q)&&questions.length<2)questions.push(q);};
 let lastWeight:number|null=null,lastUnit='kg';
 for(const original of text.split(/\n|[；;]/).map(x=>x.trim()).filter(Boolean)) {
  if(/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日|号)?\s*$/.test(original)||/^(?:胸|背|肩|腿)(?:部|日|训练)?\s*[：:]?$/.test(original)||/^(?:补充|更正|纠正)[：:].*(?:实际|日期|发生|这次是)/.test(original)||/^我(?:不)?(?:喜欢|习惯|偏好|通常|一般|经常)/.test(original))continue;
  if(/^(感受|RPE|RIR|状态|备注|疼痛|恢复)\s*[:：]/i.test(original)){if(sets.length){sets.at(-1)!.effort=original;const rir=original.match(/RIR\s*[:：]?\s*(\d+)/i);if(rir)sets.at(-1)!.rir=+rir[1];if(/疼痛|不适|痛/.test(original))sets.at(-1)!.pain=original;}continue;}
  if(/跑步|跑步机|\d\s*(?:km|公里)/i.test(original))continue;
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
 const km=text.match(/(?:跑步(?:机)?\s*)?(\d+(?:\.\d+)?)\s*(?:km|公里)/i),duration=text.match(/(?:用时|时长)?\s*(\d+(?:\.\d+)?)\s*(?:分钟|min)/i);
 const pace=text.match(/(\d{1,2})\s*['′’](?:(\d{1,2})\s*["″”])?/),paceLabel=text.match(/配速\s*[:：]?\s*(\d{1,2})[:：](\d{2})/);
 const seconds=paceLabel?+paceLabel[1]*60 + +paceLabel[2]:pace?+pace[1]*60 + +(pace[2]??0):undefined;
 const hr=text.match(/(?:平均心率|均心率|心率)\s*[:：]?\s*(\d{2,3})/);
 const run=km?{km:+km[1],...(duration&&!/(?:训练用时|训练时长|力量训练)/.test(duration[0])?{minutes:+duration[1]}:seconds?{minutes:Math.round(+km[1]*seconds/60*100)/100}:{}),...(seconds?{paceSecondsPerKm:seconds}:{}),...(hr?{avgHeartRate:+hr[1]}:{})}:undefined;
 if(!sets.length&&!run)return null;
 const work=sets.filter(s=>s.setType!=='warmup');
 const analysis:Analysis={summary:[work.length?`识别 ${new Set(work.map(s=>s.exerciseId)).size} 个动作，共 ${workSetCount(work)} 个非热身组。`:'',run?`跑步 ${run.km} 公里${run.minutes?`，用时 ${run.minutes} 分钟`:''}。`:''].join(''),sets,run,questions,assumptions,training:inferSession(text,sets),engine:'local',at:new Date().toISOString()};
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
  if (record.kind==='note') return {analysis:null,status:'pending'};
  return {analysis:null,status:'pending'};
}
