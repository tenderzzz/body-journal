export type InferenceResult={text:string;input:number;output:number};
export async function* sseEvents(body:ReadableStream<Uint8Array>) {
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='',ended=false;
  try { while(true) {const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n'); let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const lines=event.split('\n').filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart());if(lines.length)yield lines.join('\n');}if(done){ended=true;break;}} if(buffer.trim()) {const lines=buffer.split('\n').filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart());if(lines.length)yield lines.join('\n');} }finally{
    // A terminal event ends inference even when a proxy keeps the HTTP body open.
    // Cleanup must not delay a complete result or replace it with a cleanup error.
    if(!ended){try{void reader.cancel().catch(()=>{});}catch{}}
    reader.releaseLock();
  }
}
export function providerError(code:string):Error {
  if(/usage_limit|rate_limit|insufficient_quota|insufficient_balance/.test(code)) return new Error('模型额度不足或暂时受限。输入已保留，请查看用量或稍后重试；不会自动切换付费渠道。');
  if(/sharing_usage_unavailable/.test(code)) return new Error('此账号暂时无法使用共享订阅额度。可以查看 ChatGPT 用量设置或手动选择其他渠道。');
  if(/auth|token|401/.test(code)) return new Error('模型连接已失效，请在设置中重新连接。');
  return new Error('模型请求没有完成。输入已保留，请检查网络、模型权限后重试。');
}
export async function readOpenAI(response:Response,onDelta:(text:string)=>void):Promise<InferenceResult> {
  if(!response.ok) {let code=String(response.status);try{code=(await response.json() as {error?:{code?:string}}).error?.code??code;}catch{}throw providerError(code);}
  if(!response.body)throw new Error('模型未返回响应流');
  let text='',completed=false,input=0,output=0;
  for await(const data of sseEvents(response.body)) {
    if(data==='[DONE]')continue;const e=JSON.parse(data);
    if(e.type==='response.output_text.delta'){text+=e.delta??'';onDelta(text);}
    if(['response.failed','response.incomplete','error'].includes(e.type))throw providerError(e.response?.error?.code??e.error?.code??e.code??'incomplete');
    if(e.type==='response.completed'){completed=true;input=e.response?.usage?.input_tokens??0;output=e.response?.usage?.output_tokens??0;break;}
  }
  if(!completed||!text.trim())throw new Error('回答被中断，未作为完整结论保存。请重试。');return {text,input,output};
}
export async function readDeepSeek(response:Response,onDelta:(text:string)=>void):Promise<InferenceResult> {
  if(!response.ok)throw providerError(String(response.status));if(!response.body)throw new Error('模型未返回响应流');
  let text='',finished=false,done=false,input=0,output=0,usage=false;
  for await(const data of sseEvents(response.body)) {
    if(data==='[DONE]'){done=true;break;}const e=JSON.parse(data);if(e.error)throw providerError(e.error.code??'error');
    const c=e.choices?.[0];if(c?.delta?.content){text+=c.delta.content;onDelta(text);}if(c?.finish_reason){if(c.finish_reason!=='stop')throw new Error('回答未正常结束，结果没有作为完整结论保存。');finished=true;}
    if(e.usage){input=e.usage.prompt_tokens??0;output=e.usage.completion_tokens??0;usage=true;}
  }
  if(!done||!finished||!text.trim())throw new Error('回答被中断，请重试。');if(!usage)throw new Error('模型没有返回完整用量，本次预留费用暂时保留，请核对服务商账单。');return {text,input,output};
}
export function parseModelJSON(text:string):unknown { const clean=text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');try{return JSON.parse(clean);}catch{throw new Error('模型返回的结构化结果不完整，原始记录已保留，请重新分析。');} }
