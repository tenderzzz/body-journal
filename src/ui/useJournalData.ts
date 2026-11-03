import {useCallback,useEffect,useRef,useState,useMemo} from 'react';
import type {Snapshot,RecordPage,MessagePage} from '../shared/types';

type Options={page:string;date:string;kind:string;search:string;includeDeleted:boolean;history:boolean;anchor:string};
export function useJournalData(options:Options){
  const [base,setBase]=useState<(Snapshot&{demo:boolean})|null>(null),[fatal,setFatal]=useState('');
  const [records,setRecords]=useState<RecordPage>({items:[],total:0});
  const [messages,setMessages]=useState<MessagePage>({items:[]});
  const [profile,setProfile]=useState<Pick<Snapshot,'memories'|'commonDishes'|'foodCandidates'>>({memories:[]});
  const [counts,setCounts]=useState<Record<string,number>>({});
  const sequence=useRef({overview:0,records:0,messages:0,profile:0,calendar:0});
  const current=useRef(options);current.current=options;
  const cursors=useRef({records,messages});cursors.current={records,messages};
  const load=useCallback(async(resource:keyof typeof sequence.current,append=false)=>{
    if(!window.health){setFatal('请从 Mac 应用或项目启动入口打开身体手记。');return;}
    const seq=++sequence.current[resource],p=current.current;
    try{
      if(resource==='overview'){
        const result=await window.health.invoke<Snapshot&{demo:boolean}>('overview');
        if(seq===sequence.current.overview){setBase(result);setFatal('');}
      }else if(resource==='records'){
        const cursor=append?cursors.current.records.next:undefined;
        const result=await window.health.invoke<RecordPage>('records:list',{...(p.date?{date:p.date}:{}),kind:p.kind,search:p.search,includeDeleted:p.includeDeleted,...(cursor?{cursor}:{})});
        if(seq===sequence.current.records)setRecords(old=>({...result,items:append?[...old.items,...result.items.filter(r=>!old.items.some(x=>x.id===r.id))]:result.items}));
      }else if(resource==='messages'){
        const before=append?cursors.current.messages.before:undefined;
        const result=await window.health.invoke<MessagePage>('messages:list',{history:p.history,...(before?{before}:{})});
        if(seq===sequence.current.messages)setMessages(old=>({...result,items:append?[...result.items.filter(m=>!old.items.some(x=>x.id===m.id)),...old.items]:result.items}));
      }else if(resource==='profile'){
        const result=await window.health.invoke<Pick<Snapshot,'memories'|'commonDishes'|'foodCandidates'>>('profile:get');
        if(seq===sequence.current.profile)setProfile(result);
      }else{
        const result=await window.health.invoke<Record<string,number>>('calendar:get',{anchor:p.anchor});
        if(seq===sequence.current.calendar)setCounts(result);
      }
    }catch(error){setFatal(error instanceof Error?error.message:'无法读取档案');}
  },[]);
  const refresh=useCallback((scopes?:string[])=>{
    const p=current.current,has=(scope:string)=>!scopes||scopes.includes(scope);
    const requests:Promise<void>[]=[];
    if(has('overview')||has('sync'))requests.push(load('overview'));
    if(has('records')&&p.page==='records')requests.push(load('records'));
    if(has('messages')&&p.page==='assistant')requests.push(load('messages'));
    if(has('profile')&&p.page==='profile')requests.push(load('profile'));
    if(has('records')&&p.page==='assistant')requests.push(load('calendar'));
    return Promise.all(requests);
  },[load]);
  useEffect(()=>{void load('overview');},[load]);
  useEffect(()=>{if(options.page==='records')void load('records');},[options.page,options.date,options.kind,options.search,options.includeDeleted,load]);
  useEffect(()=>{if(options.page==='assistant'){void load('messages');void load('calendar');}},[options.page,options.history,options.anchor,load]);
  useEffect(()=>{if(options.page==='profile')void load('profile');},[options.page,load]);
  const snapshot=useMemo(()=>base?{...base,...profile,records:options.page==='records'?records.items:base.records,messages:messages.items}:null,[base,profile,records.items,messages.items,options.page]);
  return {snapshot,fatal,refresh,records,messages,counts,loadMoreRecords:()=>load('records',true),loadMoreMessages:()=>load('messages',true)};
}
