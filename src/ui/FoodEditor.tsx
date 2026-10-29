import {useState} from 'react';
import type {FoodPreset,FoodUnit,Memory} from '../shared/types';
import {foodProductId,foodText,labelBasisOf} from '../shared/food';
import {Modal} from './common';
type Run=<T=unknown>(action:string,payload?:unknown)=>Promise<T>;
export function FoodEditor({value,run,onClose}:{value:Partial<Memory>;run:Run;onClose:()=>void}){
 const f=value.food,b=f?labelBasisOf(f):{quantity:0,unit:'g' as const};
 const [name,setName]=useState(f?.name??''),[brand,setBrand]=useState(f?.brand??''),[flavor,setFlavor]=useState(f?.flavor??''),[spec,setSpec]=useState(f?.specification??''),[aliases,setAliases]=useState(f?.aliases?.join('，')??'');
 const [serving,setServing]=useState(b.quantity?String(b.quantity):''),[unit,setUnit]=useState<FoodUnit>(b.unit),[density,setDensity]=useState(f?.densityGramsPerMl?String(f.densityGramsPerMl):'');
 const [kcal,setKcal]=useState(f?String(f.perServing.kcal):''),[protein,setProtein]=useState(f?String(f.perServing.protein):''),[carbs,setCarbs]=useState(f?String(f.perServing.carbs):''),[fat,setFat]=useState(f?String(f.perServing.fat):''),[note,setNote]=useState(f?.note??''),[source,setSource]=useState<'label'|'estimate'>(f?.nutritionSource??'label'),[error,setError]=useState('');
 const fields=[serving,kcal,protein,carbs,fat],ready=!!name.trim()&&fields.every(v=>v.trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0)&&Number(serving)>0;
 const save=async()=>{
  if(!ready){setError('请填写名称、带单位的标签份量和四项营养数值。');return;}
  const preset:FoodPreset={name:name.trim(),brand:brand.trim()||undefined,flavor:flavor.trim()||undefined,specification:spec.trim()||undefined,aliases:aliases.split(/[，,\n]/).map(s=>s.trim()).filter(Boolean),labelBasis:{quantity:Number(serving),unit},...(unit==='g'?{servingGrams:Number(serving)}:{}),...(density.trim()?{densityGramsPerMl:Number(density)}:{}),nutritionSource:source,perServing:{kcal:Number(kcal),protein:Number(protein),carbs:Number(carbs),fat:Number(fat)},note:note.trim()||undefined};
  preset.productId=f?.productId??foodProductId(preset);
  try{await run('memory:save',{id:value.id,memory:{kind:'food',text:foodText(preset),food:preset,startsAt:value.startsAt??new Date().toISOString(),expiresAt:null,sourceIds:value.sourceIds??[],sourceMessageIds:value.sourceMessageIds,active:true,confirmed:true}});onClose();}catch(e){setError(e instanceof Error?e.message:'没有保存成功，请重试。');}
 };
 return <Modal title={value.id?'编辑常用食物':'添加常用食物'} onClose={onClose}><div className="modal-body"><p className="small muted">填写包装原始单位。毫升和克之间只在你提供已核对的密度时换算；不同口味、规格分别保存。别名只填写你确认指向同一产品的记法。</p>
 <label className="field">名称<input value={name} onChange={e=>setName(e.target.value)} placeholder="例如：乳清蛋白粉"/></label><div className="field-grid"><label className="field">品牌<input value={brand} onChange={e=>setBrand(e.target.value)}/></label><label className="field">口味<input value={flavor} onChange={e=>setFlavor(e.target.value)}/></label><label className="field">规格<input value={spec} onChange={e=>setSpec(e.target.value)} placeholder="例如：30g单包"/></label></div>
 <label className="field">已确认别名（逗号分隔）<input value={aliases} onChange={e=>setAliases(e.target.value)} placeholder="例如：我的香草乳清粉"/></label>
 <div className="field-grid three"><label className="field">标签每份数量<input type="number" min=".01" step=".1" value={serving} onChange={e=>setServing(e.target.value)}/></label><label className="field">标签单位<select aria-label="标签单位" value={unit} onChange={e=>setUnit(e.target.value as FoodUnit)}><option value="g">g</option><option value="ml">ml</option><option value="serving">份</option></select></label><label className="field">密度 g/ml（已知才填）<input type="number" min=".01" step=".01" value={density} onChange={e=>setDensity(e.target.value)}/></label></div>
 <div className="field-grid two">{([['能量 kcal / 标签份',kcal,setKcal],['蛋白质 g / 标签份',protein,setProtein],['碳水 g / 标签份',carbs,setCarbs],['脂肪 g / 标签份',fat,setFat]] as const).map(([label,v,set])=><label key={label} className="field">{label}<input type="number" min="0" step=".1" value={v} onChange={e=>set(e.target.value)}/></label>)}</div>
 <label className="field">营养来源<select aria-label="营养来源" value={source} onChange={e=>setSource(e.target.value as 'label'|'estimate')}><option value="label">完整包装标签，已核对</option><option value="estimate">部分数值是估算</option></select></label><label className="field">备注<input value={note} onChange={e=>setNote(e.target.value)}/></label>{error&&<p role="alert" className="classification-error">{error}</p>}
 </div><footer className="modal-footer"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!ready} onClick={save}>确认保存</button></footer></Modal>;
}
