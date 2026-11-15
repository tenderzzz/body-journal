import {useState,type ReactNode} from 'react';
import {ChartNoAxesColumn,ChevronRight,CircleCheck,Dumbbell,Egg,Footprints,Target,TrendingUp} from 'lucide-react';
import type {EnergyOverview as Overview,Range,TodaySummary} from '../shared/types';
import {mid} from '../shared/energy';
import {PART_NAMES} from '../shared/exercises';
import type {EnergySection} from './Energy';
import {BodyScale,MetricIcon,ProteinBar,proteinMetric,rangeText,shortDate,weightChange} from './SummaryMetrics';

const weekdays=['日','一','二','三','四','五','六'];
const weekday=(day:string)=>weekdays[new Date(day+'T12:00:00Z').getUTCDay()];
const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
const fmtRange=(r:Range|null)=>r?rangeText(r)+' kcal':'暂无估算';
function EnergyRing({overview}:{overview:Overview}){
  const today=overview.days.at(-1)!;
  const ratio=today.intake&&today.expenditure&&mid(today.expenditure)>0?Math.round(100*mid(today.intake)/mid(today.expenditure)):null;
  const amount=(r:Range|null,signed=false)=>r?(signed&&mid(r)>0?'+':'')+number.format(Math.round(mid(r))):null;
  const rows=[
    {name:'已记录摄入',value:amount(today.intake),range:today.intake,empty:'待记餐食',color:'green'},
    {name:'估算消耗',value:amount(today.expenditure),range:today.expenditure,empty:'待补资料',color:'terra'},
    {name:'今日差额',value:amount(overview.balance,true),range:overview.balance,empty:'待核对',color:'amber'}
  ];
  let note='今日摄入与消耗的估算区间有重叠。';
  if(!today.intake)note='补记或估算今天的餐食后，可以看到摄入占比。';
  else if(!today.expenditure)note='补齐计算资料和有效体重后，可以估算今天的消耗。';
  else if(!overview.balance)note=!today.mealComplete&&!overview.activityComplete?'餐食和活动还未核对，今日差额待定。':!today.mealComplete?'餐食还未核对，今日差额待定。':'活动还未核对，今日差额待定。';
  else if(overview.balanceState==='deficit')note='按已核对的记录，摄入低于估算消耗。';
  else if(overview.balanceState==='surplus')note='按已核对的记录，摄入高于估算消耗。';
  return <section className="digest-card energy-overview-card" aria-label="今日能量总览">
    <header className="overview-heading"><h2>今日能量总览</h2><small>按估算区间中点</small></header>
    <div className="ring-and-values">
      <div className="energy-ring" role="img" aria-label={ratio===null?'摄入与消耗占比待估':'按区间中点，摄入约为消耗的 '+ratio+'%'}>
        <svg viewBox="0 0 148 148" aria-hidden="true"><circle className="ring-track" cx="74" cy="74" r="61"/>
          {ratio!==null&&ratio>0&&<circle className="ring-fill" cx="74" cy="74" r="61" pathLength="100" strokeDasharray={Math.min(100,ratio)+' 100'} transform="rotate(-90 74 74)"/>}</svg>
        <span><strong>{ratio===null?'—':ratio+'%'}</strong><small>摄入 / 消耗</small></span>
      </div>
      <dl className="energy-totals">{rows.map(r=><div key={r.name} title={r.range?'估算区间 '+fmtRange(r.range):undefined}>
        <dt><i className={'plot-color '+r.color}/>{r.name}</dt>
        <dd>{r.value!==null?<>{r.value} <small>kcal</small></>:<span>{r.empty}</span>}</dd>
      </div>)}</dl>
    </div><p className="energy-verdict">{note}</p>
  </section>;
}

function WeightSpark({weights,end}:{weights:Overview['weights'];end:string}){
  if(!weights.length)return <span className="metric-empty">近四周暂无测量</span>;
  const endAt=Date.parse(end+'T12:00:00Z'),values=weights.map(w=>w.kg);
  const min=Math.min(...values),max=Math.max(...values);
  const points=weights.map(w=>({x:6+(27+(Date.parse(w.date+'T12:00:00Z')-endAt)/86400000)*288/27,
    y:max===min?18:32-27*(w.kg-min)/(max-min),...w}));
  return <svg className="weight-spark" viewBox="0 0 300 38" preserveAspectRatio="none" role="img" aria-label={'近四周 '+weights.length+' 个测量日，每日中位数由 '+weights[0].kg+' 至 '+weights.at(-1)!.kg+' kg'}>
    <path d="M5 34H295" className="spark-base"/>
    {points.length>1&&<polyline points={points.map(p=>p.x+','+p.y).join(' ')} className="spark-line"/>}
    {points.map((p,i)=><circle key={p.date} cx={p.x} cy={p.y} r={i===points.length-1?3.6:2.25}><title>{p.date} · {p.kg} kg</title></circle>)}
  </svg>;
}

function WeekChart({days,onDay}:{days:Overview['days'];onDay:(d:string)=>void}){
  const [active,setActive]=useState<string|null>(null);
  const selected=days.find(d=>d.date===active)??days.at(-1)!;
  const values=days.flatMap(d=>[d.intake,d.expenditure]).filter((v):v is Range=>v!==null).map(mid);
  const max=Math.max(500,Math.ceil(Math.max(0,...values)/500)*500);
  const label=(day:typeof selected)=>'摄入 '+fmtRange(day.intake)+' · 消耗 '+fmtRange(day.expenditure)+(day.intake&&!day.mealComplete?' · 餐食未记齐':'');
  return <section className="digest-card energy-week-chart" aria-label="近七日摄入与消耗">
    <header className="plot-heading"><h2><MetricIcon tone="green" icon={ChartNoAxesColumn}/>近 7 日 · 摄入与消耗</h2>
      <span className="plot-legend"><span><i className="plot-color green"/>摄入</span><span><i className="plot-color terra"/>消耗</span></span></header>
    {values.length?<><div className="plot-area"><div className="plot-axis" aria-hidden="true">{[max,max/2,0].map(n=><span key={n}>{number.format(n)}</span>)}</div>
      <div className="plot-columns">{days.map(d=><button key={d.date} type="button" className={'plot-column'+(d.date===selected.date?' active':'')}
        aria-label={d.date+' · '+label(d)+'，查看当天核对'} onFocus={()=>setActive(d.date)} onMouseEnter={()=>setActive(d.date)} onClick={()=>onDay(d.date)}>
        <span className="bar-pair">{([['intake','green'],['expenditure','terra']] as const).map(([key,color])=>d[key]&&<i key={key} className={'plot-bar '+color} style={{height:Math.max(1,mid(d[key])/max*100)+'%'}}/>)}</span>
        <span className="plot-day">{d===days.at(-1)?'今天':'周'+weekday(d.date)}</span></button>)}</div></div>
      <p className="plot-readout"><strong>{shortDate(selected.date)}</strong> {label(selected)}</p><small className="plot-note">柱高取估算区间中点，单位 kcal</small></>:
      <p className="chart-no-data">近七日还没有能量估算。记下一餐或补齐计算资料后，这里会显示趋势。</p>}
  </section>;
}

function MetricTiles({overview,today}:{overview:Overview;today:TodaySummary}){
  const protein=proteinMetric(today.protein),last=today.weight.latest,step=overview.steps.at(-1)!;
  const {week,goal}=overview.training,count=week.reduce((n,d)=>n+d.count,0);
  const stepMax=Math.max(1,...overview.steps.map(d=>d.count??0));
  const stepLabel=(d:typeof step)=>d.count!==null?(d.scope==='nonTraining'?'非训练步数':'总步数')+' · '+(d.coverage==='partial'?'部分时段':'全天'):d.conflict?'来源待核对':'未记录';
  return <div className="energy-metric-grid">
    <section className="digest-card energy-tile"><h2><MetricIcon tone="amber" icon={Egg}/>蛋白质</h2>
      <strong className="tile-value">{protein.value} <small>{protein.unit}</small></strong><p>{protein.note}</p>
      <div className="tile-foot"><ProteinBar progress={protein.progress}/></div></section>
    <section className="digest-card energy-tile"><h2><MetricIcon tone="slate" icon={BodyScale}/>体重<span>近四周</span></h2>
      <strong className="tile-value">{last?last.kg:'待测量'} {last&&<small>kg</small>}</strong>
      <p>{last?shortDate(last.date)+' 测量 · 周中位数'+(today.weight.change===0?'持平':' '+weightChange(today.weight.change)):'还没有体重记录'}</p>
      <div className="tile-foot"><WeightSpark weights={overview.weights} end={overview.date}/></div></section>
    <section className="digest-card energy-tile"><h2><MetricIcon tone="green" icon={Dumbbell}/>本周力量训练</h2>
      <strong className="tile-value">{count} <small>{goal&&goal>0?'/ '+goal+' 次':'次'}</small></strong>
      <p>{today.rest&&!today.completed?'今天休息':today.completed?'今天已记训练':'本周已完成'}{today.next?' · 下次练'+PART_NAMES[today.next]:''}</p>
      <div className="tile-foot week-markers">{week.map(d=><span key={d.date} className={(d.count?'trained ':'')+(d.date===overview.date?'current':'')}
        aria-label={d.date+(d.date>overview.date?'，尚未到来':'，已完成 '+d.count+' 次')} title={d.date+(d.date>overview.date?' · 尚未到来':' · '+d.count+' 次')}>{weekday(d.date)}</span>)}</div></section>
    <section className="digest-card energy-tile"><h2><MetricIcon tone="terra" icon={Footprints}/>步数<span>{shortDate(overview.stepDate)} 自然日</span></h2>
      <strong className="tile-value">{step.count===null?(step.conflict?'待核对':'待记录'):number.format(step.count)} {step.count!==null&&<small>步</small>}</strong>
      <p>{stepLabel(step)} · 近 7 个自然日</p>
      <div className="tile-foot step-bars" role="img" aria-label={overview.steps.map(d=>shortDate(d.date)+' '+(d.count===null?stepLabel(d):d.count+' 步 '+stepLabel(d))).join('，')}>
        {overview.steps.map(d=><span key={d.date} title={d.date+' · '+(d.count===null?stepLabel(d):d.count+' 步 · '+stepLabel(d))}>
          {d.count!==null?<i className={d.coverage==='partial'?'partial':''} style={{height:Math.max(2,d.count/stepMax*100)+'%'}}/>:<b/>}</span>)}</div></section>
  </div>;
}
const actions=[
  {section:'check',label:'核对今天',note:'补齐当天的餐食、活动与步数',icon:CircleCheck,tone:'green'},
  {section:'trend',label:'看趋势',note:'看近四周的体重和能量变化',icon:TrendingUp,tone:'slate'},
  {section:'targets',label:'目标历史',note:'查看饮食目标与每次调整的依据',icon:Target,tone:'amber'}
] as const;
export function EnergyDashboard({overview,today,todayCard,section,onSection,onDay,error,onRetry}:{overview:Overview|null;today:TodaySummary|null;todayCard:ReactNode;section:EnergySection|null;onSection:(s:EnergySection)=>void;onDay:(date:string)=>void;error:string;onRetry:()=>void}){
  const day=overview?.date??today?.date;
  return <div className="energy-dashboard"><header className="dashboard-heading"><h1>每天的能量</h1>{day&&<time dateTime={day}>{Number(day.slice(5,7))}月{Number(day.slice(8))}日 · 星期{weekday(day)}</time>}</header>
    <div className="energy-lead">{overview?<EnergyRing overview={overview}/>:<div className="digest-card card-loading" role={error?'alert':'status'}>{error||'正在整理能量记录…'}{error&&<button className="text-button" onClick={onRetry}>重新读取</button>}</div>}{todayCard}</div>
    {overview&&today&&<MetricTiles overview={overview} today={today}/>}
    {overview&&<WeekChart days={overview.days} onDay={onDay}/>}
    <section className="digest-card energy-action-list" aria-label="能量详情入口">
      {actions.map(a=><button key={a.section} type="button" aria-label={a.label} aria-controls={section===a.section?'energy-detail-panel':undefined} aria-expanded={section===a.section} onClick={()=>onSection(a.section)}>
        <MetricIcon icon={a.icon} tone={a.tone}/><span><strong>{a.label}</strong><small>{a.note}</small></span><ChevronRight size={17} className="row-chevron"/></button>)}
    </section>
  </div>;
}
