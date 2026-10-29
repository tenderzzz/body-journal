import { z } from 'zod';

const finite = z.number().finite().min(0).max(1_000_000);
const range = z.object({low:finite,high:finite}).strict().refine(v=>v.low<=v.high,'估算区间的下限不能大于上限');
const estimate = z.union([finite,range]).transform(v=>typeof v==='number'?{low:v,high:v}:v);
const identities = z.array(z.union([z.string().trim().min(1).max(200),z.number().int().positive()])).max(100)
  .transform(ids=>ids.map(String)).refine(ids=>new Set(ids).size===ids.length,'同一份食物清单不能重复填写产品编号');
const referenceSchema = z.object({
  foodIds:identities.optional(),kcal:finite.optional(),protein:finite.optional(),
  source:z.enum(['label','weighed','recipe','mixed','unknown']).default('unknown'),
  evidence:z.string().max(2000).optional(),
}).strict();
const predictionSchema = z.object({
  label:z.string().trim().min(1).max(80).default('candidate'),
  foodIds:identities.optional(),kcal:estimate.optional(),protein:estimate.optional(),
  questions:z.union([z.number().int().min(0).max(100),z.array(z.string().max(1000)).max(100)])
    .optional().transform(q=>Array.isArray(q)?q.length:q),
}).strict();
export const evaluationDatasetSchema = z.object({
  format:z.literal('bodyjournal-evaluation'),version:z.literal(1),
  name:z.string().trim().max(200).optional(),synthetic:z.boolean().default(false),
  comparison:z.object({baseline:z.string().min(1).max(80),candidate:z.string().min(1).max(80)}).strict().optional(),
  samples:z.array(z.object({id:z.string().trim().min(1).max(200),reference:referenceSchema.default({source:'unknown'}),predictions:z.array(predictionSchema).min(1).max(30)}).strict()).min(1).max(10000),
}).strict().superRefine((d,ctx)=>{
  if(new Set(d.samples.map(s=>s.id)).size!==d.samples.length)ctx.addIssue({code:'custom',path:['samples'],message:'样本编号不能重复'});
  if(d.comparison){
    const labels=new Set(d.samples.flatMap(s=>s.predictions.map(p=>p.label)));
    if(d.comparison.baseline===d.comparison.candidate||!labels.has(d.comparison.baseline)||!labels.has(d.comparison.candidate))
      ctx.addIssue({code:'custom',path:['comparison'],message:'比较需要两个不同且存在的预测名称'});
  }
});
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;
type Sample = EvaluationDataset['samples'][number];
type Prediction = Sample['predictions'][number];
export type EvaluationMetric = {value:number|null;samples:number;observations:number;missing:number};
export type EvaluationModelReport = {
  label:string;samples:number;runs:number;
  food:{exactMatch:EvaluationMetric;precision:EvaluationMetric;recall:EvaluationMetric};
  kcal:{mae:EvaluationMetric;coverage:EvaluationMetric;width:EvaluationMetric;repeatStdDev:EvaluationMetric};
  protein:{mae:EvaluationMetric;coverage:EvaluationMetric;width:EvaluationMetric;repeatStdDev:EvaluationMetric};
  questions:EvaluationMetric;
};
export type EvaluationReport = {
  name:string;synthetic:boolean;samples:number;
  references:{foodIds:number;kcal:number;protein:number;sources:Record<string,number>};
  models:EvaluationModelReport[];
  comparison?:{baseline:string;candidate:string;deltas:{kcalMae:EvaluationMetric;proteinMae:EvaluationMetric;foodExactMatch:EvaluationMetric;kcalCoverage:EvaluationMetric;proteinCoverage:EvaluationMetric;questions:EvaluationMetric}};
};
const average=(values:number[])=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const midpoint=(v:{low:number;high:number})=>(v.low+v.high)/2;
type PerSample = {value:number|null;observations:number};
const summarise=(values:PerSample[]):EvaluationMetric=>({value:average(values.flatMap(v=>v.value===null?[]:[v.value])),samples:values.filter(v=>v.value!==null).length,observations:values.reduce((n,v)=>n+v.observations,0),missing:values.filter(v=>v.value===null).length});
const measured=(values:number[]):PerSample=>({value:average(values),observations:values.length});
function foodScore(reference:string[],predicted:string[],kind:'exactMatch'|'precision'|'recall'){
  const truth=new Set(reference),found=new Set(predicted),correct=predicted.filter(id=>truth.has(id)).length;
  if(kind==='exactMatch')return Number(truth.size===found.size&&correct===truth.size);
  if(kind==='precision')return found.size?correct/found.size:Number(truth.size===0);
  return truth.size?correct/truth.size:1;
}
function sampleMetric(sample:Sample,predictions:Prediction[],kind:string):PerSample{
  if(kind==='questions')return measured(predictions.flatMap(p=>p.questions===undefined?[]:[p.questions]));
  if(kind.startsWith('food.')){
    if(sample.reference.foodIds===undefined)return measured([]);
    const metric=kind.slice(5) as 'exactMatch'|'precision'|'recall';
    return measured(predictions.flatMap(p=>p.foodIds===undefined?[]:[foodScore(sample.reference.foodIds!,p.foodIds,metric)]));
  }
  const [nutrient,metric]=kind.split('.') as ['kcal'|'protein',string],truth=sample.reference[nutrient];
  const values=predictions.flatMap(p=>p[nutrient]===undefined?[]:[p[nutrient]!]);
  if(metric==='repeatStdDev'){
    if(values.length<2)return measured([]);
    const centers=values.map(midpoint),mean=average(centers)!;
    return {value:Math.sqrt(centers.reduce((n,v)=>n+(v-mean)**2,0)/centers.length),observations:values.length};
  }
  if(metric==='width')return measured(values.map(v=>v.high-v.low));
  if(truth===undefined)return measured([]);
  return measured(values.map(v=>metric==='mae'?Math.abs(midpoint(v)-truth):Number(v.low<=truth&&truth<=v.high)));
}
/** Offline reporting only. Every sample has equal weight, even when repeat counts differ. */
export function evaluateDataset(input:unknown):EvaluationReport {
  const data=evaluationDatasetSchema.parse(input),labels=[...new Set(data.samples.flatMap(s=>s.predictions.map(p=>p.label)))];
  const models=labels.map(label=>{
    const samples=data.samples.filter(s=>s.predictions.some(p=>p.label===label));
    const metric=(kind:string)=>summarise(samples.map(s=>sampleMetric(s,s.predictions.filter(p=>p.label===label),kind)));
    const nutrition=(key:string)=>({mae:metric(key+'.mae'),coverage:metric(key+'.coverage'),width:metric(key+'.width'),repeatStdDev:metric(key+'.repeatStdDev')});
    return {label,samples:samples.length,runs:samples.reduce((n,s)=>n+s.predictions.filter(p=>p.label===label).length,0),food:{exactMatch:metric('food.exactMatch'),precision:metric('food.precision'),recall:metric('food.recall')},kcal:nutrition('kcal'),protein:nutrition('protein'),questions:metric('questions')};
  });
  const report:EvaluationReport={name:data.name??'精度评测',synthetic:data.synthetic,samples:data.samples.length,
    references:{foodIds:data.samples.filter(s=>s.reference.foodIds!==undefined).length,kcal:data.samples.filter(s=>s.reference.kcal!==undefined).length,protein:data.samples.filter(s=>s.reference.protein!==undefined).length,sources:{}},models};
  for(const s of data.samples)report.references.sources[s.reference.source]=(report.references.sources[s.reference.source]??0)+1;
  if(data.comparison){
    const {baseline,candidate}=data.comparison;
    const delta=(kind:string)=>summarise(data.samples.filter(s=>s.predictions.some(p=>p.label===baseline)&&s.predictions.some(p=>p.label===candidate)).map(s=>{
      const a=sampleMetric(s,s.predictions.filter(p=>p.label===baseline),kind),b=sampleMetric(s,s.predictions.filter(p=>p.label===candidate),kind);
      return a.value===null||b.value===null?{value:null,observations:0}:{value:b.value-a.value,observations:1};
    }));
    report.comparison={baseline,candidate,deltas:{kcalMae:delta('kcal.mae'),proteinMae:delta('protein.mae'),foodExactMatch:delta('food.exactMatch'),kcalCoverage:delta('kcal.coverage'),proteinCoverage:delta('protein.coverage'),questions:delta('questions')}};
  }
  return report;
}

/** Synthetic data for learning the format; never an accuracy claim about real models. */
export const EVALUATION_EXAMPLE = {
  format:'bodyjournal-evaluation',version:1,name:'合成示例：标签、称量与未知参考',synthetic:true,
  comparison:{baseline:'baseline',candidate:'candidate'},
  samples:[
    {id:'synthetic-label',reference:{foodIds:['example-whey-vanilla'],kcal:120,protein:24,source:'label',evidence:'合成包装标签：每份30g，120kcal、24g蛋白质'},predictions:[
      {label:'baseline',foodIds:['example-whey-chocolate'],kcal:{low:110,high:150},protein:{low:20,high:25},questions:2},
      {label:'candidate',foodIds:['example-whey-vanilla'],kcal:120,protein:24,questions:0},
      {label:'candidate',foodIds:['example-whey-vanilla'],kcal:120,protein:24,questions:0},
    ]},
    {id:'synthetic-weighed',reference:{foodIds:[168878,171477],kcal:450,protein:35,source:'weighed',evidence:'合成称量与配方数值，不是实际餐食'},predictions:[
      {label:'baseline',foodIds:[168878],kcal:{low:300,high:400},protein:{low:20,high:30},questions:2},
      {label:'candidate',foodIds:[168878,171477],kcal:{low:420,high:480},protein:{low:32,high:38},questions:1},
      {label:'candidate',foodIds:[168878,171477],kcal:{low:430,high:490},protein:{low:33,high:39},questions:1},
    ]},
    {id:'synthetic-unknown',reference:{source:'unknown',evidence:'没有标签或称量参考；只观察重复波动和追问'},predictions:[
      {label:'candidate',kcal:{low:500,high:700},protein:{low:20,high:30},questions:1},
      {label:'candidate',kcal:{low:550,high:750},protein:{low:22,high:32},questions:1},
    ]},
  ],
};
