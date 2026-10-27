import { randomUUID } from 'node:crypto';
import { HealthStore } from './core/store';
export function seedDemo(store:HealthStore){
  const at=(days:number,hour=12)=>{const d=new Date();d.setDate(d.getDate()-days);d.setHours(hour,0,0,0);return d.toISOString();};
  for(let d=13;d>=0;d--){store.importEnvelope({version:1,id:randomUUID(),kind:'body',occurredAt:at(d,8),timezone:'Asia/Shanghai',text:'示例数据：晨间测量',body:{weightKg:Math.round((72.6-d*0.015+Math.sin(d)*0.18)*10)/10,...(d%7===0?{waistCm:81-d*0.015}:{})}},undefined,'示例数据');}
  for(const [d,kg,reps] of [[12,50,8],[9,50,9],[6,52.5,8],[3,52.5,9],[0,55,8]])store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:at(d,18),timezone:'Asia/Shanghai',text:`卧推 ${kg}kg 3组×${reps}次\n坐姿划船 45kg 3组×10次\n感受：最后一组有些吃力，但动作稳定。`},undefined,'示例数据');
  for(const [d,text] of [[0,'食堂午餐：米饭、鸡肉和青菜，米饭剩了一点。'],[1,'外卖：番茄鸡蛋饭，全部吃完。'],[2,'早餐：牛奶、鸡蛋和面包。']] as const)store.importEnvelope({version:1,id:randomUUID(),kind:'meal',occurredAt:at(d),timezone:'Asia/Shanghai',text},undefined,'示例数据');
  store.importEnvelope({version:1,id:randomUUID(),kind:'note',occurredAt:at(1,22),timezone:'Asia/Shanghai',text:'这周作业有点多，昨晚睡得晚，今天感觉精力一般。'},undefined,'示例数据');
  store.saveMemory({kind:'state',text:'这周学习安排较满，睡眠可能不规律（示例）。',startsAt:at(2),expiresAt:new Date(Date.now()+5*86400000).toISOString(),sourceIds:[],active:true,confirmed:true});
}
