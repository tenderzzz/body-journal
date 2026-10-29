type ObjectValue=Record<string,unknown>;
const object=(value:unknown):value is ObjectValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
function optionalNulls(value:unknown,fields:string[]):unknown {
 if(!object(value))return value;
 const next={...value};for(const field of fields)if(next[field]===null)delete next[field];return next;
}
const runFields=['km','minutes','paceSecondsPerKm','avgHeartRate','effort','completion','elapsedMinutes','activeKcal','totalKcal','reportedKcal','calorieLabel','steps','cadence','sourceApp','sourceId','terrain'];
const setFields=['exerciseId','originalExercise','equipment','equipmentId','position','side','round','dropStage','setType','groupId','notes','rir','pain','classificationNeeded','exerciseManuallyClassified','effort'];
function memoryCandidates(value:unknown,limit:number,allowed:string[]){
 const warnings:string[]=[];
 // Wrong container types and excessive counts still go through strict validation.
 if(!Array.isArray(value)||value.length>limit)return {value,warnings};
 const accepted:unknown[]=[];
 for(const [index,item] of value.entries()){
  const operation=object(item)&&typeof item.operation==='string'?item.operation.trim().toLowerCase():undefined;
  if(!operation||!allowed.includes(operation)){
   warnings.push(`第${index+1}项附带记忆更新的操作类型无法识别，已跳过，未修改对应记忆或目标。`);continue;
  }
  accepted.push({...optionalNulls(item,['subject','text','kind','food','targetId','split']) as ObjectValue,operation});
 }
 return {value:accepted,warnings};
}
/** Model-only compatibility. Manual edits and backup validation stay strict. */
export function normalizeModelOutput(value:unknown,purpose:'analysis'|'chat'):{value:unknown;memoryWarnings:string[]}{
 if(!object(value))return {value,memoryWarnings:[]};
 const next=optionalNulls(value,purpose==='analysis'
  ?['questions','assumptions','copyFromRecordId','copiedFrom','training','run','sets','dailyActivity','ingredients','memories','memoryChanges','excludedIngredientIdentities']
  :['memoryChanges']) as ObjectValue;
 delete next.memoryWarnings; // Warnings are local receipts, never claims supplied by the model.
 if(purpose==='analysis'){
  next.training=optionalNulls(next.training,['durationMinutes','pain','recovery']);
  next.run=optionalNulls(next.run,runFields);
  next.dailyActivity=optionalNulls(next.dailyActivity,['steps','walkingKm','asOf','sourceApp']);
  if(Array.isArray(next.sets))next.sets=next.sets.map(item=>optionalNulls(item,setFields));
  if(Array.isArray(next.ingredients))next.ingredients=next.ingredients.map(item=>{
   const i=optionalNulls(item,['nutrition','productId','amount','consumedFraction','portionSource','portionEvidence','userCorrected','foodState','catalogQuery','compositionGroup','role','includesAddedFat','excludedFromTotal']);
   if(object(i))i.nutrition=optionalNulls(i.nutrition,['per100g','labelBasis','perBasis','densityGramsPerMl','provenance','labelEvidence','labelAttachmentSha256','productId']);return i;
  });
  if(Array.isArray(next.memories))next.memories=next.memories.map(item=>optionalNulls(item,['expiresAt']));
 }
 const memory=memoryCandidates(next.memoryChanges,purpose==='analysis'?3:5,purpose==='analysis'?['upsert']:['upsert','deactivate','set_goal']);if(memory.value!==undefined)next.memoryChanges=memory.value;
 return {value:next,memoryWarnings:memory.warnings};
}
