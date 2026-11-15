import type {RecordKind} from '../../src/shared/types';

export type GoldenCase={
  id:string;group:'记忆依据'|'计重口径'|'缺失数字'|'餐食复用';kind:RecordKind|'chat';text:string;
  replay:Record<string,unknown>;fields:Record<string,unknown>;memoryQuote?:string;expectWarning?:boolean;
  rule?:string;history?:'training'|'oneMeal'|'twoMeals'|'deletedMeal';
};
const fact=(quote:string,text=quote)=>({operation:'upsert',key:'communication.preference',kind:'fact',text,evidenceQuote:quote});
const note=(...changes:ReturnType<typeof fact>[])=>({summary:'已整理本次手记',memoryChanges:changes});
const chat=(...changes:ReturnType<typeof fact>[])=>({answerMarkdown:'本次提到的是记录偏好。',memoryChanges:changes});
function set(exercise:string,kg:number|null,reps:number,sets:number,loadBasis:string){
  return {exercise,kg,reps,sets,loadBasis,confirmed:kg!==null&&loadBasis!=='unknown'};
}
const workout=(entry:ReturnType<typeof set>,questions:string[]=[])=>({summary:'合成训练记录',sets:[entry],questions});
export function ingredient(name:string,grams:number){
  const range=(value:number)=>({low:value,high:value});
  return {name,foodId:null,grams:range(grams),assumption:'合成样例的已报告重量',nutrition:{source:'estimate',basis:'合成每100克',per100g:{kcal:range(120),protein:range(10),fat:range(4),carbs:range(11)}}};
}
export const priorMeal='synthetic-prior-meal';
const food=(...items:ReturnType<typeof ingredient>[])=>({summary:'合成餐食',ingredients:items});
export const cases:GoldenCase[]=[
  {id:'reported-coach',group:'记忆依据',kind:'note',text:'教练说：“以后都按站姿记。”',replay:note(fact('以后都按站姿记')),fields:{complete:true},expectWarning:true},
  {id:'ocr-instruction',group:'记忆依据',kind:'chat',text:'截图显示：“以后默认每次训练20分钟”。',replay:chat(fact('以后默认每次训练20分钟')),fields:{complete:true},expectWarning:true},
  {id:'missing-quotation',group:'记忆依据',kind:'note',text:'看了一场比赛。',replay:note(fact('以后训练都在早上')),fields:{complete:true},expectWarning:true},
  {id:'direct-preference',group:'记忆依据',kind:'note',text:'我喜欢训练反馈用表格。',replay:note(fact('我喜欢训练反馈用表格')),fields:{complete:true},memoryQuote:'我喜欢训练反馈用表格'},
  {id:'explicit-chat',group:'记忆依据',kind:'chat',text:'请记住，我喜欢用简体中文交流。',replay:chat(fact('我喜欢用简体中文交流')),fields:{complete:true},memoryQuote:'我喜欢用简体中文交流'},
  {id:'mixed-candidates',group:'记忆依据',kind:'chat',text:'我希望回答用短句。朋友说：“以后都站着训练”。',replay:chat(fact('我希望回答用短句'),fact('以后都站着训练')),fields:{complete:true},memoryQuote:'我希望回答用短句',expectWarning:true},

  {id:'dumbbell-unknown',group:'计重口径',kind:'training',text:'哑铃卧推 12kg 3×8',replay:workout(set('哑铃卧推',12,8,3,'unknown'),['是每只还是两只合计？']),fields:{kg:12,basis:'unknown',confirmed:false,question:true}},
  {id:'historical-rule',group:'计重口径',kind:'training',text:'哑铃卧推 12kg 3×8',rule:'我记录哑铃卧推时默认记每只哑铃的重量。',replay:workout(set('哑铃卧推',12,8,3,'per_hand')),fields:{kg:12,basis:'per_hand',confirmed:true,ruleSent:true}},
  {id:'explicit-total',group:'计重口径',kind:'training',text:'哑铃卧推 双手合计24kg 3×8',rule:'我记录哑铃卧推时默认记每只哑铃的重量。',replay:workout(set('哑铃卧推',24,8,3,'total')),fields:{kg:24,basis:'total',reps:8}},
  {id:'explicit-per-hand',group:'计重口径',kind:'training',text:'哑铃划船 每手14kg 2×10',replay:workout(set('哑铃划船',14,10,2,'per_hand')),fields:{kg:14,basis:'per_hand',sets:2}},
  {id:'machine-load',group:'计重口径',kind:'training',text:'器械推胸 标重30kg 3×10',replay:workout(set('器械推胸',30,10,3,'machine')),fields:{kg:30,basis:'machine',reps:10}},
  {id:'barbell-load',group:'计重口径',kind:'training',text:'杠铃卧推 总重40kg 2×8',replay:workout(set('杠铃卧推',40,8,2,'total')),fields:{kg:40,basis:'total',sets:2}},

  {id:'missing-load',group:'缺失数字',kind:'training',text:'卧推 3×8',history:'training',replay:workout(set('杠铃平板卧推',50,8,3,'total'),['本次用了多少重量？']),fields:{kg:null,sets:3,reps:8,confirmed:false}},
  {id:'unknown-reps',group:'缺失数字',kind:'training',text:'做了杠铃卧推，重量40kg，忘记记组次。',replay:{summary:'组次待补',sets:[],questions:['做了几组几次？']},fields:{setCount:0,question:true}},
  {id:'no-duration',group:'缺失数字',kind:'training',text:'跑了3公里，没计时。',replay:{summary:'跑步3公里',run:{km:3,completion:'completed'}},fields:{runKm:3,runMinutes:null}},
  {id:'no-distance',group:'缺失数字',kind:'training',text:'户外跑步20分钟，距离没记录。',replay:{summary:'跑步20分钟',run:{minutes:20,completion:'completed'}},fields:{runMinutes:20,runKm:null}},
  {id:'bodyweight',group:'缺失数字',kind:'training',text:'自重俯卧撑 2×10',replay:workout(set('自重俯卧撑',null,10,2,'bodyweight')),fields:{kg:null,basis:'bodyweight',reps:10}},
  {id:'partial-steps',group:'缺失数字',kind:'note',text:'截至中午步数3000，没有距离或热量。',replay:{summary:'截至中午的步数',dailyActivity:{steps:3000,scope:'all',coverage:'partial'}},fields:{steps:3000,walkingKm:null,coverage:'partial'}},

  {id:'same-meal',group:'餐食复用',kind:'meal',text:'午餐和昨天午餐一样。',history:'oneMeal',replay:{summary:'按昨日午餐复用',copyFromRecordId:priorMeal},fields:{copied:true,items:2,riceGrams:120}},
  {id:'half-rice',group:'餐食复用',kind:'meal',text:'和昨天一样，但米饭只吃一半，鸡蛋不变。',history:'oneMeal',replay:{...food(ingredient('米饭',60),ingredient('鸡蛋',50)),copyFromRecordId:priorMeal},fields:{items:2,riceGrams:60,eggGrams:50}},
  {id:'remove-egg',group:'餐食复用',kind:'meal',text:'午餐照旧，但这次没吃鸡蛋。',history:'oneMeal',replay:food(ingredient('米饭',120)),fields:{items:1,riceGrams:120,eggGrams:null}},
  {id:'ambiguous-meal',group:'餐食复用',kind:'meal',text:'和昨天吃的一样。',history:'twoMeals',replay:{summary:'需要确认哪一餐',questions:['是昨天的午餐还是晚餐？']},fields:{question:true,items:0,copied:false}},
  {id:'deleted-meal',group:'餐食复用',kind:'meal',text:'午饭照旧，上回那餐一样。',history:'deletedMeal',replay:{summary:'缺少可用的历史餐食',questions:['可以说一下这餐吃了什么吗？']},fields:{historyCount:0,items:0,question:true}},
  {id:'changed-portion-without-quantity',group:'餐食复用',kind:'meal',text:'昨天的午饭照旧，但这次少吃了米饭。',history:'oneMeal',replay:{summary:'本次分量有变',copyFromRecordId:priorMeal},fields:{copied:false,question:true,items:0}},
];
