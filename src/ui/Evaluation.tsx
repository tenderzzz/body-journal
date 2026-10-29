import {useState} from 'react';
import type {EvaluationMetric,EvaluationReport} from '../shared/evaluation';
type Run=<T=unknown>(action:string,payload?:unknown)=>Promise<T>;
function Metric({metric,unit='',percent=false}:{metric:EvaluationMetric;unit?:string;percent?:boolean}){
  return <><span>{metric.value===null?'不足以计算':`${(metric.value*(percent?100:1)).toFixed(1)}${percent?'%':unit}`}</span><small className="table-sub">{metric.samples} 份样本 · {metric.observations} 次观测{metric.missing?` · ${metric.missing} 份缺失`:''}</small></>;
}
export function EvaluationPanel({run}:{run:Run}){
  const [result,setResult]=useState<{filename:string;report:EvaluationReport}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const select=async()=>{setBusy(true);setError('');setNotice('');try{const value=await run<{filename:string;report:EvaluationReport}|null>('evaluation:open');if(value)setResult(value);}catch(e){setError(e instanceof Error?e.message:'评测没有完成，请检查数据格式。');}finally{setBusy(false);}};
  const report=result?.report;
  return <section className="settings-section" aria-label="精度评测">
    <h2>精度评测</h2><p>用包装标签或已知分量作为参考，比较同一批餐食的分析结果。文件只在本机计算，选择文件不会调用模型。</p>
    <div className="button-row wrap"><button className="button secondary" disabled={busy} onClick={select}>{busy?'正在计算…':'选择评测文件'}</button><button className="text-button" disabled={busy} onClick={async()=>{setError('');try{const file=await run<string|null>('evaluation:exampleSave');if(file)setNotice(`合成示例已保存：${file}`);}catch(e){setError(e instanceof Error?e.message:'示例没有保存。');}}}>保存合成示例</button></div>
    {error&&<p className="inline-error" role="alert">{error}</p>}{notice&&<p className="small muted" role="status">{notice}</p>}
    {report&&<div aria-live="polite"><h3>{report.name}</h3><p className="small muted">{result.filename} · 共 {report.samples} 份样本{report.synthetic?' · 合成数据，只验证流程':''}</p><p className="small muted">有食物参考 {report.references.foodIds} 份；有热量参考 {report.references.kcal} 份；有蛋白质参考 {report.references.protein} 份。未知参考不按零处理。</p>
      {!!report.references.sources.unknown&&<p className="small muted">{report.references.sources.unknown} 份样本未注明参考来源，请在形成精度结论前核对依据。</p>}
      <div className="table-wrap"><table><caption className="visually-hidden">食物匹配、营养误差和追问次数</caption><thead><tr><th>预测配置</th><th>食物清单完全匹配</th><th>热量平均绝对误差</th><th>蛋白质平均绝对误差</th><th>追问次数</th></tr></thead><tbody>{report.models.map(m=><tr key={m.label}><td>{m.label}<small className="table-sub">{m.samples} 份 · {m.runs} 次预测</small></td><td><Metric metric={m.food.exactMatch} percent/></td><td><Metric metric={m.kcal.mae} unit=" kcal"/></td><td><Metric metric={m.protein.mae} unit=" g"/></td><td><Metric metric={m.questions} unit=" 次"/></td></tr>)}</tbody></table></div>
      <details className="data-details"><summary>区间、重复波动与食物匹配明细</summary><p className="small muted">误差按区间中点计算。覆盖率要结合区间宽度阅读；重复波动需要同一样本至少两次预测。各样本等权。</p><div className="table-wrap"><table><thead><tr><th>预测配置</th><th>食物精确率</th><th>食物召回率</th><th>热量覆盖率</th><th>热量区间宽度</th><th>热量重复标准差</th><th>蛋白质覆盖率</th><th>蛋白质区间宽度</th><th>蛋白质重复标准差</th></tr></thead><tbody>{report.models.map(m=><tr key={m.label}><td>{m.label}</td><td><Metric metric={m.food.precision} percent/></td><td><Metric metric={m.food.recall} percent/></td><td><Metric metric={m.kcal.coverage} percent/></td><td><Metric metric={m.kcal.width} unit=" kcal"/></td><td><Metric metric={m.kcal.repeatStdDev} unit=" kcal"/></td><td><Metric metric={m.protein.coverage} percent/></td><td><Metric metric={m.protein.width} unit=" g"/></td><td><Metric metric={m.protein.repeatStdDev} unit=" g"/></td></tr>)}</tbody></table></div></details>
      {report.comparison&&<details className="data-details"><summary>同样本比较：{report.comparison.candidate} 与 {report.comparison.baseline}</summary><p className="small muted">差值为候选减基线，只比较双方都有结果的同一份样本。绝对误差为负代表下降；比例差以百分点显示。</p><div className="table-wrap"><table><thead><tr><th>指标</th><th>差值</th><th>有效配对样本</th></tr></thead><tbody>{([
        ['热量绝对误差',report.comparison.deltas.kcalMae,' kcal',1],['蛋白质绝对误差',report.comparison.deltas.proteinMae,' g',1],['食物完全匹配',report.comparison.deltas.foodExactMatch,' 个百分点',100],['热量覆盖率',report.comparison.deltas.kcalCoverage,' 个百分点',100],['蛋白质覆盖率',report.comparison.deltas.proteinCoverage,' 个百分点',100],['追问次数',report.comparison.deltas.questions,' 次',1],
      ] as [string,EvaluationMetric,string,number][]).map(([title,m,unit,scale])=><tr key={title}><td>{title}</td><td>{m.value===null?'不足以计算':`${m.value>0?'+':''}${(m.value*scale).toFixed(1)}${unit}`}</td><td>{m.samples}</td></tr>)}</tbody></table></div></details>}
      <p className="small muted">评测结果只反映这份文件和所列参考。没有可靠参考的照片餐食，暂时只能检查重复波动和记录负担。</p>
    </div>}
  </section>;
}
