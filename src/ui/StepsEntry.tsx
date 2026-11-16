import {useState} from 'react';
import {Modal} from './common';
import type {EnergyOverview} from '../shared/types';

type Run=<T=unknown>(action:string,payload?:unknown)=>Promise<T>;
export function StepsEntry({date,overview,timezone,run,onClose}:{date:string;overview:EnergyOverview;timezone:string;run:Run;onClose:()=>void}){
  const previous=overview.steps.find(d=>d.date===date);
  const [day,setDay]=useState(date),[steps,setSteps]=useState(previous?.count===null||previous?.count===undefined?'':String(previous.count));
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const changeDay=(value:string)=>{
    setDay(value);const saved=overview.steps.find(d=>d.date===value);
    setSteps(saved?.count===null||saved?.count===undefined?'':String(saved.count));
    setError('');
  };
  const save=async(event:React.FormEvent)=>{
    event.preventDefault();setError('');setSaving(true);
    try{await run('energy:stepsSave',{date:day,timezone,steps:Number(steps)});onClose();}
    catch(e){setError(e instanceof Error?e.message:'步数未保存，请重试。');}
    finally{setSaving(false);}
  };
  return <Modal title="记录步数" onClose={onClose}><form onSubmit={save}>
    <div className="modal-body"><fieldset className="activity-entry-fields" disabled={saving}>
      <label className="field">日期<input type="date" aria-label="步数日期" value={day} max={overview.stepDate} required onChange={e=>changeDay(e.target.value)}/></label>
      <label className="field">当天总步数<input type="number" aria-label="当天总步数" min="0" max="100000" step="1" inputMode="numeric" value={steps} required onChange={e=>setSteps(e.target.value)} placeholder="填写健康 App 中的总步数" autoFocus/></label>

    </fieldset><p className="steps-form-hint">按 {timezone} 的自然日记录，包含运动中的步数。过去日期按完整一天保存，今天按截至目前保存。</p>
    {error&&<p className="classification-error" role="alert">{error}</p>}</div>
    <footer className="modal-footer"><button className="text-button" type="button" onClick={()=>run('steps:shortcutInstall').catch(e=>setError(e.message))}>安装手机入口</button><div className="button-row"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving||!day||steps===''}>{saving?'保存中':'保存步数'}</button></div></footer>
  </form></Modal>;
}
