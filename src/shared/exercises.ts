import type { Analysis, ExerciseRules, SetEntry, TrainingPart, TrainingSession, HealthRecord } from './types';
export const PART_NAMES:Record<TrainingPart,string>={chest:'胸',back:'背',shoulders:'肩',legs:'腿',mixed:'混合',unknown:'待确认'};
export const DEFAULT_SPLIT:TrainingPart[]=['chest','back','shoulders','legs'];
export type ExerciseAlias={raw:string;name:string};
export const EMPTY_RULES:ExerciseRules={archived:[],overrides:{}};
const aliases:Record<string,string>={卧推:'杠铃平板卧推',杠铃卧推:'杠铃平板卧推',平板卧推:'杠铃平板卧推',上斜哑铃:'上斜哑铃卧推',哑铃上斜:'上斜哑铃卧推',绳索下压:'绳索三头下压',哑铃推肩:'哑铃肩推',坐姿哑铃推肩:'哑铃肩推',哑铃肩推:'哑铃肩推',器械推肩:'器械肩推',哑铃俯身反向飞鸟:'俯身哑铃反向飞鸟',哑铃反向飞鸟:'俯身哑铃反向飞鸟',绳索Y举:'绳索Y平举',锤式弯举:'哑铃锤式弯举',附身划船:'俯身划船',俯卧屈腿:'俯卧腿弯举',大腿伸展:'腿屈伸',气泵下斜夹胸:'气泵夹胸',哑铃侧平举:'哑铃飞鸟',窄距推:'窄距卧推',保加利亚:'保加利亚分腿蹲',分腿蹲:'保加利亚分腿蹲'};

// 单只哑铃重量：名字里没有“哑铃”但实际是单手哑铃的动作。
const PER_HAND_ACTIONS=new Set(['交替前平举','臂屈伸']);
// 报告总重：含杠铃/史密斯或按两只合计记录的动作。分腿蹲的两只哑铃按总重记录。
const TOTAL_ACTIONS=new Set(['保加利亚分腿蹲','分腿蹲','碎颅者','窄距卧推','深蹲']);
const EQUIPMENT_HINTS:Record<string,string>={'交替前平举':'哑铃','臂屈伸':'哑铃','保加利亚分腿蹲':'哑铃','碎颅者':'杠铃','窄距卧推':'杠铃','深蹲':'杠铃'};
// 名字里没有“器械/绳索”但按器械标重统计的动作。
const MACHINE_ACTIONS=new Set(['高位下拉','坐姿划船','俯卧腿弯举','直臂下压','器械卷腹','器械肩推','器械推胸','蝴蝶机夹胸','气泵夹胸','绳索三头下压','绳索Y平举','绳索面拉']);
const TOTAL_MARK=/总重|双手合计|两只合计|总负重|合计重量|合计重/;


export type ExercisePart='chest'|'back'|'shoulders'|'legs'|'core'|'other';
export const EXERCISE_PART_ORDER:ExercisePart[]=['chest','back','shoulders','legs','core','other'];
export const EXERCISE_PART_NAMES:Record<ExercisePart,string>={chest:'胸',back:'背',shoulders:'肩',legs:'腿',core:'核心',other:'其他'};
// 动作所属部位用于趋势和整理页分组显示，不改变训练记录本身的部位判断。
const EXERCISE_PART_TABLE:Record<string,ExercisePart>={
 杠铃平板卧推:'chest',上斜哑铃卧推:'chest',哑铃卧推:'chest',下斜哑铃卧推:'chest',器械推胸:'chest',窄距卧推:'chest',碎颅者:'chest',碎颅者接窄距卧推:'chest',气泵夹胸:'chest',蝴蝶机夹胸:'chest',绳索三头下压:'chest',臂屈伸:'chest',
 高位下拉:'back',坐姿划船:'back',俯身哑铃划船:'back',直臂下压:'back',杠铃弯举:'back',哑铃弯举:'back',哑铃锤式弯举:'back',
 哑铃肩推:'shoulders',器械肩推:'shoulders',哑铃飞鸟:'shoulders',器械反向飞鸟:'shoulders',俯身哑铃反向飞鸟:'shoulders',杠铃反向飞鸟:'shoulders',绳索Y平举:'shoulders',绳索面拉:'shoulders',交替前平举:'shoulders',
 深蹲:'legs',史密斯深蹲:'legs',保加利亚分腿蹲:'legs',俯卧腿弯举:'legs',腿屈伸:'legs',内收:'legs',外展:'legs',
 器械卷腹:'core',下斜卷腹:'core',悬垂举腿:'core',
};
export function exercisePart(name:string):ExercisePart{
 const known=EXERCISE_PART_TABLE[name];if(known)return known;
 if(/卷腹|举腿|平板支撑|核心|腹肌/.test(name))return 'core';
 if(/反向飞鸟|飞鸟|平举|面拉|肩推|推肩|侧平举/.test(name))return 'shoulders';
 if(/卧推|推胸|夹胸|臂屈伸|碎颅|三头|下压/.test(name))return 'chest';
 if(/划船|下拉|引体|弯举|直臂/.test(name))return 'back';
 if(/深蹲|分腿蹲|腿弯举|腿屈伸|内收|外展|硬拉|提踵/.test(name))return 'legs';
 return 'other';
}

export function exerciseIdentity(name:string){return `ex_${[...name].map(c=>c.codePointAt(0)!.toString(16)).join('_')}`;}
export function inferEquipment(name:string,given?:string){return given??EQUIPMENT_HINTS[name]??(/史密斯/.test(name)?'史密斯机':/哑铃/.test(name)?'哑铃':/杠铃/.test(name)?'杠铃':/绳索|龙门/.test(name)?'绳索':/蝴蝶机/.test(name)?'蝴蝶机':/器械|气泵/.test(name)?'器械':MACHINE_ACTIONS.has(name)?'器械':undefined);}

// 反向飞鸟分三类：哑铃→俯身哑铃反向飞鸟；杠铃→杠铃反向飞鸟；其余（蝴蝶机/器械/未注明）→器械反向飞鸟。
// 哑铃侧平举与哑铃飞鸟视为同一动作，统一用“哑铃飞鸟”。
export function normalizeExerciseName(input:string){
 let name=aliases[input.trim()]??input.trim();
 if(/反向飞鸟|后束飞鸟/.test(name))name=/哑铃/.test(name)||/^俯身飞鸟/.test(name)?'俯身哑铃反向飞鸟':/杠铃/.test(name)?'杠铃反向飞鸟':'器械反向飞鸟';
 if(/侧平举/.test(name)&&/哑铃/.test(name))name='哑铃飞鸟';
 return name;
}

type BasisContext={loadBasis?:SetEntry['loadBasis'];kg?:number|null;equipment?:string;text?:string;original?:string;explicitTotal?:boolean;basisSource?:SetEntry['basisSource']};
// 只有和动作写在同一行（或同一句）的“总重/合计”才视为用户明确声明，避免把器械说明误挂到哑铃动作上。
export function hasExplicitTotal(text:string|undefined,hints:string[],dumbbell=false){if(!text)return false;return text.split(/\n|[；;]/).some(line=>TOTAL_MARK.test(line)&&(hints.some(h=>!!h&&line.includes(h))||(dumbbell&&/哑铃/.test(line)&&!/单只|单手|每手|单侧/.test(line))));}
// 动作类型决定计重口径，不再由模型逐条猜。rebase=false 时信任已保存的规则结果。
export function resolveLoadBasis(name:string,ctx:BasisContext,rules:ExerciseRules=EMPTY_RULES,rebase=false):{loadBasis:SetEntry['loadBasis'];basisSource:NonNullable<SetEntry['basisSource']>} {
 const override=rules.overrides?.[name];
 if(override&&ctx.basisSource!=='manual')return {loadBasis:override,basisSource:'auto'};
 if(ctx.basisSource==='manual'&&ctx.loadBasis)return {loadBasis:ctx.loadBasis,basisSource:'manual'};
 if(!rebase&&ctx.loadBasis)return {loadBasis:ctx.loadBasis,basisSource:ctx.basisSource??'auto'};
 if(ctx.basisSource==='reported'&&ctx.loadBasis==='total')return {loadBasis:'total',basisSource:'reported'};
 const dumbbellHint=/哑铃/.test(name)||PER_HAND_ACTIONS.has(name)||ctx.equipment==='哑铃';
 const explicit=ctx.explicitTotal??hasExplicitTotal(ctx.text,[ctx.original??name,name],dumbbellHint);
 const dumbbell=/哑铃/.test(name)||PER_HAND_ACTIONS.has(name)||ctx.equipment==='哑铃';
 const total=/杠铃|史密斯/.test(name)||TOTAL_ACTIONS.has(name)||ctx.equipment==='杠铃'||ctx.equipment==='史密斯机';
 const machine=/绳索|器械|蝴蝶机|龙门/.test(name)||MACHINE_ACTIONS.has(name)||ctx.equipment==='绳索'||ctx.equipment==='器械'||ctx.equipment==='蝴蝶机';
 if(total)return {loadBasis:'total',basisSource:'auto'};
 if(dumbbell&&explicit)return {loadBasis:'total',basisSource:'reported'};
 if(dumbbell)return {loadBasis:'per_hand',basisSource:'auto'};
 if(machine)return {loadBasis:'machine',basisSource:'auto'};
 if(ctx.kg!==null&&ctx.kg!==undefined)return {loadBasis:'total',basisSource:'auto'};
 return {loadBasis:ctx.loadBasis??'unknown',basisSource:ctx.basisSource??'auto'};
}

export function normalizeSet(input:SetEntry,custom:ExerciseAlias[]=[],options:{rules?:ExerciseRules;text?:string;explicitTotal?:boolean;rebase?:boolean}={}):SetEntry {
 const rules=options.rules??EMPTY_RULES;
 const original=input.originalExercise??input.exercise;
 const user=custom.find(a=>a.name!==a.raw&&(a.raw===original||a.raw===input.exercise));
 let name=input.exercise.trim(),notes:string[]=[],ambiguous=false;
 name=name.replace(/[（(]([^）)]*)[）)]/g,(_,inside:string)=>{notes.push(inside);if(/未知|不明/.test(inside))ambiguous=true;return '';}).trim();
 const joined=notes.join('；'),round=joined.match(/第\s*(\d+)\s*轮/),stage=joined.match(/第\s*(\d+)\s*档/);
 if(user){name=user.name;ambiguous=false;}else if(!input.exerciseManuallyClassified)name=normalizeExerciseName(name);
 const generic=/^(推肩|肩推|飞鸟|反向飞鸟|俯身划船|深蹲|举腿|臂屈伸|内收|外展)$/.test(name);
 const classificationNeeded=user||input.exerciseManuallyClassified?false:(input.classificationNeeded??(ambiguous||generic));
 const equipment=inferEquipment(name,input.equipment);
 const bodyweight=/自重/.test(joined)||input.loadBasis==='bodyweight'||(input.kg===0&&/下斜卷腹|悬垂举腿|俯卧撑|引体向上/.test(name));
 const {loadBasis,basisSource}=bodyweight?{loadBasis:'bodyweight' as const,basisSource:'auto' as const}:resolveLoadBasis(name,{loadBasis:input.loadBasis,kg:input.kg,equipment,text:options.text,original,explicitTotal:options.explicitTotal,basisSource:input.basisSource},rules,options.rebase??false);
 const resolved=loadBasis!=='unknown'&&loadBasis!=='bodyweight';
 const confirmed=!classificationNeeded&&resolved&&input.kg!==null?true:input.confirmed;
 const metadata:Partial<SetEntry>={originalExercise:original,exercise:name,exerciseId:exerciseIdentity(name),exerciseManuallyClassified:user?true:input.exerciseManuallyClassified,classificationNeeded,loadBasis,basisSource,equipment,confirmed,notes:[input.notes,...notes].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join('；')||undefined};
 if(round&&!input.round)metadata.round=+round[1];if(stage&&!input.dropStage)metadata.dropStage=+stage[1];
 if(/递减/.test(joined)&&!input.setType)metadata.setType='drop';if((metadata.setType??input.setType)==='drop'&&!input.groupId)metadata.groupId='drop:'+exerciseIdentity(name);if(/接|轮/.test(joined)&&!input.groupId)metadata.groupId='legacy-superset';
 if(/每侧|单侧/.test(joined)&&!input.side)metadata.side='each';
 // 哑铃肩推固定为坐姿（用户实际训练均为坐姿）；原文明确写站姿时保留站姿。
 const seatedPress=/哑铃/.test(name)&&/(?:肩推|推肩)/.test(name);
 if(!input.position){
  if(/站姿|站立/.test(original+' '+joined))metadata.position='standing';
  else if(/坐姿/.test(original)||seatedPress)metadata.position='seated';
 }
 if(bodyweight)metadata.kg=null;
 return {...input,...metadata,setType:metadata.setType??input.setType??'work'};
}
export function baselineKey(s:SetEntry){return [s.equipmentId??s.equipment??'器械未注明',s.loadBasis,s.position??'姿势按原记录'].join('|');}
export function baselineLabel(s:SetEntry){return [s.equipmentId??s.equipment,s.loadBasis==='per_hand'?'单只重量':s.loadBasis==='total'?'报告总重':s.loadBasis==='bodyweight'?'自重':s.loadBasis==='unknown'?'重量口径待确认':'器械标重',s.position==='seated'?'坐姿':s.position==='standing'?'站姿':undefined].filter(Boolean).join(' · ');}
export function inferSession(text:string,sets:SetEntry[]=[]):TrainingSession {
 const parts:TrainingPart[]=[];for(const [p,word] of [['chest','胸'],['back','背'],['shoulders','肩'],['legs','腿']] as const)if(new RegExp(`(?:^|\\n)\\s*${word}(?:部|日|训练)?\\s*[：:]?\\s*(?:$|\\n)`,'m').test(text))parts.push(p);
 const planned=/(?:计划|打算|准备|明天|下次).{0,12}(?:练|训练)|训练计划/.test(text)&&!/(?:实际|已经|今天|本次).{0,8}(?:完成|练完)/.test(text);
 const hasData=sets.length>0||/\d+\s*(?:kg|公斤|千克).*\d+\s*[*x×]/i.test(text);
 const completion=planned?'planned':hasData||/已完成|练完|训练结束/.test(text)?'completed':'unknown';
 const duration=text.match(/(?:力量训练|训练用时|训练时长)\s*[:：]?\s*(\d+)\s*分钟/);
 return {part:parts.length>1?'mixed':parts[0]??'unknown',completion,...(duration?{durationMinutes:+duration[1]}:{})};
}
export function normalizeAnalysis(a:Analysis,text:string,custom:ExerciseAlias[]=[],rules:ExerciseRules=EMPTY_RULES):Analysis {
 const sets=a.sets?.map(s=>normalizeSet(s,custom,{rules,text,rebase:true}));const inferred=inferSession(text,sets);
 return {...a,...(sets?{sets}:{}),...((sets?.length||a.training)?{training:{...inferred,...a.training,...(inferred.completion==='planned'?{completion:'planned' as const}:{})}}:{})};
}
export function trainingProgress(records:HealthRecord[],split=DEFAULT_SPLIT){
 const candidates=records.filter(r=>!r.deleted&&r.kind==='training'&&(r.analysis?.sets?.length??0)>0).sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
 for(const r of candidates){const session=r.analysis?.training??inferSession(r.text,r.analysis?.sets);if(session.completion==='planned')continue;
  if(session.completion!=='completed'||!split.includes(session.part))return {next:null,lastId:r.id,lastPart:session.part,reason:'最近力量训练的完成状态或部位待确认'};
  return {next:split[(split.indexOf(session.part)+1)%split.length],lastId:r.id,lastPart:session.part,reason:null};
 }return {next:null,lastId:null,lastPart:null,reason:'尚无可确定部位的已完成力量训练'};
}
export function groupedSets(sets:SetEntry[]){const groups=new Map<string,SetEntry[]>();for(const raw of sets){const s=normalizeSet(raw),list=groups.get(s.exerciseId!)??[];list.push(s);groups.set(s.exerciseId!,list);}return [...groups.values()];}

export function workSetCount(sets:SetEntry[]){let count=0;const drops=new Map<string,SetEntry[]>();for(const raw of sets){const s=normalizeSet(raw);if(s.setType==='warmup')continue;if(s.setType==='drop'&&s.groupId){const key=`${s.exerciseId}:${s.groupId}`,group=drops.get(key)??[];group.push(s);drops.set(key,group);}else count+=s.sets;}for(const group of drops.values()){const rounds=new Set(group.filter(s=>s.round).map(s=>s.round));count+=rounds.size||Math.max(...group.map(s=>s.sets));}return count;}
