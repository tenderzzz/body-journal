import type {HealthRecord,RunEntry,Range} from './types';

export const CARDIO_ACTIVITY_LABELS={running:'跑步',walking:'步行',incline:'爬坡'} as const;
export function cardioComponent(text:string){return text.replace(/(?:非训练|非跑步)(?:的)?(?:步行|走路|步数)[^，,。；;\n]*/g,'');}
export const CARDIO_TEXT=/跑步机|跑步|慢跑|跑了|爬坡|爬升步行|上坡走|坡度|有氧|快走|健走|步行|走路/;

/** Keep the legacy run field readable while retaining the actual aerobic activity. */
export function normalizeCardio(run:RunEntry,text:string):RunEntry {
  const line=text.split(/\n|[；;]/).map(cardioComponent).find(value=>CARDIO_TEXT.test(value));
  if(!line)return run;
  let activity=run.activity;
  if(/爬坡|爬升步行|上坡走|跑步机.*坡度/.test(line))activity='incline';
  else if(/快走|健走|步行|走路/.test(line)&&!/慢跑|(?:^|[^机])跑步/.test(line))activity='walking';
  const grade=line.match(/(?:坡度|倾斜度|incline)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(%|％|度|°)?/i);
  if(activity!=='incline'||!grade||run.inclinePercent!==undefined)return activity?{...run,activity}:run;
  const raw=Number(grade[1]),degrees=/度|°/.test(grade[2]??'');
  // A bare treadmill incline setting is a visible, editable percentage assumption.
  if(!grade[2]&&!/跑步机/.test(line))return {...run,activity};
  const inclinePercent=degrees?Math.tan(raw*Math.PI/180)*100:raw;
  if(!Number.isFinite(inclinePercent)||inclinePercent<0||inclinePercent>30)return {...run,activity};
  return {...run,activity,inclinePercent,inclineSource:grade[2]?'reported':'assumed'};
}

export function recordCardio(record:HealthRecord):RunEntry|undefined {
  const analysis=record.analysis;
  if(!analysis?.run)return;
  const run={...normalizeCardio(analysis.run,record.text),...analysis.activityOverrides?.run};
  for(const field of analysis.activityOverrides?.cleared??[]){
    if(field.startsWith('run.'))delete (run as Record<string,unknown>)[field.slice(4)];
  }
  return run;
}

/** ACSM treadmill walking equation, at 1.9–3.7 mph. Grade is stored as percent. */
export function walkingMET(run:RunEntry,minutes:number):Range|null {
  if(!run.km||!Number.isFinite(minutes)||minutes<=0)return null;
  const speed=run.km*1000/minutes;
  if(speed<50||speed>100)return null;
  const grade=run.activity==='incline'?run.inclinePercent:0;
  if(grade===undefined||grade<0||grade>30)return null;
  const met=(.1*speed+1.8*speed*grade/100+3.5)/3.5;
  return {low:met,high:met};
}
