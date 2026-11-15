import type {CommonDish,Memory} from './types';
import {foodProductId,matchFoodPreset,normalizeFoodName} from './food';

/** Organize saved food data for display; nutrition labels and their history stay intact. */
export function organizeDishFoods(dishes:CommonDish[],memories:Memory[]){
 const foods=memories.filter(m=>m.kind==='food'&&m.food),nested=new Map<string,Memory[]>(),assigned=new Set<string>();
 for(const dish of dishes){
  const names=[dish.name,...dish.aliases].map(normalizeFoodName);
  const items=foods.filter(m=>{
   const food=m.food!;
   if(dish.template.some(i=>i.productId===foodProductId(food)))return true;
   const wholeMeal=[food.name,...(food.aliases??[])].some(name=>{const key=normalizeFoodName(name);return key.length>=4&&names.some(value=>value.includes(key));});
   if(wholeMeal&&dish.brand&&food.brand&&normalizeFoodName(dish.brand)!==normalizeFoodName(food.brand))return false;
   return wholeMeal||dish.template.some(i=>!!matchFoodPreset([food],i.name));
  });
  nested.set(dish.id,items);for(const item of items)assigned.add(item.id);
 }
 return {nested,standalone:foods.filter(m=>!assigned.has(m.id))};
}
