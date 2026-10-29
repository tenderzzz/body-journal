/** Runtime-supplied transport: the desktop injects Electron's system-network session. */
export type NetworkFetch=(url:string,init?:RequestInit)=>Promise<Response>;
// Resolve at call time so isolated tests can replace fetch without loading Electron.
export const defaultNetworkFetch:NetworkFetch=(url,init)=>globalThis.fetch(url,init);

/** Map recognised transport failures only; provider/auth/validation errors keep their meaning. */
export function networkError(error:unknown,service='模型服务'):Error {
 const original=error instanceof Error?error:new Error('请求未完成，请稍后重试。');
 const codes=new Set<string>(),names=new Set<string>();let genericFetch=false;
 const seen=new Set<unknown>();let next:unknown=error;
 for(let depth=0;depth<6&&next&&typeof next==='object'&&!seen.has(next);depth++){
  seen.add(next);const value=next as {code?:unknown;name?:unknown;message?:unknown;cause?:unknown};
  if(typeof value.code==='string')codes.add(value.code.toUpperCase());
  if(typeof value.name==='string')names.add(value.name);
  if(typeof value.message==='string'){
   const chromium=value.message.match(/\bnet::(ERR_[A-Z0-9_]+)\b/);if(chromium)codes.add(chromium[1]);
   if(value.name==='TypeError'&&/^(?:fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.?)$/i.test(value.message.trim()))genericFetch=true;
  }
  next=value.cause;
 }
 const has=(values:string[])=>values.some(v=>codes.has(v));
 if(names.has('TimeoutError')||has(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','ERR_CONNECTION_TIMED_OUT','ERR_TIMED_OUT','ERR_JWKS_TIMEOUT']))return new Error(`${service}连接超时，请检查网络和系统代理后重试。`);
 if(names.has('AbortError')||has(['ABORT_ERR','ERR_ABORTED']))return new Error(`${service}请求已取消，请重试。`);
 if(has(['ENOTFOUND','EAI_AGAIN','ERR_NAME_NOT_RESOLVED']))return new Error(`${service}地址暂时无法解析，请检查网络或系统代理后重试。`);
 if(has(['ERR_PROXY_CONNECTION_FAILED','ERR_TUNNEL_CONNECTION_FAILED','ERR_NO_SUPPORTED_PROXIES','ERR_MANDATORY_PROXY_CONFIGURATION_FAILED']))return new Error(`${service}无法通过当前系统代理连接，请检查代理是否运行及其配置。`);
 if([...codes].some(code=>/^ERR_CERT_|^CERT_|^ERR_TLS_CERT_/.test(code))||has(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']))return new Error(`${service}的安全连接校验失败，请检查系统时间、证书或代理设置后重试。`);
 if(genericFetch||has(['ECONNREFUSED','ECONNRESET','EPIPE','UND_ERR_SOCKET','ERR_CONNECTION_REFUSED','ERR_CONNECTION_RESET','ERR_CONNECTION_CLOSED','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED','ERR_NETWORK_ACCESS_DENIED','ERR_FAILED']))return new Error(`${service}网络连接未完成，请检查网络和系统代理后重试。`);
 return original;
}

export async function networkRequest(request:NetworkFetch,url:string,init:RequestInit|undefined,service:string):Promise<Response>{
 try{return await request(url,init);}catch(error){throw networkError(error,service);}
}
