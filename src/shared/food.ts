import type { FoodPreset, Macro, Range } from './types';
const round=(n:number)=>Math.round(n*100)/100;
const range=(n:number):Range=>({low:round(n),high:round(n)});
// 每份营养按标签折算到每100g；本地计算时只用这组数字，不交给模型临时发挥。
export function foodPer100g(preset:FoodPreset):Macro {
 const k=100/preset.servingGrams;
 return {kcal:range(preset.perServing.kcal*k),protein:range(preset.perServing.protein*k),carbs:range(preset.perServing.carbs*k),fat:range(preset.perServing.fat*k)};
}
export function foodText(preset:FoodPreset) {
 return `${preset.brand?preset.brand+' ':''}${preset.name}：每份 ${preset.servingGrams}g（能量 ${preset.perServing.kcal} kcal，蛋白质 ${preset.perServing.protein} g，碳水 ${preset.perServing.carbs} g，脂肪 ${preset.perServing.fat} g）${preset.note?'。'+preset.note:''}`;
}
export const normalizeFoodName=(s:string)=>s.toLowerCase().replace(/[（(][^）)]*[）)]/g,'').replace(/[\s，,、。·：:]/g,'');
export function matchFoodPreset(presets:FoodPreset[],name:string):FoodPreset|undefined {
 const n=normalizeFoodName(name); if(!n)return undefined;
 return presets.find(p=>{const pn=normalizeFoodName(p.name),bn=p.brand?normalizeFoodName(p.brand):'';return !!pn&&(n===pn||(pn.length>=4&&n.includes(pn))||(n.length>=4&&pn.includes(n))||(bn.length>=4&&(n===bn||n.includes(bn))));});
}
