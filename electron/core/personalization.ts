import { createHash } from 'node:crypto';
import type { HealthRecord, Memory } from '../../src/shared/types';
import { normalizeSet,baselineKey,baselineLabel,inferSession } from '../../src/shared/exercises';
import { localDay } from '../../src/shared/stats';
type Draft=Omit<Memory,'id'|'stale'>;
const key=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,24);
const normalize=(s:string)=>s.toLowerCase().replace(/[（(][^）)]*[）)]/g,'').replace(/[\s，,、。·]/g,'');
const basis={total:'总重',per_hand:'单手',machine:'器械'};
const evidence=(records:HealthRecord[])=>records.map(r=>({id:r.id,revision:r.revision}));
export function automaticMemories(records:HealthRecord[]):Draft[] {
 const active=records.filter(r=>!r.deleted).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
 const drafts:Draft[]=[],training=new Map<string,HealthRecord[]>(),meals=new Map<string,HealthRecord[]>(),preferences=new Map<string,HealthRecord[]>();
 for(const r of active){
  for(const s of r.kind==='training'&&(r.analysis?.training??inferSession(r.text,r.analysis?.sets)).completion==='completed'?(r.analysis?.sets??[]).map(x=>normalizeSet(x)):[])if(s.confirmed&&s.setType!=='warmup'&&!s.classificationNeeded){const k=`${s.exerciseId}:${baselineKey(s)}`;const list=training.get(k)??[];if(!list.includes(r))list.push(r);training.set(k,list);}
  if(r.kind==='meal'&&r.analysis?.ingredients?.length&&!r.analysis.unmatched?.length){const k=r.analysis.ingredients.map(i=>normalize(i.name)).sort().join('|');const list=meals.get(k)??[];list.push(r);meals.set(k,list);}
  for(const sentence of r.text.split(/[\n。！？]/).map(s=>s.trim()).filter(Boolean)) {
   // 补充说明和问答碎片不是长期偏好，避免把“补充：是的；自重”这类句子存成记忆。
   if(/^(补充|更正|纠正)[：:]/.test(sentence)||/^(是的|对的|可以|没错|只有|都是)/.test(sentence))continue;
   // Save the user's own words, never infer a preference from one meal or one load.
   if(!/(?:我(?:不)?(?:喜欢|习惯|偏好|通常|一般|经常|总是)|我(?:的|写的|记录的).{0,20}(?:按|指|表示|代表|都是|均为)|(?:记法|记录方式|重量单位|哑铃重量).{0,16}(?:按|指|为|是|用)|(?:以后|默认).{0,16}(?:按|用|吃|记|组|次))/.test(sentence)||!/吃|饭|餐|食|蛋白|米饭|口味|训练|动作|哑铃|杠铃|重量|组|次|kg|公斤|千克|磅/i.test(sentence)||/蛋白粉|补剂|肌酸|乳清|每勺|每份/.test(sentence)||sentence.length>500)continue;
   const list=preferences.get(sentence)??[];list.push(r);preferences.set(sentence,list);
  }
 }
 const make=(refs:HealthRecord[],autoKey:string,autoCategory:Memory['autoCategory'],text:string,extra:Partial<Draft>={}):Draft=>({kind:'habit',text:text.length>1800?text.slice(0,1780)+'…完整内容见依据。':text,startsAt:refs[0].occurredAt,expiresAt:null,sourceIds:refs.map(r=>r.id),sourceRevisions:evidence(refs),active:true,confirmed:false,autoManaged:true,autoKey,autoCategory,...extra});
 for(const [k,all] of training){const refs=all.slice(-5),latest=refs.at(-1)!;const sets=latest.analysis!.sets!.map(s=>normalizeSet(s)).filter(s=>s.confirmed&&`${s.exerciseId}:${baselineKey(s)}`===k);const name=sets[0].exercise;
  const detail=sets.map(s=>`${s.kg===null?'重量未填':s.kg+'kg'} × ${s.reps}次 × ${s.sets}组`).join('；');
  drafts.push(make(refs,`training:${key(k)}`,'training',`${name}：${baselineLabel(sets[0])}；最近一次已记录 ${detail}（${localDay(latest.occurredAt,latest.timezone)}）。参考最近 ${refs.length} 次记录，随训练更新，不是固定目标。`));
 }
 for(const [k,all] of meals){if(new Set(all.map(r=>localDay(r.occurredAt,r.timezone))).size<2)continue;const distinct=new Map(all.map(r=>[localDay(r.occurredAt,r.timezone),r]));const refs=[...distinct.values()].slice(-5),latest=refs.at(-1)!,items=latest.analysis!.ingredients!;
  drafts.push(make(refs,`meal:${key(k)}`,'meal',`重复记录的餐食：${items.map(i=>i.name).join('、')}。最近 ${refs.length} 天的记录中重复出现；最近分量：${items.map(i=>`${i.name} ${i.grams.low}–${i.grams.high}g`).join('，')}。仅作下次估算参照，实际分量仍以新记录为准。`,{mealTemplate:items}));
 }
 for(const [sentence,all] of preferences){const refs=all.slice(-5);drafts.push(make(refs,`preference:${key(sentence)}`,'preference',sentence,{kind:'fact',confirmed:true}));}
 return drafts;
}
