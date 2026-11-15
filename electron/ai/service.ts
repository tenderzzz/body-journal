import {analysisInstructions} from './prompts/analysis';
import {chatInstructions} from './prompts/chat';
import {CURRENT_PROMPT,type PromptVersion} from './prompts/version';
export {ACTIVITY_EXTRACTION_INSTRUCTIONS} from './prompts/base';
import {journalDay} from '../../src/shared/dates';
import {normalizeModelOutput} from './model-output';
import { coachInstructions,looksLikeTrainingLog } from '../core/coaching';
import { chatResponseSchema,readableError } from '../core/validation';
import { streamingAnswer } from './chat-format';
import { randomUUID } from 'node:crypto';
import { localDay,needsAnalysis } from '../../src/shared/stats';
import {memoryDependency,memoryRevision} from '../core/memory';
import {matchDish,dishNameSimilarity} from '../../src/shared/dishes';
import { mealSlot } from '../../src/shared/meals';
import type { Message, Provider, BatchAnalysisResult, HealthRecord, AnalysisQueueReceipt } from '../../src/shared/types';
import { HealthStore } from '../core/store';
import { ChatGPTAuth, RESOURCE, type SecretStorage } from './auth';
import { readOpenAI, readDeepSeek, parseModelJSON } from './transport';
import {defaultNetworkFetch,networkError,type NetworkFetch} from './network';

// A shared service failure must not create further charged attempts across the queue.
function isBatchServiceFailure(error:Error){return /额度|预算|网络|代理|安全连接|响应流|回答被中断|请求已取消|请求.{0,8}超时|模型请求没有完成|模型响应超时|模型没有返回完整用量|未获得模型使用权限|授权|(?:模型|账号).{0,8}(?:连接|权限|不可用)|请先.{0,16}(?:登录|连接|设置)/.test(error.message);}
type QueuedAnalysis={id:string;revision:number;pendingOnly:boolean};
type AnalysisSession={queue:QueuedAnalysis[];current?:QueuedAnalysis;index:number;running:boolean;result:BatchAnalysisResult;completion:Promise<BatchAnalysisResult>;resolve:(result:BatchAnalysisResult)=>void};
const emptyAnalysisResult=():BatchAnalysisResult=>({total:0,completed:0,failed:0,skipped:0,cancelled:false,remaining:[],items:[]});

export class AssistantService {
  private active?:AbortController;
  private busy=false;
  private taskSettings?:ReturnType<HealthStore['getSettings']>;
  private taskId?:string;
  private analysisSession?:AnalysisSession;
  private settings(){return this.taskSettings??this.store.getSettings();}
  private modelRun(){
    const settings=this.settings();
    return {provider:settings.provider,model:settings.provider==='chatgpt'?settings.chatgptModel:settings.deepseekModel,promptVersion:this.promptVersion};
  }
  private cancelRequested=false;
  constructor(private store:HealthStore,private auth:ChatGPTAuth,private secrets:SecretStorage,private emit:(e:Record<string,unknown>)=>void,private prepareImage:(data:string)=>string=(data)=>data,private networkFetch:NetworkFetch=defaultNetworkFetch,private requestTimeoutMs=180000,private promptVersion:PromptVersion=CURRENT_PROMPT) {}
  isBusy(){return this.busy;}
  cancel(taskId?:string){
    if(taskId&&taskId!==this.taskId)return;this.cancelRequested=true;this.active?.abort();
    const session=this.analysisSession;
    if(session&&!session.running){session.result.cancelled=true;session.result.remaining=session.queue.map(item=>item.id);this.analysisSession=undefined;this.emit({type:'analysis-complete',result:session.result});session.resolve(session.result);}
  }
  private async request(instructions:string,text:string,images:string[],provider:Provider,onDelta:(s:string)=>void) {
    const settings=this.settings();images=images.map(this.prepareImage);let token:string,usageId:string|undefined;
    const controller=this.active=new AbortController(),deadline=AbortSignal.timeout(this.requestTimeoutMs); const signal=AbortSignal.any([controller.signal,deadline]);
    try{
      // Token refresh can fail before inference starts; it uses the same error handling,
      // without reserving usage for an inference request that was never sent.
      if(provider==='chatgpt'){token=await this.auth.accessToken();if(!settings.chatgptModel)throw new Error('请先在设置中选择 ChatGPT 模型。');}
      else{const saved=await this.secrets.read();token=String(saved.deepseekKey??'');if(!token)throw new Error('请先在设置中保存 DeepSeek API 密钥和月预算。');}
      signal.throwIfAborted();
      // Peak, uncached rates are conservative; images reserve 20k tokens each.
      const estimate=provider==='deepseek'?((Buffer.byteLength(text+instructions)*1.1+images.length*20000+1000)*settings.deepseekInputPrice+6144*settings.deepseekOutputPrice)/1e6:0;
      usageId=this.store.reserveUsage(provider,estimate);
      const openAI=provider==='chatgpt';
      const body=openAI?{model:settings.chatgptModel,instructions,input:[{role:'user',content:[{type:'input_text',text},...images.map(image_url=>({type:'input_image',image_url}))]}],store:false,stream:true}:{model:settings.deepseekModel,messages:[{role:'system',content:instructions},{role:'user',content:[{type:'text',text},...images.map(url=>({type:'image_url',image_url:{url}}))]}],thinking:{type:'disabled'},max_tokens:6144,stream:true,stream_options:{include_usage:true}};
      const response=await this.networkFetch(openAI?`${RESOURCE}/responses`:'https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body),signal});
      const result=await(openAI?readOpenAI(response,onDelta):readDeepSeek(response,onDelta));
      const cost=provider==='deepseek'?(result.input*settings.deepseekInputPrice+result.output*settings.deepseekOutputPrice)/1e6:0;
      this.store.finishUsage(usageId,result.input,result.output,cost);return result;
    }catch(e){if(usageId)this.store.failUsage(usageId);if(signal.aborted)throw new Error((controller.signal.aborted?'分析已由你取消。':'模型响应超时。')+(usageId?'原始输入和上次结果已保留；未确认的调用费用暂按预留额度计算。':'尚未发送模型请求，原始输入已保留。'));throw networkError(e,provider==='chatgpt'?'ChatGPT 服务':'DeepSeek 服务');}finally{this.active=undefined;}
  }
  async exclusive<T>(fn:()=>Promise<T>):Promise<T>{if(this.busy)throw new Error('当前分析尚未完成，请稍候或取消。');this.cancelRequested=false;this.taskSettings=structuredClone(this.store.getSettings());this.taskId=randomUUID();this.busy=true;this.emit({type:'busy',value:true,taskId:this.taskId});try{return await fn();}finally{this.busy=false;this.taskSettings=undefined;this.emit({type:'busy',value:false,taskId:this.taskId});this.taskId=undefined;queueMicrotask(()=>this.pumpAnalysis());}}
  enqueueAnalysis(ids:string[],options:{pendingOnly?:boolean}={}):AnalysisQueueReceipt{return this.scheduleAnalysis(ids,options).receipt;}
  private scheduleAnalysis(ids:string[],options:{pendingOnly?:boolean}={}):{receipt:AnalysisQueueReceipt;completion:Promise<BatchAnalysisResult>}{
    const records=[...new Set(ids)].map(id=>this.store.record(id));
    if(!records.length)return {receipt:{ids:[],queued:0},completion:Promise.resolve(emptyAnalysisResult())};
    if(!this.analysisSession){
      let resolve!:AnalysisSession['resolve'];const completion=new Promise<BatchAnalysisResult>(done=>resolve=done);
      this.analysisSession={queue:[],index:0,running:false,result:emptyAnalysisResult(),completion,resolve};
    }
    const session=this.analysisSession;
    for(const record of records){
      const waiting=session.queue.find(item=>item.id===record.id);
      if(waiting){waiting.revision=record.revision;waiting.pendingOnly=waiting.pendingOnly&&!!options.pendingOnly;}
      else if(session.current?.id!==record.id||session.current.revision!==record.revision){session.queue.push({id:record.id,revision:record.revision,pendingOnly:!!options.pendingOnly});session.result.total++;}
      if(!options.pendingOnly||needsAnalysis(record))this.store.markAnalysisQueued(record.id);
    }
    this.emit({type:'analysis-queued',ids:session.queue.map(item=>item.id),activeId:session.current?.id,index:session.index,total:session.result.total,queued:session.queue.length,completed:session.result.completed,failed:session.result.failed});
    this.emit({type:'changed',scopes:['records','overview']});
    this.pumpAnalysis();
    return {receipt:{ids:records.map(r=>r.id),queued:session.queue.length,activeId:session.current?.id},completion:session.completion};
  }
  async analyze(ids:string[],options:{pendingOnly?:boolean}={}) {
    if(!ids.length)return emptyAnalysisResult();
    const result=await this.scheduleAnalysis(ids,options).completion;
    const item=result.items.findLast(item=>item.id===ids[0]);
    if(new Set(ids).size===1&&!options.pendingOnly&&(item?.status==='failed'||item?.status==='cancelled'))throw new Error(item.error);
    return result;
  }
  private pumpAnalysis(){
    const session=this.analysisSession;if(this.busy||!session||session.running)return;
    session.running=true;
    void this.exclusive(async()=>{
    const result=session.result;
    this.emit({type:'analysis-start',total:result.total});
    while(session.queue.length){
      if(this.cancelRequested){result.cancelled=true;result.remaining=session.queue.map(item=>item.id);break;}
      const entry=session.current=session.queue.shift()!,{id}=entry;session.index++;
      let revision:number|undefined;
      try{
        const current=this.store.record(id);revision=entry.revision=current.revision;
        if(current.deleted||(entry.pendingOnly&&!needsAnalysis(current))){result.skipped++;result.items.push({id,status:'skipped'});this.emit({type:'analysis-result',item:result.items.at(-1),completed:result.completed,failed:result.failed,total:result.total,queued:session.queue.length});session.current=undefined;continue;}
        this.store.markAnalysisStarted(id,revision);
        this.emit({type:'analysis-progress',id,index:session.index,total:result.total,completed:result.completed,failed:result.failed,queued:session.queue.length});
        const record=await this.analyzeRecord(id);
        result.completed++;result.items.push({id,status:'completed',record});
      }catch(error){
        const e=new Error(readableError(error));
        const superseded=!this.cancelRequested&&revision!==undefined&&this.store.record(id).revision!==revision&&session.queue.some(item=>item.id===id)&&/记录已修改/.test(e.message);
        if(superseded){result.skipped++;result.items.push({id,status:'skipped'});}
        else{
          if(revision!==undefined)this.store.markAnalysisFailure(id,revision,e.message);
          if(this.cancelRequested){result.cancelled=true;result.items.push({id,status:'cancelled',error:e.message});result.remaining=[id,...session.queue.map(item=>item.id)];}
          else{result.failed++;result.items.push({id,status:'failed',error:e.message});if(isBatchServiceFailure(e))result.remaining=session.queue.map(item=>item.id);}
        }
        this.emit({type:'changed',scopes:['records','messages','overview','profile','energy']});
      }
      session.current=undefined;
      this.emit({type:'analysis-result',item:result.items.at(-1),completed:result.completed,failed:result.failed,total:result.total,queued:session.queue.length});
      if(result.cancelled||result.remaining.length)break;
    }
    this.analysisSession=undefined;
    this.emit({type:'analysis-complete',result});
    return result;
    }).then(session.resolve,error=>{
      if(this.analysisSession===session)this.analysisSession=undefined;
      session.result.failed++;session.result.remaining=session.queue.map(item=>item.id);
      this.emit({type:'analysis-complete',result:session.result,error:readableError(error)});session.resolve(session.result);
    });
  }
  private async analyzeRecord(id:string):Promise<HealthRecord>{
    const r=this.store.record(id),previousAnalysis=r.kind==='meal'?(r.analysis?.ingredients?.length?r.analysis:r.followups?.at(-1)?.previousAnalysis??r.analysis):(r.followups?.at(-1)?.previousAnalysis??r.analysis);const personalFoods=this.store.foodPresets(new Date(r.occurredAt)).sort((a,b)=>Number(r.text.includes(b.name))-Number(r.text.includes(a.name))).slice(0,12);
    const dishes=r.kind==='meal'?this.store.commonDishes(new Date(r.occurredAt)).filter(d=>d.active):[];
    const commonDish=matchDish(r,dishes);
    const matchedDish=dishes.find(d=>d.id===commonDish?.id);
    const commonDishCandidates=dishes.filter(d=>d.id!==commonDish?.id).sort((a,b)=>dishNameSimilarity(r.text,b.name)-dishNameSimilarity(r.text,a.name)).slice(0,8).map(d=>({id:d.id,name:d.name,brand:d.brand,aliases:d.aliases,sourceRecordId:d.latestRecordId,ingredients:d.template}));
    const foods=this.store.catalog.promptCatalog(r.text).map(f=>({id:f.id,name:f.zh??f.description,description:f.description}));
    const selection=this.store.memoryContext(r.kind==='training'?'training':'meal',r.text,new Date(r.occurredAt));
    const personalMemories=selection.items.filter(m=>!commonDish||m.autoCategory!=='meal'||m.subject!==commonDish.id).slice(0,40).map(({id,revision,kind,text,subject,versionStartsAt,startsAt,expiresAt,evidence,confirmed,mealTemplate,topicKey,food})=>({id,revision,kind,text,subject,versionStartsAt,startsAt,expiresAt,evidence,confirmed,mealTemplate,topicKey,food:food?{name:food.name,brand:food.brand}:undefined}));
    const mealHistory=r.kind==='meal'&&/一样|照旧|同上|同款|相同/.test(r.text)?this.store.records().filter(x=>!x.deleted&&x.kind==='meal'&&x.id!==r.id&&Date.parse(x.occurredAt)<=Date.parse(r.occurredAt)&&Date.parse(x.occurredAt)>=Date.parse(r.occurredAt)-90*86400000&&x.analysis?.ingredients?.length).sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt)).slice(0,40).map(x=>({id:x.id,occurredAt:x.occurredAt,day:journalDay(x.occurredAt,this.store.getSettings().timezone),slot:mealSlot(x.occurredAt,x.timezone),text:x.text.slice(0,240),ingredients:x.analysis!.ingredients!.map(i=>({name:i.name,grams:i.grams,amount:i.amount,consumedFraction:i.consumedFraction,portionSource:i.portionSource,foodState:i.foodState,productId:i.productId})),macros:x.analysis!.macros?{kcal:x.analysis!.macros.kcal,protein:x.analysis!.macros.protein}:undefined})):[];
    const prompt=JSON.stringify({personalMemories,personalFoods,mealHistory,commonDish:matchedDish?{id:matchedDish.id,name:matchedDish.name,brand:matchedDish.brand,sourceRecordId:matchedDish.latestRecordId,occurredAt:matchedDish.latestAt,...(!previousAnalysis?.ingredients?.length?{ingredients:matchedDish.template}:{})}:undefined,commonDishCandidates,now:new Date().toISOString(),record:{id:r.id,kind:r.kind,occurredAt:r.occurredAt,timeSource:r.timeSource,dateResolution:r.dateResolution,text:r.text,attachments:r.attachments.map(a=>({sha256:a.sha256,name:a.name})),body:r.body,previousIngredients:previousAnalysis?.ingredients,followups:r.followups?.map(({answer,questions,at})=>({answer,questions,at})),previousAnalysis:previousAnalysis?{summary:previousAnalysis.summary,questions:previousAnalysis.questions,assumptions:previousAnalysis.assumptions,training:previousAnalysis.training,sets:previousAnalysis.sets,run:previousAnalysis.run}:undefined},foodCatalog:foods});
    const response=await this.request(analysisInstructions(r.kind,r.kind==='training'?coachInstructions(this.store.coachProfile(),'训练记录').text:'',this.promptVersion),prompt,r.attachments.slice(0,4).map((_,i)=>this.store.attachmentData(id,i)),this.settings().provider,()=>{});
    if(this.cancelRequested)throw new Error('分析已取消，尚未保存这条结果。');
    const value=parseModelJSON(response.text),record=this.store.applyAnalysis(id,value,this.settings().provider,r.revision,false,this.modelRun());this.store.saveEpisodeCandidates((value as any)?.episodeCandidates,{recordId:id,recordRevision:record.revision},r.text,r.occurredAt);this.emit({type:'changed',scopes:['records','overview','energy','profile','trends','messages']});return record;
  }
  async chat(question:string){return this.exclusive(async()=>{
    question=question.trim();if(!question||question.length>10000)throw new Error('请输入 1–10000 字的问题');
    this.store.energy.syncTarget();this.store.energy.invalidate();this.store.invalidateMemoryAnswers();
    const expectedCoach=JSON.stringify(this.store.coachProfile());
    const provider=this.settings().provider,expectedMemories=this.store.memories(),expectedGoals=this.store.getSettings().goals;
    const memoryOnly=/记住|记下|更新.*记忆|更正|纠正|以后|默认|忘掉|停用/.test(question)&&!/[？?]|怎么|如何|能不能|可以吗/.test(question)&&!looksLikeTrainingLog(question),weeklyQuestion=/本周复盘|周复盘|每周复盘|下周计划|这周总结|本周总结/.test(question);
    const context=this.store.context(question,memoryOnly?'memory':weeklyQuestion?'weekly':'chat'),mode=coachInstructions(this.store.coachProfile(),question);
    const energy=context.energy;
    const previous=context.conversation;
    const user:Message={id:randomUUID(),role:'user',text:question,createdAt:new Date().toISOString(),status:'complete',sources:[],provider,stale:false};this.store.putMessage(user);
    const reply:Message={id:randomUUID(),role:'assistant',...(context.clarification?{}:{modelRun:this.modelRun()}),text:'',createdAt:new Date().toISOString(),status:'streaming',sources:[],provider,stale:false};this.store.putMessage(reply);this.emit({type:'changed',scopes:['messages','overview','profile','energy']});
    const draft=looksLikeTrainingLog(question)?question:undefined;
    if(context.clarification){this.store.putMessage({...reply,provider:'local',text:context.clarification,status:'complete',contextReceipt:{dayPolicy:context.dayPolicy,stepPeriod:context.stepPeriod,promptVersion:context.promptVersion,period:context.query.period,provided:[],cited:[],memories:[]}});this.emit({type:'changed',scopes:['messages','overview','profile','energy']});return context.clarification;}
    try{
      const requestContext=memoryOnly?{goals:context.goals,memories:context.memories.filter(m=>m.kind!=='habit'),records:[],coverage:{included:0,scope:'本次只更新明确记忆，不需要训练和饮食原始日志'}}:context;
      const memorySources=context.memorySources;
      const result=await this.request(chatInstructions(mode.text,!!context.query.historical,!!energy,this.promptVersion),JSON.stringify({question,mode:mode.mode,conversation:memoryOnly?previous.slice(-2):previous,context:requestContext,memorySources:memoryOnly?[]:memorySources,editableMemories:context.memories.map(m=>({id:m.id,revision:memoryRevision(m),key:m.topicKey,text:m.text,subject:m.subject,kind:m.kind,versionStartsAt:m.versionStartsAt,startsAt:m.startsAt,expiresAt:m.expiresAt}))}),[],provider,text=>this.emit({type:'chat-delta',id:reply.id,text:streamingAnswer(text)}));
      const normalized=normalizeModelOutput(parseModelJSON(result.text),'chat');
      const parsed=chatResponseSchema.parse(normalized.value),answer=parsed.answerMarkdown;
      const allowed=new Map(requestContext.records.map(r=>[r.id,r.revision])),cites=[...answer.matchAll(/\[记录:([a-zA-Z0-9_-]+)\]/g)].map(m=>m[1]);
      if(cites.some(id=>!allowed.has(id)))throw new Error('回答引用了不存在的记录，未保存为完整结论，请重新提问。');
      const memoryIds=new Set(context.memories.map(m=>m.id)),messageIds=new Set([...previous.map(m=>m.id),...memorySources.map(m=>m.id),user.id]);
      if([...answer.matchAll(/\[记忆:([a-zA-Z0-9_-]+)\]/g)].some(m=>!memoryIds.has(m[1]))||[...answer.matchAll(/\[对话:([a-zA-Z0-9_-]+)\]/g)].some(m=>!messageIds.has(m[1])))throw new Error('回答的记忆或对话依据不存在，请重试。');
      if(context.records.length&&!cites.length&&!parsed.memoryChanges.length&&!draft&&/最近.*(?:怎么样|变化|训练|身体)|本周复盘|上次.*(?:表现|重量)/.test(question))throw new Error('这份分析缺少记录依据，请重试。');
      const sources=[...new Set(cites)].map(id=>({id,revision:allowed.get(id)!}));const stale=JSON.stringify(this.store.getSettings().goals)!==JSON.stringify(expectedGoals)||JSON.stringify(this.store.coachProfile())!==expectedCoach||sources.some(s=>this.store.record(s.id).revision!==s.revision)||context.memories.some(m=>{const available=context.query.period?this.store.memoriesAt(new Date(context.query.period.asOf)):this.store.memories();const current=available.find(c=>c.id===m.id);return !current||memoryRevision(current)!==memoryRevision(m);})||!!energy&&this.store.energy.hash(energy.dependency.from,energy.dependency.to)!==energy.dependency.hash;
      if(parsed.goalProposal&&(!energy||!/目标|调整/.test(question)))throw new Error('本次未请求目标调整，未保存数值建议');
      this.store.completeChat({...reply,memoryWarnings:normalized.memoryWarnings,memoryDependency:context.memories.map(memoryDependency),contextReceipt:{dayPolicy:context.dayPolicy,stepPeriod:context.stepPeriod,promptVersion:context.promptVersion,period:context.query.period,provided:requestContext.records.map(r=>({id:r.id,revision:r.revision})),cited:sources,memories:context.memories.map(memoryDependency)},text:answer,status:'complete',sources,stale,trainingDraft:draft,...(energy?{energyDependency:energy.dependency}:{})},parsed.memoryChanges,user,expectedMemories,expectedGoals,parsed.goalProposal&&energy?{value:parsed.goalProposal,hash:energy.proposalHash}:undefined);this.store.saveEpisodeCandidates(parsed.episodeCandidates,{messageId:user.id},user.text,user.createdAt);this.emit({type:'changed',scopes:['messages','overview','profile','energy']});return answer;
    }catch(e){const error=e instanceof Error?e.message:'请求失败';this.store.putMessage({...reply,text:'',status:'failed',error});this.emit({type:'changed',scopes:['messages','overview','profile','energy']});throw e;}
  });}
  async testConnection(image:string){return this.exclusive(async()=>{const r=await this.request('请用简体中文简短回答。','这是应用自检用的无个人信息图像。请描述它的主色，并回复“图文连接可用”。',[image],this.settings().provider,()=>{});return r.text;});}
}
