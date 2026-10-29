import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { atomicWrite } from '../core/store';
import {defaultNetworkFetch,networkError,networkRequest,type NetworkFetch} from './network';

export interface SecretStorage { read():Promise<Record<string,unknown>>; write(value:Record<string,unknown>):Promise<void> }
type Registration={clientId:string;sub?:string;email?:string;name?:string;accessToken?:string;refreshToken?:string;idToken?:string;expiresAt?:number;scope?:string};
export const RESOURCE='https://api.openai.com/v1';
export function createChatGPTJWKSet(request:NetworkFetch=defaultNetworkFetch){
  return createRemoteJWKSet(new URL('https://auth.openai.com/.well-known/jwks.json'),{timeoutDuration:20000,[customFetch]:(url,options)=>networkRequest(request,url,options,'ChatGPT 身份验证服务')});
}
export function makeAuthorization(hostId:string,redirectUri:string,registration?:Registration) {
  const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  const params=new URLSearchParams({client_id:registration?.clientId??'dynamic_agent_client',ext_agent_host_id:hostId,response_type:'code',redirect_uri:redirectUri,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')});
  if(!registration?.clientId) params.set('agent_name_hint','Body Journal');
  if(registration?.idToken) params.set('id_token_hint',registration.idToken);
  if(registration?.email) params.set('login_hint',registration.email);
  return {url:`https://auth.openai.com/api/accounts/authorize?${params}`,state,nonce,verifier};
}
export function validateCallback(url:URL,expectedState:string,clientId?:string) {
  if(url.searchParams.get('state')!==expectedState) throw new Error('登录状态校验失败，请重新登录。');
  if(url.searchParams.has('error')) throw new Error('ChatGPT 授权未完成。可以重新登录或继续使用本地记录。');
  const issued=url.searchParams.get('client_id')??clientId;
  if(!issued||issued==='dynamic_agent_client'||(clientId&&issued!==clientId)) throw new Error('登录返回的应用登记信息不匹配。');
  const code=url.searchParams.get('code'); if(!code) throw new Error('登录没有返回授权码。'); return {clientId:issued,code};
}
export class ChatGPTAuth {
  private registration?:Registration;
  private hostId:string;
  private refreshPending?:Promise<string>;
  private server?:Server;
  private models:string[]=[];
  private lastError='';
  constructor(root:string,private secrets:SecretStorage,private openExternal:(url:string)=>Promise<void>,private notify:()=>void,private request:NetworkFetch=defaultNetworkFetch) {
    const file=path.join(root,'chatgpt-host.json');
    this.hostId=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).hostId:`urn:uuid:${randomUUID()}`;
    if(!this.hostId.startsWith('urn:uuid:')) throw new Error('ChatGPT 本机标识损坏');
    if(!existsSync(file)) atomicWrite(file,JSON.stringify({hostId:this.hostId}));
  }
  async init() { const all=await this.secrets.read(); this.registration=all.chatgpt as Registration|undefined; }
  status() { const r=this.registration; return {connected:!!r?.accessToken,sharing:!!r?.accessToken&&!!r.scope?.split(' ').includes('chatgpt.tokens.use.direct'),email:r?.email,name:r?.name,models:this.models,error:this.lastError||undefined}; }
  private async save(r:Registration) { const all=await this.secrets.read(); await this.secrets.write({...all,chatgpt:r}); this.registration=r; this.notify(); }
  async login() {
    if(this.server) throw new Error('登录窗口已打开，请在浏览器完成登录。');
    const old=this.registration; let finish:()=>void=()=>{};
    const done=new Promise<void>((resolve,reject)=>{
      const server=createServer(); this.server=server; let timer:NodeJS.Timeout;
      let consumed=false;
      finish=()=>{ clearTimeout(timer);server.close();this.server=undefined; };
      server.on('error',()=>{finish();reject(new Error('无法启动本地登录回调，请重试。'));});
      server.listen(0,'127.0.0.1',async()=>{
        const port=(server.address() as {port:number}).port; const redirectUri=`http://127.0.0.1:${port}/auth/callback`;
        const attempt=makeAuthorization(this.hostId,redirectUri,old);
        server.on('request',async(req,res)=>{
          const url=new URL(req.url??'/',redirectUri);
          if(req.method!=='GET'||url.pathname!=='/auth/callback') {res.writeHead(404).end();return;}
          if(consumed||url.searchParams.get('state')!==attempt.state) {res.writeHead(400).end('Invalid login state.');return;}
          consumed=true;
          try {
            const callback=validateCallback(url,attempt.state,old?.clientId);
            await this.save({...old,clientId:callback.clientId});
            const token=await this.tokenRequest(new URLSearchParams({grant_type:'authorization_code',client_id:callback.clientId,code:callback.code,code_verifier:attempt.verifier,redirect_uri:redirectUri,resource:RESOURCE}));
            if(typeof token.id_token!=='string') throw new Error('登录没有返回可验证的身份。');
            const jwks=createChatGPTJWKSet(this.request);
            const {payload}=await jwtVerify(token.id_token,jwks,{issuer:'https://auth.openai.com',audience:callback.clientId,requiredClaims:['sub','exp','iat'],clockTolerance:5});
            if(payload.nonce!==attempt.nonce||!payload.sub) throw new Error('登录身份校验失败。');
            if(old?.sub&&old.sub!==payload.sub) throw new Error('请使用原先连接的 ChatGPT 账号。');
            if(typeof token.access_token!=='string') throw new Error('未获得模型使用权限，请重新授权。');
            await this.save({clientId:callback.clientId,sub:payload.sub,email:typeof payload.email==='string'?payload.email:undefined,name:typeof payload.name==='string'?payload.name:undefined,accessToken:token.access_token,refreshToken:token.refresh_token as string|undefined,idToken:token.id_token,expiresAt:Date.now()+Number(token.expires_in??3600)*1000,scope:String(token.scope??'')});
            this.lastError='';
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"}).end('<!doctype html><meta charset="utf-8"><title>身体手记</title><style>body{font:18px system-ui;padding:15vh 12vw;color:#173532}h1{font-size:28px}</style><h1>已连接身体手记</h1><p>可以关闭此页，返回应用选择模型。</p>');
            finish(); resolve();
          }catch(e) { const error=networkError(e,'ChatGPT 登录服务');this.lastError=error.message;res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'}).end('登录未完成，请返回身体手记查看原因。');finish();reject(error); }
        });
        timer=setTimeout(()=>{finish();reject(new Error('登录等待已超时，请重新点击登录。'));},180000);
        try {await this.openExternal(attempt.url);} catch(e){finish();reject(e);}
      });
    });
    await done; if(this.status().sharing) await this.listModels(); return this.status();
  }
  private async tokenRequest(body:URLSearchParams):Promise<Record<string,unknown>> {
    try {
      const r=await networkRequest(this.request,'https://auth.openai.com/api/accounts/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(30000)},'ChatGPT 登录服务');
      if(!r.ok)throw new Error(r.status===400?'登录凭证已过期，请重新登录。':`ChatGPT 登录服务暂时不可用（${r.status}）。`);
      return await r.json() as Record<string,unknown>;
    }catch(error){throw networkError(error,'ChatGPT 登录服务');}
  }
  async accessToken():Promise<string> {
    if(!this.status().sharing) throw new Error('请在设置中登录 ChatGPT，并允许使用订阅额度。');
    if((this.registration!.expiresAt??0)>Date.now()+60000) return this.registration!.accessToken!;
    if(this.refreshPending) return this.refreshPending;
    this.refreshPending=this.refresh(); try{return await this.refreshPending;}finally{this.refreshPending=undefined;}
  }
  private async refresh():Promise<string> {
    const old=this.registration!; if(!old.refreshToken) throw new Error('ChatGPT 登录已过期，请重新登录。');
    const t=await this.tokenRequest(new URLSearchParams({grant_type:'refresh_token',client_id:old.clientId,refresh_token:old.refreshToken,resource:RESOURCE}));
    if(typeof t.access_token!=='string') throw new Error('续期未完成，请重新登录。');
    await this.save({...old,accessToken:t.access_token,refreshToken:typeof t.refresh_token==='string'?t.refresh_token:old.refreshToken,expiresAt:Date.now()+Number(t.expires_in??3600)*1000,scope:typeof t.scope==='string'?t.scope:old.scope});
    if(!this.status().sharing) throw new Error('账号未开启订阅额度共享，请重新授权。'); return t.access_token;
  }
  async listModels() {
    try {
      const token=await this.accessToken();const r=await networkRequest(this.request,`${RESOURCE}/models`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)},'ChatGPT 模型目录');
      if(!r.ok)throw new Error(`无法获取账号可用模型（${r.status}），请重新登录或稍后刷新。`);
      const body=await r.json() as {models?:{slug:string;visibility:string}[]};
      if(!Array.isArray(body.models))throw new Error('模型目录返回格式与当前官方接口不符。');
      this.models=body.models.filter(x=>x.visibility==='list'&&typeof x.slug==='string').map(x=>x.slug);this.lastError='';this.notify();return this.models;
    }catch(error){const readable=networkError(error,'ChatGPT 模型目录');this.lastError=readable.message;this.notify();throw readable;}
  }
  async logout() { this.server?.close();this.server=undefined; if(this.registration) await this.save({clientId:this.registration.clientId,sub:this.registration.sub,email:this.registration.email,name:this.registration.name}); this.models=[];this.lastError='';this.notify(); }
}
