import {useEffect,useState} from 'react';
import {ChartNoAxesColumn,ChevronLeft,ChevronRight,CircleCheck,Footprints,Plus,Target,TrendingUp} from 'lucide-react';
import type {EnergyOverview as Overview,Range} from '../shared/types';
import {addDays,mid} from '../shared/energy';
import type {EnergySection} from './Energy';
import {MetricIcon,rangeText,shortDate} from './SummaryMetrics';

const weekdays=['日','一','二','三','四','五','六'];
const weekday=(day:string)=>weekdays[new Date(day+'T12:00:00Z').getUTCDay()];
const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
const fmtRange=(r:Range|null)=>r?rangeText(r)+' kcal':'暂无估算';
function EnergyRing({overview,date,onDate}:{overview:Overview;date:string;onDate:(date:string)=>void}){
  const day=overview.days.at(-1)!,loading=date!==overview.date,isToday=date===overview.today;
  const ratio=day.intake&&day.expenditure&&mid(day.expenditure)>0?Math.round(100*mid(day.intake)/mid(day.expenditure)):null;
  const amount=(r:Range|null,signed=false)=>r?(signed&&mid(r)>0?'+':'')+number.format(Math.round(mid(r))):null;
  const rows=[
    {name:'已记录摄入',value:amount(day.intake),range:day.intake,empty:day.mealComplete?'暂无估算':'待记餐食',color:'green'},
    {name:'估算消耗',value:amount(day.expenditure),range:day.expenditure,empty:'待补资料',color:'terra'},
    {name:isToday?'今日差额':'当日差额',value:amount(overview.balance,true),range:overview.balance,empty:'待补记录',color:'amber'}
  ];
  let note='按已记录数据，摄入与消耗的估算区间有重叠。';
  if(!day.intake)note='补充所选日期的餐食后，可以看到摄入占比。';
  else if(!day.expenditure)note='补齐计算资料和有效体重后，可以估算消耗。';
  else if(!overview.balance)note=!day.mealComplete?'餐食还有待分析或待补充的信息。':'活动还有待分析或待补充的信息。';
  else if(overview.balanceState==='deficit')note='按已记录数据，摄入低于估算消耗。';
  else if(overview.balanceState==='surplus')note='按已记录数据，摄入高于估算消耗。';
  return <section className="digest-card energy-overview-card" aria-label="能量总览" aria-busy={loading}>
    <header className="overview-heading"><h2>{isToday?'今日能量总览':'能量总览'}</h2>
      <div className="overview-date-nav"><button type="button" className="icon-button" aria-label="总览上一天" onClick={()=>onDate(addDays(date,-1))}><ChevronLeft size={16}/></button>
        <input type="date" aria-label="总览日期" value={date} max={overview.today} onChange={event=>{if(event.target.value&&event.target.value<=overview.today)onDate(event.target.value);}}/>
        <button type="button" className="icon-button" aria-label="总览下一天" disabled={date>=overview.today} onClick={()=>onDate(addDays(date,1))}><ChevronRight size={16}/></button>
        {!isToday&&<button type="button" className="text-button" onClick={()=>onDate('')}>今天</button>}</div>
    </header>
    {loading?<div className="overview-reading" role="status">正在读取 {date} 的记录…</div>:<>
      <div className="ring-and-values"><div className="energy-ring" role="img" aria-label={ratio===null?'摄入与消耗占比待估':'按区间中点，摄入约为消耗的 '+ratio+'%'}>
        <svg viewBox="0 0 148 148" aria-hidden="true"><circle className="ring-track" cx="74" cy="74" r="61"/>
          {ratio!==null&&ratio>0&&<circle className="ring-fill" cx="74" cy="74" r="61" pathLength="100" strokeDasharray={Math.min(100,ratio)+' 100'} transform="rotate(-90 74 74)"/>}</svg>
        <span><strong>{ratio===null?'—':ratio+'%'}</strong><small>摄入 / 消耗</small></span>
      </div><dl className="energy-totals">{rows.map(row=><div key={row.name} title={row.range?'估算区间 '+fmtRange(row.range):undefined}>
        <dt><i className={'plot-color '+row.color}/>{row.name}</dt><dd>{row.value!==null?<>{row.value} <small>kcal</small></>:<span>{row.empty}</span>}</dd>
      </div>)}</dl></div><p className="energy-verdict">{note}</p><small className="overview-basis">数值与占比取估算区间中点</small>
    </>}
  </section>;
}

function WeekChart({days,today,date,onDay}:{days:Overview['days'];today:string;date:string;onDay:(d:string)=>void}){
  const [active,setActive]=useState<string|null>(null);
  useEffect(()=>setActive(null),[date]);
  const selected=days.find(d=>d.date===active)??days.at(-1)!;
  const values=days.flatMap(d=>[d.intake,d.expenditure]).filter((v):v is Range=>v!==null).map(mid);
  const max=Math.max(500,Math.ceil(Math.max(0,...values)/500)*500);
  const label=(day:typeof selected)=>'摄入 '+fmtRange(day.intake)+' · 消耗 '+fmtRange(day.expenditure)+(day.intake&&!day.mealComplete?' · 餐食待补充':'');
  return <section className="digest-card energy-week-chart" aria-label="近七日摄入与消耗">
    <header className="plot-heading"><h2><MetricIcon tone="green" icon={ChartNoAxesColumn}/>近 7 日 · 摄入与消耗</h2>
      <span className="plot-legend"><span><i className="plot-color green"/>摄入</span><span><i className="plot-color terra"/>消耗</span></span></header>
    {values.length?<><div className="plot-area"><div className="plot-axis" aria-hidden="true">{[max,max/2,0].map(n=><span key={n}>{number.format(n)}</span>)}</div>
      <div className="plot-columns">{days.map(d=><button key={d.date} type="button" className={'plot-column'+(d.date===date?' active':'')}
        aria-label={d.date+' · '+label(d)+'，选择这天'} onFocus={()=>setActive(d.date)} onMouseEnter={()=>setActive(d.date)} onClick={()=>onDay(d.date)}>
        <span className="bar-pair">{([['intake','green'],['expenditure','terra']] as const).map(([key,color])=>d[key]&&<i key={key} className={'plot-bar '+color} style={{height:Math.max(1,mid(d[key])/max*100)+'%'}}/>)}</span>
        <span className="plot-day">{d.date===today?'今天':'周'+weekday(d.date)}</span></button>)}</div></div>
      <p className="plot-readout"><strong>{shortDate(selected.date)}</strong> {label(selected)}</p><small className="plot-note">柱高取估算区间中点，单位 kcal</small></>:
      <p className="chart-no-data">近七日还没有能量估算。记下一餐或补齐计算资料后，这里会显示趋势。</p>}
  </section>;
}

function StepsCard({overview,onAdd}:{overview:Overview;onAdd:(date:string)=>void}){
  const step=overview.steps.at(-1)!;
  const stepMax=Math.max(1,...overview.steps.map(d=>d.count??0));
  const stepLabel=(d:typeof step)=>d.count!==null?(d.scope==='nonTraining'?'非训练步数':'总步数')+' · '+(d.coverage==='partial'?'截至目前':'全天'):d.conflict?'来源待核对':'未记录';
  return <section className="digest-card energy-steps-card" aria-label="步数">
    <header className="steps-heading"><h2><MetricIcon tone="green" icon={Footprints}/>步数</h2>
      <button type="button" className="text-button" onClick={()=>onAdd(overview.stepDate)}><Plus size={14}/>记步数</button></header>
    <strong className="tile-value">{step.count===null?(step.conflict?'待核对':'待记录'):number.format(step.count)} {step.count!==null&&<small>步</small>}</strong>
    <p>{shortDate(overview.stepDate)} · {stepLabel(step)}</p>
    <div className="step-bars" aria-label="近七个自然日步数">{overview.steps.map(d=><button type="button" key={d.date}
      aria-label={'记录 '+d.date+' 的步数，'+(d.count===null?stepLabel(d):d.count+' 步 · '+stepLabel(d))} onClick={()=>onAdd(d.date)}>
        {d.count!==null?<i className={d.coverage==='partial'?'partial':''} style={{height:Math.max(2,d.count/stepMax*100)+'%'}}/>:<b/>}
        <span className="step-day">{d.date===overview.stepDate?'今天':shortDate(d.date)}</span>
      </button>)}</div>
  </section>;
}
const actions=[
  {section:'check',label:'当天明细',note:'查看餐食、活动和计算依据',icon:CircleCheck,tone:'green'},
  {section:'trend',label:'看趋势',note:'看近四周的体重和能量变化',icon:TrendingUp,tone:'slate'},
  {section:'targets',label:'目标历史',note:'查看饮食目标与每次调整的依据',icon:Target,tone:'amber'}
] as const;
export function EnergyDashboard({overview,date,section,onSection,onDay,onAddSteps,error,onRetry}:{overview:Overview|null;date:string;section:EnergySection|null;onSection:(s:EnergySection)=>void;onDay:(date:string)=>void;onAddSteps:(date:string)=>void;error:string;onRetry:()=>void}){
  const day=overview?.today,selectedDate=date||overview?.today;
  return <div className="energy-dashboard"><header className="page-heading dashboard-heading"><h1>每天的能量</h1>{day&&<time dateTime={day}>{Number(day.slice(5,7))}月{Number(day.slice(8))}日 · 星期{weekday(day)}</time>}</header>
    {overview?<div className="energy-lead"><EnergyRing overview={overview} date={selectedDate!} onDate={onDay}/><StepsCard overview={overview} onAdd={onAddSteps}/></div>
      :<div className="digest-card card-loading" role={error?'alert':'status'}>{error||'正在整理能量记录…'}{error&&<button className="text-button" onClick={onRetry}>重新读取</button>}</div>}
    {overview&&<WeekChart days={overview.days} today={overview.today} date={selectedDate!} onDay={onDay}/>}
    <section className="digest-card energy-action-list" aria-label="能量详情入口">
      {actions.map(a=><button key={a.section} type="button" aria-label={a.label} aria-controls={section===a.section?'energy-detail-panel':undefined} aria-expanded={section===a.section} onClick={()=>onSection(a.section)}>
        <MetricIcon icon={a.icon} tone={a.tone}/><span><strong>{a.label}</strong><small>{a.note}</small></span><ChevronRight size={17} className="row-chevron"/></button>)}
    </section>
  </div>;
}
