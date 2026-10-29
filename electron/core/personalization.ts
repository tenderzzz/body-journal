import { createHash } from 'node:crypto';
import type { HealthRecord, Memory } from '../../src/shared/types';
import { normalizeSet,baselineKey,baselineLabel,inferSession } from '../../src/shared/exercises';
import {memoryTopic} from './memory';
import {detectTrainingNotation,isTrainingNotationLine,mergeTrainingNotation} from './training-notation';
import { localDay } from '../../src/shared/stats';
import {ingredientIdentity,ingredientAmount,FOOD_UNIT_NAMES} from '../../src/shared/food';
type Draft=Omit<Memory,'id'|'stale'>;
const key=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,24);
const basis={total:'总重',per_hand:'单手',machine:'器械'};
const evidence=(records:HealthRecord[])=>records.map(r=>({id:r.id,revision:r.revision}));
// Keep question marks until after deciding whether a sentence states a fact.
// Splitting them away turns “组数x次数？” into a confirmed convention.
const sentences=(text:string)=>(text.match(/[^\n。！？!?]+[。！？!?]?/g)??[]).map(s=>s.trim()).filter(Boolean);
function preferenceStatement(raw:string):string|undefined {
 const sentence=raw.replace(/^(补充|更正|纠正)[：:]\s*/, '');
 if(isTrainingNotationLine(sentence)){
  const clauses=[...sentence.matchAll(/[^,，]+/g)].filter(m=>Object.keys(detectTrainingNotation(m[0])).length);
  const last=clauses.at(-1);
  // Preserve an exact source substring, excluding a later rhetorical complaint.
  return last?sentence.slice(0,last.index!+last[0].length).replace(/[。！!]$/, '').trim():undefined;
 }
 return /[？?]/.test(sentence)?undefined:sentence.replace(/[。！!]$/, '').trim();
}
export function automaticMemories(records:HealthRecord[],existing:Memory[]=[]):Draft[] {
 const active=records.filter(r=>!r.deleted).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
 const drafts:Draft[]=[],training=new Map<string,HealthRecord[]>(),meals=new Map<string,HealthRecord[]>(),preferences=new Map<string,HealthRecord[]>();
 const notationStatements:{record:HealthRecord;text:string}[]=[];
 for(const r of active){
  for(const s of r.kind==='training'&&(r.analysis?.training??inferSession(r.text,r.analysis?.sets)).completion==='completed'?(r.analysis?.sets??[]).map(x=>normalizeSet(x)):[])if(s.confirmed&&s.setType!=='warmup'&&!s.classificationNeeded){const k=`${s.exerciseId}:${baselineKey(s)}`;const list=training.get(k)??[];if(!list.includes(r))list.push(r);training.set(k,list);}
  if(r.kind==='meal'&&r.analysis?.ingredients?.length&&!r.analysis.unmatched?.length){const k=r.analysis.ingredients.map(ingredientIdentity).sort().join('|');const list=meals.get(k)??[];list.push(r);meals.set(k,list);}
  for(const rawSentence of sentences(r.text)) {
   const sentence=preferenceStatement(rawSentence);if(!sentence)continue;
   if(isTrainingNotationLine(sentence)){notationStatements.push({record:r,text:sentence});continue;}
   // 补充说明和问答碎片不是长期偏好，避免把“补充：是的；自重”这类句子存成记忆。
   if(/^(补充|更正|纠正)[：:]/.test(rawSentence)||/^(是的|对的|可以|没错|只有|都是)/.test(sentence))continue;
   // Save the user's own words, never infer a preference from one meal or one load.
   if(!/(?:我(?:不)?(?:喜欢|习惯|偏好|通常|一般|经常|总是)|我(?:的|写的|记录的).{0,20}(?:按|指|表示|代表|都是|均为)|(?:记法|记录方式|重量单位|哑铃重量).{0,16}(?:按|指|为|是|用)|(?:以后|默认).{0,16}(?:按|用|吃|记|组|次))/.test(sentence)||!/吃|饭|餐|食|蛋白|米饭|口味|训练|动作|哑铃|杠铃|重量|组|次|kg|公斤|千克|磅/i.test(sentence)||/蛋白粉|补剂|肌酸|乳清|每勺|每份/.test(sentence)||sentence.length>500)continue;
   const topic=(/这周|本周|这几天|暂时/.test(sentence)?'state:':'')+(memoryTopic(sentence)??sentence);const list=preferences.get(topic)??[];list.push(r);preferences.set(topic,list);
  }
 }
 // An aggregate describes the latest evidence, not the oldest record in its sample.
 // Using the oldest timestamp lets a future weight or meal portion leak into past analyses.
 const make=(refs:HealthRecord[],autoKey:string,autoCategory:Memory['autoCategory'],text:string,extra:Partial<Draft>={}):Draft=>({kind:'habit',text:text.length>1800?text.slice(0,1780)+'…完整内容见依据。':text,startsAt:refs.at(-1)!.occurredAt,versionStartsAt:refs.at(-1)!.occurredAt,expiresAt:null,sourceIds:refs.map(r=>r.id),sourceRevisions:evidence(refs),active:true,confirmed:false,autoManaged:true,autoKey,autoCategory,...extra});
 const notationTopic='recording.training_notation';
 const manualNotation=existing.find(m=>m.kind==='fact'&&m.confirmed&&!m.subject&&memoryTopic(m.text,m.topicKey)===notationTopic&&m.autoManaged===false);
 const cutoff=manualNotation?Date.parse(manualNotation.versionStartsAt??manualNotation.startsAt):-Infinity;
 const newerNotation=notationStatements.filter(s=>Date.parse(s.record.occurredAt)>cutoff);
 if(newerNotation.length&&manualNotation?.active!==false){
  let merged=manualNotation&&!manualNotation.stale?{text:manualNotation.text,evidence:manualNotation.evidence??[]}:undefined;
  for(const item of newerNotation)merged=mergeTrainingNotation(merged,{text:item.text,evidence:[{quote:item.text,origin:'record',recordId:item.record.id,recordRevision:item.record.revision,at:item.record.occurredAt}]});
  const sourceIds=new Set(merged!.evidence.map(e=>e.recordId).filter((id):id is string=>!!id)),refs=active.filter(r=>sourceIds.has(r.id));
  const latest=newerNotation.at(-1)!.record;
  drafts.push(make(refs.length?refs:[latest],`preference:${key(notationTopic)}`,'preference',merged!.text,{kind:'fact',confirmed:true,topicKey:notationTopic,startsAt:latest.occurredAt,versionStartsAt:latest.occurredAt,evidence:merged!.evidence,sourceIds:[...sourceIds],sourceRevisions:evidence(refs),sourceMessageIds:[...new Set(merged!.evidence.map(e=>e.messageId).filter((id):id is string=>!!id))],...(manualNotation?{autoManaged:false}:{})}));
 }
 for(const [k,all] of training){const refs=all.slice(-5),latest=refs.at(-1)!;const sets=latest.analysis!.sets!.map(s=>normalizeSet(s)).filter(s=>s.confirmed&&`${s.exerciseId}:${baselineKey(s)}`===k);const name=sets[0].exercise;
  const detail=sets.map(s=>`${s.kg===null?'重量未填':s.kg+'kg'} × ${s.reps}次 × ${s.sets}组`).join('；');
  drafts.push(make(refs,`training:${key(k)}`,'training',`${name}：${baselineLabel(sets[0])}；最近一次已记录 ${detail}（${localDay(latest.occurredAt,latest.timezone)}）。参考最近 ${refs.length} 次记录，随训练更新，不是固定目标。`));
 }
 for(const [k,all] of meals){if(new Set(all.map(r=>localDay(r.occurredAt,r.timezone))).size<2)continue;const distinct=new Map(all.map(r=>[localDay(r.occurredAt,r.timezone),r]));const refs=[...distinct.values()].slice(-5),latest=refs.at(-1)!,items=latest.analysis!.ingredients!;
  drafts.push(make(refs,`meal:${key(k)}`,'meal',`重复记录的餐食：${items.map(i=>i.name).join('、')}。最近 ${refs.length} 天的记录中重复出现；最近分量：${items.map(i=>{const amount=ingredientAmount(i);return `${i.name} ${amount.low}–${amount.high}${FOOD_UNIT_NAMES[amount.unit]}（${i.portionSource==='measured'?'有称量依据':i.portionSource==='reported'?'用户报告':'估计分量'}）`;}).join('，')}。仅作下次估算参照，实际分量仍以新记录为准。`,{mealTemplate:items}));
 }
 for(const [topic,all] of preferences){const refs=all.slice(-5),latest=refs.at(-1)!;const content=sentences(latest.text).map(preferenceStatement).filter((s):s is string=>!!s).filter(s=>((/这周|本周|这几天|暂时/.test(s)?'state:':'')+(memoryTopic(s)??s))===topic).at(-1)??topic;drafts.push(make(refs,`preference:${key(topic)}`,'preference',content,{kind:topic.startsWith('state:')?'state':'fact',expiresAt:topic.startsWith('state:')?new Date(Date.parse(latest.occurredAt)+7*86400000).toISOString():null,confirmed:true,topicKey:memoryTopic(content),startsAt:latest.occurredAt,evidence:[{quote:content,origin:'record',recordId:latest.id,recordRevision:latest.revision,at:latest.occurredAt}]}));}
 return drafts;
}
