import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ChatGPTAuth,createChatGPTJWKSet,type SecretStorage} from '../electron/ai/auth';
import {AssistantService} from '../electron/ai/service';
import {defaultNetworkFetch,networkError,networkRequest,type NetworkFetch} from '../electron/ai/network';
import {providerError} from '../electron/ai/transport';
import {HealthStore} from '../electron/core/store';
import {FoodCatalog} from '../electron/core/nutrition';

function setup(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'bodyjournal-network-'));const store=new HealthStore(root,new FoodCatalog([]),root+'/inbox',false);store.setSettings({...store.getSettings(),chatgptModel:'synthetic-model'});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,store};}
const emptySecrets:SecretStorage={read:async()=>({}),write:async()=>{}};
function sse(answer='图文连接可用'){
 const events=[{type:'response.output_text.delta',delta:answer},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:5}}}];
 return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
}
function blockGlobalFetch(t:test.TestContext){const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Unexpected global fetch use');};t.after(()=>{globalThis.fetch=original;});}

test('default transport resolves global fetch at request time rather than capturing it',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('dynamic');};
 assert.equal(await(await defaultNetworkFetch('https://synthetic.invalid/')).text(),'dynamic');assert.equal(calls,1);
});

test('the injected transport handles token refresh, model listing and inference without global fetch',async t=>{
 const {root,store}=setup(t);blockGlobalFetch(t);
 let saved:Record<string,unknown>={chatgpt:{clientId:'synthetic-client',accessToken:'expired-synthetic-token',refreshToken:'synthetic-refresh-token',expiresAt:0,scope:'chatgpt.tokens.use.direct'}};
 const secrets:SecretStorage={read:async()=>saved,write:async next=>{saved=next;}};
 const urls:string[]=[],signals:AbortSignal[]=[];
 const request:NetworkFetch=async(url,init)=>{
  urls.push(url);assert.ok(init?.signal instanceof AbortSignal);signals.push(init.signal);
  if(url.endsWith('/oauth/token')){assert.equal(init.method,'POST');assert.equal(new URLSearchParams(String(init.body)).get('grant_type'),'refresh_token');return Response.json({access_token:'refreshed-synthetic-token',expires_in:3600,scope:'chatgpt.tokens.use.direct'});}
  assert.equal(new Headers(init.headers).get('Authorization'),'Bearer refreshed-synthetic-token');
  if(url.endsWith('/models'))return Response.json({models:[{slug:'synthetic-model',visibility:'list'}]});
  assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.method,'POST');return sse();
 };
 const auth=new ChatGPTAuth(root,secrets,async()=>{},()=>{},request);await auth.init();
 assert.deepEqual(await auth.listModels(),['synthetic-model']);
 const service=new AssistantService(store,auth,secrets,()=>{},x=>x,request);
 assert.equal(await service.testConnection('data:image/png;base64,synthetic'),'图文连接可用');
 assert.deepEqual(urls,['https://auth.openai.com/api/accounts/oauth/token','https://api.openai.com/v1/models','https://api.openai.com/v1/responses']);assert.equal(signals.length,3);assert.equal(service.isBusy(),false);
});

test('DeepSeek inference also uses the injected transport and keeps its selected provider',async t=>{
 const {store}=setup(t);blockGlobalFetch(t);store.setSettings({...store.getSettings(),provider:'deepseek',deepseekBudget:10});let calls=0;
 const secrets:SecretStorage={read:async()=>({deepseekKey:'synthetic-key'}),write:async()=>{}};
 const service=new AssistantService(store,{accessToken:async()=>{throw new Error('Unexpected ChatGPT switch');}} as unknown as ChatGPTAuth,secrets,()=>{},x=>x,async(url,init)=>{
  calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.ok(init?.signal instanceof AbortSignal);
  const events=[{choices:[{delta:{content:'图文连接可用'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:5}},'[DONE]'];
  return new Response(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''));
 });
 assert.equal(await service.testConnection('synthetic-image'),'图文连接可用');assert.equal(calls,1);assert.equal(store.db.prepare('SELECT provider FROM usage').get()!.provider,'deepseek');
});

test('remote JWKS retrieval uses jose customFetch with its verification timeout and redirect policy',async t=>{
 blockGlobalFetch(t);let calls=0;
 const keys=createChatGPTJWKSet(async(url,init)=>{calls++;assert.equal(url,'https://auth.openai.com/.well-known/jwks.json');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.ok(init?.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false);return Response.json({keys:[]});});
 await keys.reload();assert.equal(calls,1);assert.deepEqual(keys.jwks(),{keys:[]});
});

test('model directory body interruptions are mapped even after the HTTP response succeeds',async t=>{
 const {root}=setup(t);blockGlobalFetch(t);
 const secrets:SecretStorage={read:async()=>({chatgpt:{clientId:'synthetic-client',accessToken:'synthetic-token',expiresAt:Date.now()+3600000,scope:'chatgpt.tokens.use.direct'}}),write:async()=>{}};
 const auth=new ChatGPTAuth(root,secrets,async()=>{},()=>{},async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('fetch failed',{cause:Object.assign(new Error('reset'),{code:'ECONNRESET'})}));}})));
 await auth.init();await assert.rejects(()=>auth.listModels(),/模型目录网络连接未完成/);assert.match(auth.status().error??'',/网络连接未完成/);
});

test('transport mapping sanitizes recognised failures and preserves provider and validation errors',()=>{
 const cause=Object.assign(new Error('private request details'),{code:'ECONNREFUSED'});
 const mapped=networkError(new TypeError('fetch failed',{cause}),'ChatGPT 服务');assert.match(mapped.message,/网络连接/);assert.doesNotMatch(mapped.message,/private|ECONNREFUSED|fetch failed/);
 assert.match(networkError(new Error('net::ERR_PROXY_CONNECTION_FAILED at https://private.invalid/?secret=hidden')).message,/系统代理/);
 assert.doesNotMatch(networkError(new Error('net::ERR_PROXY_CONNECTION_FAILED at https://private.invalid/?secret=hidden')).message,/hidden|private/);
 assert.match(networkError(Object.assign(new Error('certificate'),{code:'ERR_CERT_AUTHORITY_INVALID'})).message,/安全连接校验/);
 for(const original of [providerError('401'),providerError('insufficient_quota'),new Error('模型目录返回格式与当前官方接口不符。'),new SyntaxError('invalid payload')])assert.equal(networkError(original),original);
});

test('network requests preserve AbortSignal and make one attempt only',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(()=>networkRequest(async(_url,init)=>{calls++;assert.equal(init?.signal,controller.signal);throw new DOMException('aborted','AbortError');},'https://synthetic.invalid/',{signal:controller.signal},'测试服务'),/请求已取消/);
 assert.equal(calls,1);
});

test('a token-refresh network failure is readable and reserves no inference usage',async t=>{
 const {store}=setup(t);blockGlobalFetch(t);let inferenceCalls=0;
 const auth={accessToken:async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('no route'),{code:'ETIMEDOUT'})});}} as unknown as ChatGPTAuth;
 const service=new AssistantService(store,auth,emptySecrets,()=>{},x=>x,async()=>{inferenceCalls++;return sse();});
 await assert.rejects(()=>service.testConnection('synthetic-image'),/连接超时/);
 assert.equal(inferenceCalls,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM usage').get()!.n,0);assert.equal(service.isBusy(),false);
});

test('a streaming network failure is safely mapped without retry or completed usage',async t=>{
 const {store}=setup(t);blockGlobalFetch(t);let calls=0,part=0;
 const auth={accessToken:async()=>'synthetic-token'} as unknown as ChatGPTAuth;
 const request:NetworkFetch=async()=>{calls++;return new Response(new ReadableStream({pull(controller){if(part++===0)controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));else controller.error(new TypeError('fetch failed',{cause:Object.assign(new Error('reset'),{code:'ECONNRESET'})}));}}));};
 const service=new AssistantService(store,auth,emptySecrets,()=>{},x=>x,request);
 await assert.rejects(()=>service.testConnection('synthetic-image'),/网络连接未完成/);assert.equal(calls,1);assert.equal(store.db.prepare('SELECT state FROM usage').get()!.state,'uncertain');assert.equal(service.isBusy(),false);
});

test('HTTP auth and quota failures keep their distinct provider messages under injection',async t=>{
 const {store}=setup(t);blockGlobalFetch(t);const auth={accessToken:async()=>'synthetic-token'} as unknown as ChatGPTAuth;
 for(const [status,code,expected] of [[401,'invalid_token',/连接已失效/],[429,'insufficient_quota',/额度不足/]] as const){let calls=0;const service=new AssistantService(store,auth,emptySecrets,()=>{},x=>x,async()=>{calls++;return Response.json({error:{code}},{status});});await assert.rejects(()=>service.testConnection('synthetic-image'),expected);assert.equal(calls,1);}
});

test('cancelling an injected inference aborts its signal and never retries',async t=>{
 const {store}=setup(t);blockGlobalFetch(t);const auth={accessToken:async()=>'synthetic-token'} as unknown as ChatGPTAuth;let calls=0,ready:()=>void=()=>{};
 const started=new Promise<void>(resolve=>{ready=resolve;});
 const service=new AssistantService(store,auth,emptySecrets,()=>{},x=>x,async(_url,init)=>new Promise((_resolve,reject)=>{calls++;const signal=init!.signal!;signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});ready();}));
 const pending=service.testConnection('synthetic-image');await started;service.cancel();await assert.rejects(()=>pending,/由你取消/);assert.equal(calls,1);assert.equal(service.isBusy(),false);
});

test('cancelling while a token is loading prevents an inference request and usage reservation',async t=>{
 const {store}=setup(t);blockGlobalFetch(t);let resolveToken:(value:string)=>void=()=>{},calls=0;
 const token=new Promise<string>(resolve=>{resolveToken=resolve;});
 const auth={accessToken:()=>token} as unknown as ChatGPTAuth;
 const service=new AssistantService(store,auth,emptySecrets,()=>{},x=>x,async()=>{calls++;return sse();});
 const pending=service.testConnection('synthetic-image');service.cancel();resolveToken('synthetic-token');
 await assert.rejects(()=>pending,/尚未发送模型请求/);assert.equal(calls,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM usage').get()!.n,0);assert.equal(service.isBusy(),false);
});


test('a request deadline is reported as timeout rather than user cancellation',async t=>{
 const {store}=setup(t);const fallback=setTimeout(()=>{},1000);t.after(()=>clearTimeout(fallback));
 const svc=new AssistantService(store,{accessToken:async()=> 'synthetic-token'} as unknown as ChatGPTAuth,emptySecrets,()=>{},x=>x,async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});}),20);
 await assert.rejects(()=>svc.testConnection('synthetic-image'),error=>error instanceof Error&&/模型响应超时/.test(error.message)&&!/由你取消/.test(error.message));
 assert.equal(svc.isBusy(),false);assert.equal(store.db.prepare('SELECT state FROM usage').get()!.state,'uncertain');
});
