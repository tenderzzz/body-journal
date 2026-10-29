import type {MemoryEvidence} from '../../src/shared/types';
/** Explicitly confirmed logging conventions; never inferred from historical loads. */
export type TrainingNotation={singleNumberIsReps?:boolean;setsFirst?:boolean};
const normal=(text:string)=>text.normalize('NFKC').replace(/[×*X]/g,'x').replace(/\s+/g,'');

export function detectTrainingNotation(text:string):TrainingNotation {
 const notation:TrainingNotation={};
 const clauses=text.split(/[\n。；;]/).flatMap(line=>/[？?]/.test(line)&&/(?:还是|或者).{0,5}(?:组数|次数)x(?:组数|次数)/.test(normal(line))?[]:line.split(/[，,]/));
 for(const segment of clauses){
  // A quoted or unanswered question is not a convention supplied by the user.
  // Split declarative clauses first: a later rhetorical question must not erase
  // the explicit convention in preceding clauses of the same supplement.
  if(/[？?]|是否|是不是|能否|可否|吗\s*$/.test(segment))continue;
  const line=normal(segment);
  for(const m of line.matchAll(/(组数|次数)x(组数|次数)/g)){
   if(m[1]===m[2]||/不按|不是|不要|并非/.test(line.slice(Math.max(0,m.index!-6),m.index))||/不对|错误|错了/.test(line.slice(m.index!+m[0].length,m.index!+m[0].length+4)))continue;
   notation.setsFirst=m[1]==='组数';
  }
  const single='(?:只有一个|只有1个|单个|单独一个|仅一个|仅1个|一个)数字(?:时)?';
  const positive=new RegExp(single+'(?:就是|表示|代表|按|记为|是)(?:1组x?次数|一组x?次数|(?:1|一)组的次数|次数)','g');
  const negative=new RegExp(single+'(?:并非|不表示|不是|不代表)(?:1组x?次数|一组x?次数|次数)','g');
  const mentions=[...line.matchAll(positive)].map(m=>({index:m.index!,value:true})).concat([...line.matchAll(negative)].map(m=>({index:m.index!,value:false}))).sort((a,b)=>a.index-b.index);
  if(mentions.length)notation.singleNumberIsReps=mentions.at(-1)!.value;
 }
 return notation;
}

export function isTrainingNotationLine(text:string):boolean {
 return Object.keys(detectTrainingNotation(text)).length>0&&!/\d\s*(?:kg|公斤|千克|lb|磅|km|公里)/i.test(text);
}

type NotationEvidence={text:string;evidence?:MemoryEvidence[];active?:boolean;stale?:boolean};
/** Update only explicitly supplied facets; each retained facet keeps its real evidence. */
export function mergeTrainingNotation(previous:NotationEvidence|undefined,next:{text:string;evidence:MemoryEvidence[]}):{text:string;evidence:MemoryEvidence[]} {
 const incoming=detectTrainingNotation(next.text);if(!Object.keys(incoming).length)return next;
 const prior=previous&&previous.active!==false&&!previous.stale?detectTrainingNotation(previous.text):{};
 const combined={...prior,...incoming},evidence:MemoryEvidence[]=[];
 for(const facet of ['setsFirst','singleNumberIsReps'] as const){
  const value=combined[facet];if(value===undefined)continue;
  const supplied=incoming[facet]!==undefined,sources=(supplied?next.evidence:previous?.evidence)??[];
  const exact=sources.filter(e=>detectTrainingNotation(e.quote)[facet]===value);
  // Older evidence may explicitly have unknown provenance. Preserve that status;
  // never turn generated wording into a new source quotation.
  for(const item of exact.length?exact:sources)if(!evidence.some(e=>JSON.stringify(e)===JSON.stringify(item)))evidence.push(item);
 }
 const parts:string[]=[];
 if(combined.setsFirst!==undefined)parts.push(combined.setsFirst?'组数×次数':'次数×组数');
 if(combined.singleNumberIsReps!==undefined)parts.push(combined.singleNumberIsReps?'单个数字表示次数':'单个数字不是次数');
 return {text:'记录记法：'+parts.join('；'),evidence};
}

/** Repeat an exercise name only within an explicit multi-weight line. */
export function expandInlineWeightGroups(text:string):string[]{
 const weights=[...text.matchAll(/(\d+(?:\.\d+)?)\s*(kg|公斤|千克|lb|磅)/gi)];
 if(weights.length<2)return [text];
 const exercise=text.slice(0,weights[0].index).trim();if(!exercise)return [text];
 const groups=weights.map((m,i)=>({weight:m[0],tail:text.slice(m.index!+m[0].length,weights[i+1]?.index??text.length).trim()}));
 // An unrecognised word between weights may be another exercise, so do not attach
 // its weight to the previous exercise. Such input remains available for a question.
 if(groups.some(g=>!/^\d[\d\s+×xX*次组.]*$/.test(g.tail.replace(/(?:RIR|RPE|感受)[:：]?.*$/i,'').replace(/热身(?:组)?|正式(?:组)?/g,'').trim())))return [text];
 return groups.map(g=>`${exercise} ${g.weight} ${g.tail}`);
}
