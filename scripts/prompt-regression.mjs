import {parseArgs} from 'node:util';
import {CURRENT_PROMPT,PROMPT_VERSIONS} from '../electron/ai/prompts/version.ts';
import {cases} from '../tests/fixtures/prompt-golden.ts';
import {runGoldenCase,scoreGolden} from '../tests/fixtures/prompt-runner.ts';

const {values}=parseArgs({options:{
  live:{type:'boolean'},execute:{type:'boolean'},provider:{type:'string'},model:{type:'string'},runs:{type:'string',default:'1'},
  'input-price':{type:'string'},'output-price':{type:'string'},
}});
const runs=Number(values.runs);
if(!Number.isInteger(runs)||runs<1||runs>10)throw Error('--runs 应为 1–10 的整数');
if(!values.live&&Object.keys(values).some(key=>!['runs'].includes(key)))throw Error('外部评测选项须与 --live 一起使用');
const live=!!values.live;
if(live&&(!['openai','deepseek'].includes(values.provider)||!values.model?.trim()))throw Error('请指定 --provider openai 或 deepseek 及 --model 模型名称');
const provider=values.provider==='deepseek'?'deepseek':'chatgpt';
if(live&&provider==='deepseek'&&values.model!=='deepseek-flash')throw Error('应用的 DeepSeek 路径使用 deepseek-flash');
const model=values.model??'synthetic-model';
const prices=[values['input-price'],values['output-price']];
if(prices.some(v=>v!==undefined)&&(prices.some(v=>!v?.trim())||!prices.map(Number).every(v=>Number.isFinite(v)&&v>=0)))throw Error('请同时传入两个有效的非负单价，单位为同一币种每百万 token');
const versions=live?PROMPT_VERSIONS:[CURRENT_PROMPT];
const inputs=new Map(),offline=[];
for(const version of versions){
  for(const [index,c] of cases.entries()){
    const channel=live?provider:index%2?'chatgpt':'deepseek';
    offline.push(await runGoldenCase(c,{version,provider:channel,model,inputs}));
  }
}
function report(rows,label){
  console.log(label);
  for(const group of scoreGolden(rows)){
    console.log('  '+group.group+'　正确字段 '+group.fields.join('/')+'　误写 '+group.falseWrites.join('/')+'　应写且成功 '+group.correctWrites.join('/'));
    for(const {id,errors} of group.failures)console.log('    '+id+'　'+errors.join('；'));
  }
}
if(!live){
  if(runs!==1)throw Error('固定回放只需运行一次');
  console.log('24 条合成用例 · 两种模拟流 · 模型效果未评测');
  report(offline,'离线 '+CURRENT_PROMPT);
  if(offline.some(r=>r.errors.length))process.exitCode=1;
}else{
  const count=offline.length*runs;
  const inputEstimate=offline.reduce((n,r)=>n+Math.ceil(r.bytes*1.1)+1000,0)*runs,outputLimit=6144*count;
  console.log('合成黄金用例 A/B · '+values.provider+' / '+model+' · '+versions.join(' → ')+' · 每版本 '+runs+' 轮 · '+count+' 次模型调用');
  console.log('按 UTF-8 字节保守估算输入约 '+inputEstimate+' tokens；输出上限共 '+outputLimit+' tokens。');
  console.log(prices[0]===undefined?'未提供单价，费用未知。可提供 --input-price 和 --output-price（每百万 token 同币种单价）。':
    '按给定单价预算约 '+((inputEstimate*Number(prices[0])+outputLimit*Number(prices[1]))/1e6).toFixed(4)+'（输入为估算，以服务商账单为准）。');
  if(!values.execute)console.log('仅预览。模型效果未评测。确认后追加 --execute 发送这 24 组固定的合成输入。');
  else{
    const keyEnv=provider==='chatgpt'?'OPENAI_API_KEY':'DEEPSEEK_API_KEY',key=process.env[keyEnv];
    if(!key)throw Error('执行实测需要 '+keyEnv+'，费用由对应的 API 账户承担');
    const all=[],regressions=[];
    let transportError='';
    const send=async(url,init)=>{
      try{
        const res=await fetch(url,init);
        if(!res.ok)transportError='服务商返回 HTTP '+res.status;
        return res;
      }catch(err){transportError='模型网络请求失败';throw err;}
    };
    for(let round=1;round<=runs;round++){
      for(const c of cases){
        const pair=[];
        for(const version of versions){
          const row=await runGoldenCase(c,{provider,model,key,version,inputs,send});
          pair.push(row);all.push(row);
          if(transportError){report([row],'中断于第 '+round+' 轮 '+version+' '+c.id);throw Error(transportError+'，已停止后续调用');}
        }
        const [base,candidate]=pair;
        const newErrors=candidate.errors.filter(e=>!base.errors.includes(e));
        if(newErrors.length||candidate.matched<base.matched)regressions.push({round,id:c.id,errors:newErrors});
      }
    }
    for(const version of versions)report(all.filter(r=>r.version===version),'真实模型评测 '+version);
    console.log('退步用例 '+JSON.stringify(regressions));
    if(all.some(r=>r.version===CURRENT_PROMPT&&r.errors.length))process.exitCode=1;
  }
}
