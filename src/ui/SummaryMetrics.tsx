import {createLucideIcon,type LucideIcon} from 'lucide-react';
import type {Range,TodaySummary} from '../shared/types';

export const BodyScale=createLucideIcon('BodyScale',[
  ['rect',{x:'3',y:'3',width:'18',height:'18',rx:'4',key:'frame'}],
  ['path',{d:'M7.2 8.2a7 7 0 0 1 9.6 0L14 12H10Z',key:'dial'}],
  ['path',{d:'m12 10 1.4-2.6',key:'needle'}]
]);
export function MetricIcon({icon:Icon,tone}:{icon:LucideIcon;tone:'green'|'amber'|'slate'|'terra'}){
  return <span className={'metric-icon tone-'+tone} aria-hidden="true"><Icon size={19} strokeWidth={1.8}/></span>;
}
export function rangeText(range:Range){
  const low=Math.round(range.low),high=Math.round(range.high);
  return low===high?String(low):low+'–'+high;
}
export function proteinMetric({target,logged,meals,pending}:TodaySummary['protein']){
  const targetNote=target===null?'未设蛋白质目标':'目标 '+target+' g';
  const pendingNote=pending?' · '+pending+' 条待核对':'';
  if(!logged)return {value:meals?'待估算':'待记录',unit:'',progress:null,
    note:(meals?'餐食尚无蛋白质估算':'今天还没有餐食记录')+' · '+targetNote+pendingNote};
  const amount=rangeText(logged);
  if(target===null)return {value:amount,unit:'g 已记',progress:null,note:targetNote+pendingNote};
  const gap={low:Math.max(0,Math.floor(target-logged.high)),high:Math.max(0,Math.ceil(target-logged.low))};
  return {value:gap.high?rangeText(gap):'已达标',unit:gap.high?'g 待补':'',
    progress:{low:logged.low/target,high:logged.high/target},
    note:'已记 '+amount+' g / '+target+' g'+pendingNote};
}
export function ProteinBar({progress}:{progress:{low:number;high:number}|null}){
  if(!progress)return null;
  const percent=(n:number)=>Math.max(0,Math.min(100,n*100))+'%';
  return <span className="protein-bar" aria-hidden="true"><i style={{width:percent(progress.high)}}/><b style={{width:percent(progress.low)}}/></span>;
}
export function weightChange(change:number|null){
  if(change===null)return '样本不足';
  if(change===0)return '周中位数持平';
  return (change>0?'↑ ':'↓ ')+Math.abs(change).toFixed(1)+' kg';
}
export const shortDate=(date:string)=>date.slice(5).replace('-','/');
