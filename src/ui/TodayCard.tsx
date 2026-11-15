import {useState,type ReactNode} from 'react';
import {ChevronRight,Dumbbell,Egg} from 'lucide-react';
import type {TodaySummary} from '../shared/types';
import {PART_NAMES} from '../shared/exercises';
import {BodyScale,MetricIcon,ProteinBar,proteinMetric,shortDate,weightChange} from './SummaryMetrics';

function SummaryRow({children,onClick,label}:{children:ReactNode;onClick?:()=>void;label?:string}){
  return onClick?<button type="button" className="summary-row" aria-label={label} onClick={onClick}>{children}<ChevronRight className="row-chevron" size={16} aria-hidden="true"/></button>
    :<div className="summary-row">{children}</div>;
}
type TodayProps={data:TodaySummary|null;onSource:(id:string)=>void;onTarget:()=>void;onRest:(rest:boolean)=>Promise<void>;onMeals?:()=>void;onAddWeight?:()=>void;onAddTraining?:()=>void};
export function TodayCard({data,onSource,onTarget,onRest,onMeals,onAddWeight,onAddTraining}:TodayProps){
  const [saving,setSaving]=useState(false);
  if(!data)return <section className="digest-card today-card card-loading" aria-label="今日维持" aria-busy="true">正在读取今日记录…</section>;
  const {completed,next,reference,weight,protein,uncertainTrainingId}=data;
  const part=completed?.part==='cardio'?'有氧':completed?completed.part==='unknown'?'力量':PART_NAMES[completed.part]:null;
  const rest=data.rest&&!completed;
  const train=part?'今天已练'+part:rest?'今天休息':next?'下次练'+PART_NAMES[next]:uncertainTrainingId?'训练待核对':'待记训练';
  const comparable=!completed&&!rest?reference:null;
  const trainId=completed?.id??(!rest?uncertainTrainingId??comparable?.id:null);
  const trainNote=completed&&next?'下次练'+PART_NAMES[next]:rest&&next?'下次练'+PART_NAMES[next]
    :comparable?shortDate(comparable.date)+' · '+comparable.exercise+' '+comparable.kg+' kg × '+comparable.reps+' × '+comparable.sets+' 组 · '+comparable.basis:null;
  const p=proteinMetric(protein),last=weight.latest;
  const changeRest=async(value:boolean)=>{if(saving||completed||value===rest)return;setSaving(true);try{await onRest(value);}finally{setSaving(false);}};
  const proteinAction=protein.pendingId?()=>onSource(protein.pendingId!):protein.target===null?onTarget:onMeals;
  return <section className="digest-card today-card" aria-label="今日维持">
    <header className="today-card-head"><h2>今日维持</h2>
      <div className="day-choice" role="group" aria-label="今天的训练安排">
        <button type="button" aria-label="今天休息" aria-pressed={rest} disabled={saving||!!completed} onClick={()=>void changeRest(true)}>休息日</button>
        <button type="button" aria-label={rest?'撤销休息':'训练日'} aria-pressed={!rest} disabled={saving||!!completed} onClick={()=>void changeRest(false)}>训练日</button>
      </div>
    </header>
    <SummaryRow onClick={trainId?()=>onSource(trainId):!rest?onAddTraining:undefined}
      label={comparable&&trainId===comparable.id?'上次可比记录 · '+train+' · '+trainNote:undefined}>
      <MetricIcon icon={Dumbbell} tone="green"/><span className="summary-main"><span className="summary-label">训练</span>
        <strong className="summary-value">{train}</strong>{trainNote&&<small>{trainNote}</small>}</span>
      <span className="summary-pill tone-green">{completed?'已完成':rest?'恢复中':uncertainTrainingId?'待核对':next?'轮换建议':'未记录'}</span>
    </SummaryRow>
    <SummaryRow onClick={proteinAction} label={!protein.pendingId&&protein.target===null?'设置蛋白质目标 · '+p.note:undefined}>
      <MetricIcon icon={Egg} tone="amber"/><span className="summary-main"><span className="summary-label">蛋白质 · 按已记录餐食</span>
        <strong className="summary-value">{p.value} <small>{p.unit}</small></strong>
        <ProteinBar progress={p.progress}/><small>{p.note}</small></span>
    </SummaryRow>
    <SummaryRow onClick={last?()=>onSource(last.id):onAddWeight}>
      <MetricIcon icon={BodyScale} tone="slate"/><span className="summary-main"><span className="summary-label">体重{last?' · '+shortDate(last.date)+' 测量':''}</span>
        <strong className="summary-value">{last?last.kg:'待测量'} {last&&<small>kg</small>}</strong></span>
      {last&&<span className="summary-pill tone-slate" title="最近两个完整七日的体重中位数变化，每周至少三个测量日">{weight.change!==null&&weight.change!==0?'周中位数 ':''}{weightChange(weight.change)}</span>}
    </SummaryRow>
  </section>;
}
