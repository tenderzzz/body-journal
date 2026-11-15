import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Provider} from '../../src/shared/types';
import {HealthStore} from '../../electron/core/store';
import {FoodCatalog} from '../../electron/core/nutrition';
import {AssistantService} from '../../electron/ai/service';
import type {ChatGPTAuth} from '../../electron/ai/auth';
import type {PromptVersion} from '../../electron/ai/prompts/version';
import type {NetworkFetch} from '../../electron/ai/network';
import {parseModelJSON,readOpenAI,readDeepSeek} from '../../electron/ai/transport';
import {priorMeal,ingredient,type GoldenCase} from './prompt-golden';

function seed(store:HealthStore,c:GoldenCase){
  const zone='Asia/Shanghai',at='2026-10-22T12:00:00+08:00';
  if(c.rule)store.saveMemory({text:c.rule,kind:'fact',topicKey:'recording.conventions',startsAt:'2020-01-01T00:00:00Z',expiresAt:null,active:true,confirmed:true,sourceIds:[]});
  if(c.history==='training')store.importEnvelope({id:'synthetic-old-lift',version:1,kind:'training',text:'卧推 50kg 3×8',occurredAt:'2026-10-21T18:00:00+08:00',timezone:zone});
  if(c.history&&c.history!=='training'){
    const meals=c.history==='twoMeals'?[priorMeal,'synthetic-second-meal']:[priorMeal];
    for(const [i,id] of meals.entries()){
      const items=i?[ingredient('鸡蛋',100)]:[ingredient('米饭',120),ingredient('鸡蛋',50)];
      const meal=store.importEnvelope({version:1,id,kind:'meal',text:i?'晚餐鸡蛋100克':'午餐米饭120克、鸡蛋50克',occurredAt:i?'2026-10-21T18:00:00+08:00':'2026-10-21T12:00:00+08:00',timezone:zone}).record;
      store.applyAnalysis(id,{summary:'合成历史餐食',ingredients:items},'local',meal.revision);
    }
    if(c.history==='deletedMeal')store.setRecordDeleted(priorMeal,true);
  }
  if(c.kind!=='chat')store.importEnvelope({version:1,id:'synthetic-current',kind:c.kind,text:c.text,occurredAt:at,timezone:zone});
}

function replayResponse(c:GoldenCase,provider:Provider){
  const text=JSON.stringify(c.replay);
  const events=provider==='chatgpt'?[{type:'response.output_text.delta',delta:text},{type:'response.completed',response:{usage:{input_tokens:80,output_tokens:30}}}]:
    [{choices:[{delta:{content:text}}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:80,completion_tokens:30}},'[DONE]'];
  return new Response(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''));
}

export type GoldenOptions={
  version:PromptVersion;provider:Provider;model:string;key?:string;send?:NetworkFetch;
  // Both versions receive byte-identical synthetic user content, including dates and IDs.
  inputs?:Map<string,string>;
};
export async function runGoldenCase(c:GoldenCase,options:GoldenOptions){
  const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-golden-')),store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);
  const {version,provider,model}=options;
  const errors:string[]=[],checked=Object.keys(c.fields).length;
  let matched=0,miswrite=false,remembered=false,bytes=0,calls=0,rawInvented=false;
  try{
    store.setSettings({...store.getSettings(),provider,chatgptModel:model,deepseekBudget:100});
    seed(store,c);
    const before=new Map(store.memories().map(m=>[m.id,m.revision]));
    let request:Record<string,any>={};
    const transport:NetworkFetch=async(url,init)=>{
      const body=JSON.parse(String(init?.body)),open=provider==='chatgpt';
      const part=open?body.input[0].content[0]:body.messages[1].content[0];
      const fixed=options.inputs?.get(c.id);
      if(fixed!==undefined)part.text=fixed;
      else options.inputs?.set(c.id,part.text);
      request=JSON.parse(part.text);
      bytes=Buffer.byteLength((open?body.instructions:body.messages[0].content)+part.text);
      calls++;
      if(!options.send)return replayResponse(c,provider);
      if(open)body.max_output_tokens=6144;
      const response=await options.send(url,{...init,body:JSON.stringify(body)});
      if(response.ok&&c.group==='缺失数字'){
        const modelResult=await (open?readOpenAI:readDeepSeek)(response.clone(),()=>{});
        const raw=parseModelJSON(modelResult.text) as {sets?:{kg?:number|null}[];run?:{minutes?:number;km?:number};dailyActivity?:{walkingKm?:number}};
        rawInvented=Object.hasOwn(c.fields,'kg')&&c.fields.kg===null&&!!raw.sets?.some(set=>set.kg!=null);
        rawInvented=Boolean(rawInvented||(c.fields.runMinutes===null&&raw.run?.minutes!=null)||(c.fields.runKm===null&&raw.run?.km!=null)
          ||(c.fields.setCount===0&&raw.sets?.length)||(c.fields.walkingKm===null&&raw.dailyActivity?.walkingKm!=null));
      }
      return response;
    };
    const token=options.key??'synthetic-no-network';
    const service=new AssistantService(store,{accessToken:async()=>token} as ChatGPTAuth,{read:async()=>({deepseekKey:token}),write:async()=>{}},()=>{},image=>image,transport,180000,version);
    try{
      if(c.kind==='chat')await service.chat(c.text);else await service.analyze(['synthetic-current']);
    }catch(error){errors.push(error instanceof Error?error.message:'模型调用失败');}
    const a=c.kind==='chat'?null:store.record('synthetic-current').analysis;
    const reply=c.kind==='chat'?store.messages().at(-1):null;
    const complete=(a?.modelRun??reply?.modelRun)?.promptVersion===version&&(reply?reply.status==='complete':a?.engine===provider);
    const set=a?.sets?.[0],items=a?.ingredients??[];
    const grams=(name:string)=>items.find(i=>i.name===name)?.grams?.low??null;
    const actual:Record<string,unknown>={complete,kg:set?.kg??null,reps:set?.reps,sets:set?.sets,basis:set?.loadBasis,confirmed:set?.confirmed,
      question:!!a?.questions.length,setCount:a?.sets?.length??0,runKm:a?.run?.km??null,runMinutes:a?.run?.minutes??null,
      steps:a?.dailyActivity?.steps,walkingKm:a?.dailyActivity?.walkingKm??null,coverage:a?.dailyActivity?.coverage,
      items:items.length,copied:!!a?.copiedFrom,riceGrams:grams('米饭'),eggGrams:grams('鸡蛋'),
      historyCount:request.mealHistory?.length,ruleSent:request.personalMemories?.some((m:{text:string})=>m.text===c.rule)};
    if(!complete)errors.push('未保存带版本的有效主结果');
    for(const [field,wanted] of Object.entries(c.fields)){
      if(complete&&actual[field]===wanted)matched++;
      else errors.push(field+' 预期 '+JSON.stringify(wanted)+'，得到 '+JSON.stringify(actual[field]));
    }
    const changes=store.memories().filter(m=>m.confirmed&&before.get(m.id)!==m.revision);
    const expected=(m:typeof changes[number])=>!!c.memoryQuote&&m.evidence?.some(e=>e.quote.includes(c.memoryQuote!));
    remembered=!!c.memoryQuote&&changes.some(expected);
    miswrite=changes.some(m=>!expected(m));
    if(miswrite)errors.push('写入未获依据的已确认记忆');
    if(c.memoryQuote&&!remembered)errors.push('应写入的记忆缺失');
    if(rawInvented)errors.push('模型编造缺失数字');
    if(!options.send&&c.expectWarning&&!(a?.memoryWarnings??reply?.memoryWarnings)?.length)errors.push('缺少跳过记忆候选的提示');
    if(calls!==1)errors.push('用例应有且仅有一次请求');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
  return {id:c.id,group:c.group,version,checked,matched,shouldWrite:!!c.memoryQuote,miswrite,remembered,rawInvented,errors,calls,bytes};
}
export type GoldenResult=Awaited<ReturnType<typeof runGoldenCase>>;

export function scoreGolden(rows:GoldenResult[]){
  return [...new Set(rows.map(r=>r.group))].map(group=>{
    const cases=rows.filter(r=>r.group===group),negative=cases.filter(r=>!r.shouldWrite),positive=cases.filter(r=>r.shouldWrite);
    return {group,fields:[cases.reduce((n,c)=>n+c.matched,0),cases.reduce((n,c)=>n+c.checked,0)],
      falseWrites:[negative.filter(r=>r.miswrite).length,negative.length],correctWrites:[positive.filter(r=>r.remembered).length,positive.length],
      failures:cases.filter(c=>c.errors.length).map(({id,errors})=>({id,errors}))};
  });
}
