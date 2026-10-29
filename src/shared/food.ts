import type { FoodBasis, FoodCandidate, FoodPreset, FoodUnit, Ingredient, Macro, Range } from './types';
const round=(n:number)=>Math.round(n*100)/100;
const range=(n:number):Range=>({low:round(n),high:round(n)});
const macro=(values:FoodPreset['perServing'],scale=1):Macro=>({kcal:range(values.kcal*scale),protein:range(values.protein*scale),carbs:range(values.carbs*scale),fat:range(values.fat*scale)});
export const FOOD_UNIT_NAMES:Record<FoodUnit,string>={g:'g',ml:'ml',serving:'份'};
export function labelBasisOf(preset:FoodPreset):FoodBasis {
 if(preset.labelBasis)return preset.labelBasis;
 if(preset.servingGrams&&preset.servingGrams>0)return {quantity:preset.servingGrams,unit:'g'};
 throw new Error('食物标签缺少带单位的份量。');
}
export const foodServingLabel=(preset:FoodPreset)=>{const b=labelBasisOf(preset);return `${b.quantity}${FOOD_UNIT_NAMES[b.unit]}`;};
// Parentheses retain flavor and specification. Punctuation itself is not product identity.
export const normalizeFoodName=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[\s，,、。·：:()（）\[\]【】]/g,'');
export function foodProductId(preset:FoodPreset):string {
 if(preset.productId)return preset.productId;
 const key=[preset.brand??'',preset.name,preset.flavor??'',preset.specification??''].map(normalizeFoodName).join('|');
 let hash=2166136261;for(const c of key){hash^=c.codePointAt(0)!;hash=Math.imul(hash,16777619);}
 return `product-${(hash>>>0).toString(16).padStart(8,'0')}`;
}
export function foodPer100g(preset:FoodPreset):Macro {
 const b=labelBasisOf(preset),grams=b.unit==='g'?b.quantity:b.unit==='ml'&&preset.densityGramsPerMl?b.quantity*preset.densityGramsPerMl:undefined;
 if(!grams)throw new Error('标签不是克计量，缺少密度或每份克数，不能换算成每100g。');
 return macro(preset.perServing,100/grams);
}
export function foodText(preset:FoodPreset) {
 return `${preset.brand?preset.brand+' ':''}${preset.name}${preset.flavor?' '+preset.flavor:''}${preset.specification?' '+preset.specification:''}：每份 ${foodServingLabel(preset)}（能量 ${preset.perServing.kcal} kcal，蛋白质 ${preset.perServing.protein} g，碳水 ${preset.perServing.carbs} g，脂肪 ${preset.perServing.fat} g）${preset.nutritionSource==='estimate'?'；含估算数值，未核对完整包装':''}${preset.note?'。'+preset.note:''}`;
}
export function matchFoodPreset(presets:FoodPreset[],name:string,productId?:string):FoodPreset|undefined {
 if(productId){const found=presets.filter(p=>foodProductId(p)===productId);return found.length===1?matchFoodPreset(found,name):undefined;}
 const n=normalizeFoodName(name);if(!n)return;
 const exact=presets.filter(p=>{
  const names=[[p.brand??'',p.name,p.flavor??'',p.specification??''].join(''),...(p.aliases??[])];
  if(!p.flavor&&!p.specification)names.push(p.name);
  return names.some(value=>normalizeFoodName(value)===n);
 });
 return exact.length===1?exact[0]:undefined;
}
export function ingredientIdentity(item:Ingredient):string {return item.productId??`${normalizeFoodName(item.name)}|${item.foodState??'unknown'}|${item.compositionGroup??''}`;}
export function foodCandidatePreset(c:FoodCandidate):FoodPreset {
 const grams=Math.max(1,Math.round((c.latestGrams.low+c.latestGrams.high)/2*10)/10),mid=(r:Range)=>Math.round((r.low+r.high)/2*grams/100*10)/10;
 return {name:c.name,servingGrams:grams,nutritionSource:c.source==='label'?'label':'estimate',perServing:{kcal:mid(c.per100g.kcal),protein:mid(c.per100g.protein),carbs:mid(c.per100g.carbs),fat:mid(c.per100g.fat)}};
}
export function applyFoodPreset(item:Ingredient,preset:FoodPreset):Ingredient {
 const b=labelBasisOf(preset);let per100g:Macro|undefined;
 if(b.unit==='g'||b.unit==='ml'&&preset.densityGramsPerMl)per100g=foodPer100g(preset);
 return {...item,productId:foodProductId(preset),foodId:null,nutrition:{source:preset.nutritionSource??'label',provenance:'preset',productId:foodProductId(preset),basis:`个人常用食物：${foodText(preset)}`,labelBasis:b,perBasis:macro(preset.perServing),...(per100g?{per100g}:{}),...(preset.densityGramsPerMl?{densityGramsPerMl:preset.densityGramsPerMl}:{})}};
}
/** User corrections are matched by identity, never by array position. */
export function prepareMealIngredients(ingredients:Ingredient[],presets:FoodPreset[],options:{previous?:Ingredient[];manual?:boolean;text?:string;attachHashes?:string[]}={}):Ingredient[] {
 const corrections=(options.previous??[]).filter(i=>i.userCorrected),corrected=new Map(corrections.map(i=>[ingredientIdentity(i),i]));
 const nameIdentity=(i:Ingredient)=>`${normalizeFoodName(i.name)}|${i.foodState??'unknown'}|${i.compositionGroup??''}`;
 const prepared=ingredients.map(input=>{
  const sameName=corrections.filter(i=>nameIdentity(i)===nameIdentity(input)&&(!input.productId||i.productId===input.productId));
  const previous=corrected.get(ingredientIdentity(input))??(sameName.length===1?sameName[0]:undefined);
  let item=options.manual?{...input,userCorrected:true,portionSource:input.portionSource??'reported' as const}:previous?{...previous}:({...input,userCorrected:undefined});
  if(!options.manual&&!previous&&item.portionSource==='measured'){
   const evidence=item.portionEvidence,amount=ingredientAmount(item),numbers=evidence?.match(/\d+(?:\.\d+)?/g)?.map(Number)??[];
   const verified=!!evidence&&!!options.text?.includes(evidence)&&/称|秤|实测|weigh/i.test(evidence)&&numbers.includes(amount.low)&&numbers.includes(amount.high);
   if(!verified)item={...item,portionSource:'estimated',portionEvidence:undefined};
  }
  const label=item.nutrition;
  const quotedText=!!label?.labelEvidence&&!!options.text?.includes(label.labelEvidence);
  const imageTrace=!!label?.labelEvidence&&!!label.labelAttachmentSha256&&!!options.attachHashes?.includes(label.labelAttachmentSha256);
  // Image evidence traces the OCR to an actual attachment, without claiming OCR verification.
  const currentLabel=label?.source==='label'&&label.provenance==='current'&&(quotedText||imageTrace);
  if(item.userCorrected&&(!!item.nutrition||item.foodId!==null)||currentLabel)return item;
  const p=matchFoodPreset(presets,item.name,item.productId);
  if(p)return applyFoodPreset(item,p);
  if(item.nutrition?.provenance==='manual')item={...item,nutrition:{...item.nutrition,provenance:undefined}};
  return item;
 });
 const whole=new Map(prepared.filter(i=>i.compositionGroup&&i.role==='whole_dish').map(i=>[i.compositionGroup!,i]));
 return prepared.map(i=>{
  const dish=i.compositionGroup?whole.get(i.compositionGroup):undefined;
  const redundant=dish&&dish!==i&&(i.role==='component'||i.role==='added_fat'&&dish.includesAddedFat===true);
  return {...i,excludedFromTotal:redundant?`已包含在“${dish.name}”整道菜估算中，避免重复计入`:undefined};
 });
}
export function ingredientAmount(item:Ingredient):Range&{unit:FoodUnit} {return item.amount??{...item.grams,unit:'g'};}
export function nutritionDisplay(item:Ingredient):{basis:string;values:Macro}|undefined {
 const n=item.nutrition;if(!n)return;
 if(n.perBasis&&n.labelBasis)return {basis:`每${n.labelBasis.quantity}${FOOD_UNIT_NAMES[n.labelBasis.unit]}`,values:n.perBasis};
 return n.per100g?{basis:'每100g',values:n.per100g}:undefined;
}
/** Ratio between consumed quantity and label basis; no implicit ml ↔ g conversion. */
export function ingredientScale(item:Ingredient):Range|null {
 const amount=ingredientAmount(item),n=item.nutrition;
 const basis=n?.perBasis&&n.labelBasis?n.labelBasis:{quantity:100,unit:'g' as const};
 let quantity:Range={low:amount.low,high:amount.high};
 if(amount.unit!==basis.unit){
  const density=n?.densityGramsPerMl;
  if(amount.unit==='serving'&&n?.provenance==='preset')quantity={low:quantity.low*basis.quantity,high:quantity.high*basis.quantity};
  else if(amount.unit==='ml'&&basis.unit==='g'&&density)quantity={low:quantity.low*density,high:quantity.high*density};
  else if(amount.unit==='g'&&basis.unit==='ml'&&density)quantity={low:quantity.low/density,high:quantity.high/density};
  else return null;
 }
 const fraction=item.consumedFraction??{low:1,high:1};
 return {low:quantity.low/basis.quantity*fraction.low,high:quantity.high/basis.quantity*fraction.high};
}
