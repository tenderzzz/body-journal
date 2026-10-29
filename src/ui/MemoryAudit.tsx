import {useState} from 'react';
import type {Memory,Message} from '../shared/types';
import {fmtDate} from './common';
type Run=<T=unknown>(action:string,payload?:unknown)=>Promise<T>;
export function MemoryAudit({memory,run}:{memory:Memory;run:Run}){
 const [history,setHistory]=useState<{at:string;memory:Memory}[]|null>(null),[error,setError]=useState('');
 return <details className="memory-audit" onToggle={e=>{if(e.currentTarget.open)run<{at:string;memory:Memory}[]>('memory:history',{id:memory.id}).then(setHistory).catch(e=>setError(e.message));}}><summary>来源与修改历史 · 版本 {memory.revision??1}</summary><p className="small muted">从 {fmtDate(memory.versionStartsAt??memory.startsAt,true)} 起{memory.expiresAt?`，至 ${fmtDate(memory.expiresAt,true)}`:'，未设结束时间'}。{memory.kind==='state'?'到期只表示需要重新确认，不表示已经恢复。':''}</p>{memory.evidence?.map((e,i)=><div className="original-text" key={i}>{e.origin==='unknown'?'旧资料没有保存可核对的原话来源。':e.quote}{e.at&&<p className="small muted">原话时间：{fmtDate(e.at,true)}</p>}</div>)}{!memory.evidence?.length&&<p className="small muted">旧资料未保存原话快照，可通过依据查看原始记录。</p>}{error&&<p role="alert">{error}</p>}{history?.length===0&&<p className="small muted">暂无更早版本。</p>}{history?.map((h,i)=><div key={i}><p className="small muted">版本 {h.memory.revision??1} · {fmtDate(h.at,true)}</p><p>{h.memory.text}</p></div>)}</details>;
}
export function MessageMemories({message,onSource}:{message:Message;onSource:(id:string)=>void}){
 if(!message.memoryDependency?.length)return null;
 return <details className="memory-receipt"><summary>本次使用的记忆（{message.memoryDependency.length}）</summary>{message.memoryDependency.map(m=><div key={m.id}><p>{m.text}</p><p className="small muted">版本 {m.revision} · 从 {fmtDate(m.versionStartsAt??m.startsAt)} 起{m.expiresAt?`至 ${fmtDate(m.expiresAt)}`:''} <button className="text-button" onClick={()=>onSource(`memory:${m.id}`)}>查看当前记忆</button></p></div>)}</details>;
}
