import type {Memory} from '../../src/shared/types';
import {validMemory} from '../../src/shared/stats';
import {detectTrainingNotation} from './training-notation';

export type MemoryPurpose='chat'|'weekly'|'memory'|'meal'|'training';
// Only collapse well understood settings. Unrecognised subjects retain their explicit key.
export function memoryTopic(text:string,key?:string):string|undefined {
 const aliases:Record<string,string>={'profile.eating.environment':'eating.environment','training.time':'training.time_preference','training.schedule.time':'training.time_preference','communication.lang':'communication.language'};
 key=key?aliases[key]??key:undefined;
 if((!key||/^recording\.(?:training_notation|conventions)$/.test(key))&&Object.keys(detectTrainingNotation(text)).length)return 'recording.training_notation';
 if((!key||key==='training.time_preference')&&/喜欢|偏好|习惯|默认|以后|不再/.test(text)&&/(?:晚上|早晨|早上|早起|上午|下午|中午|夜间).{0,8}(?:练|训练)|(?:训练|健身).{0,8}(?:晚上|早晨|早上|上午|下午|中午)/.test(text))return 'training.time_preference';
 if((!key||key==='training.duration')&&/(?:训练|每次|健身).{0,12}(?:最多|不超过|控制在).{0,8}(?:分钟|小时)/.test(text))return 'training.duration';
 if((!key||key==='eating.taste'||key==='eating.light_flavor')&&/(?:喜欢|偏好|口味).{0,8}清淡|清淡.{0,8}(?:饮食|口味)/.test(text))return 'eating.light_flavor';
 return key?aliases[key]??key:undefined;
}
export const memoryRevision=(m:Memory)=>m.revision??1;
export const memoryDependency=(m:Memory)=>({id:m.id,revision:memoryRevision(m),text:m.text,kind:m.kind,versionStartsAt:m.versionStartsAt,startsAt:m.startsAt,expiresAt:m.expiresAt});
const compact=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const trainingIntent=(q:string)=>/练|训练|动作|健身|重量|卧推|深蹲|跑步|RIR|恢复|疼|痛|不适|膝|肩|腰|腕/.test(q);
const health=(m:Memory)=>/^health\./.test(m.topicKey??'')||/疼|痛|不适|受伤|过敏|禁忌|恢复|疲劳|睡眠|没睡|睡不好/.test(m.text);
function hits(query:string,text:string){const q=compact(query),t=compact(text);let n=0;for(let i=0;i<q.length-1;i++)if(t.includes(q.slice(i,i+2)))n++;return n;}
export function selectMemories(memories:Memory[],purpose:MemoryPurpose,query:string,now=new Date()) {
 const budget=purpose==='weekly'?1600:purpose==='meal'?1200:purpose==='training'?2000:purpose==='memory'?2400:800;
 const active=memories.filter(m=>validMemory(m,now)),train=purpose==='training'||purpose==='weekly'||trainingIntent(query),diet=purpose==='meal'||/吃|餐|食|饿|饱|蛋白|补剂|奶/.test(query);
 const exactActions=active.filter(m=>m.autoCategory==='training'&&compact(query).includes(compact(m.text.split('：')[0])));
 const scored=active.map(m=>{
  const h=hits(query,`${m.text} ${m.topicKey??''} ${m.food?.name??''} ${m.food?.brand??''}`),topic=m.topicKey??'';
  let score=0;
  if(train&&health(m))score=1000+h;
  else if(m.kind==='food'&&h)score=800+h;
  else if(m.autoCategory==='training'){
   const name=m.text.split('：')[0];
   if(!train)return {m,score:0};
   if(/窄距|碎颅|臂屈伸|三头/.test(name)&&!/窄距|碎颅|臂屈伸|三头/.test(query))return {m,score:0};
   score=exactActions.includes(m)?750+h:h?450+h:exactActions.length?0:200;
  }else if(m.autoCategory==='meal')score=diet&&h?500+h:0;
  else if(m.kind==='fact')score=/^(communication|recording)\./.test(topic)?600+h:h?650+h:(diet&&/^eating\./.test(topic)||train&&/^training\./.test(topic))?550:purpose==='memory'?100:20;
  else if(m.kind==='state')score=h?550+h:purpose==='weekly'?250:0;
  else if(m.kind==='hypothesis')score=h?50+h:0;
  return {m,score};
 }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.m.startsAt.localeCompare(a.m.startsAt)||a.m.id.localeCompare(b.m.id));
 const items:Memory[]=[];let chars=0,omitted=0,omittedChars=0;
 let serializedChars=2;const serializedBudget=budget*4;
 for(const {m} of scored){const size=m.text.length,wire=JSON.stringify(m).length+1;if(chars+size>budget||serializedChars+wire>serializedBudget){omitted++;omittedChars+=size;continue;}items.push(m);chars+=size;serializedChars+=wire;}
 return {items,chars,omitted,omittedChars,budget,serializedChars,serializedBudget};
}
