import { randomUUID } from 'node:crypto';
import { HealthStore } from './core/store';
import {addDays} from '../src/shared/energy';
import {localDay} from '../src/shared/stats';
export function seedDemo(store:HealthStore){
  const today=localDay(new Date().toISOString(),'Asia/Shanghai');
  const at=(days:number,hour=12)=>`${addDays(today,-days)}T${String(hour).padStart(2,'0')}:00:00+08:00`;
  for(let d=13;d>=0;d--){store.importEnvelope({version:1,id:randomUUID(),kind:'body',occurredAt:at(d,8),timezone:'Asia/Shanghai',text:'示例数据：晨间测量',body:{weightKg:Math.round((72.6-d*0.015+Math.sin(d)*0.18)*10)/10,...(d%7===0?{waistCm:81-d*0.015}:{})}},undefined,'示例数据');}
  for(const [d,kg,reps] of [[12,50,8],[9,50,9],[6,52.5,8],[3,52.5,9],[0,55,8]])store.importEnvelope({version:1,id:randomUUID(),kind:'training',occurredAt:at(d,18),timezone:'Asia/Shanghai',text:`卧推 ${kg}kg 3组×${reps}次\n坐姿划船 45kg 3组×10次\n感受：最后一组有些吃力，但动作稳定。`},undefined,'示例数据');
  for(let d=13;d>=0;d--){
    const record=store.importEnvelope({version:1,id:randomUUID(),kind:'meal',occurredAt:at(d),timezone:'Asia/Shanghai',text:d===0?'示例午餐：食堂米饭、鸡肉和青菜；今天其他餐食尚未记齐。':'示例数据：全天饮食合并记录，包含早餐牛奶鸡蛋、食堂午晚餐与水果。'},undefined,'示例数据').record;
    store.applyAnalysis(record.id,{summary:d===0?'示例午餐，保留分量范围。':'合成示例：已核对的全天饮食。',questions:[],assumptions:['仅用于界面演示，不是实际测量或真人饮食。'],ingredients:[{name:d===0?'示例午餐':'示例全天食物',foodId:null,grams:{low:d===0?450:1400,high:d===0?500:1500},assumption:'合成示例分量',nutrition:{source:'estimate',basis:'隔离示例的合成营养数值',per100g:{kcal:{low:140+(d%3)*2,high:150+(d%3)*2},protein:{low:8,high:9},carbs:{low:18,high:20},fat:{low:4,high:5}}}}]},'local',record.revision);
  }
  store.importEnvelope({version:1,id:randomUUID(),kind:'note',occurredAt:at(1,22),timezone:'Asia/Shanghai',text:'这周作业有点多，昨晚睡得晚，今天感觉精力一般。'},undefined,'示例数据');
  store.saveMemory({kind:'state',text:'这周学习安排较满，睡眠可能不规律（示例）。',startsAt:at(2),expiresAt:new Date(Date.now()+5*86400000).toISOString(),sourceIds:[],active:true,confirmed:true});
  store.energy.saveProfile({effectiveDate:addDays(today,-13),age:24,heightCm:176,sex:'male',activity:'seated',strengthMinutes:{low:60,high:75},strengthPerWeek:3,runMinutes:20,runPerWeek:1,runPace:360,generalAdult:true});
  store.energy.saveTarget({effectiveDate:addDays(today,-13),mode:'lose',kcal:2100,protein:120,origin:'manual'},new Date(at(13,9)));
  for(let d=13;d>=1;d--)store.energy.saveDay({date:addDays(today,-d),mealComplete:true,activityComplete:true});
}
