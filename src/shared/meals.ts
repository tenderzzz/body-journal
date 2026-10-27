import type { MealSlot } from './types';
export const MEAL_SLOT_NAMES:Record<MealSlot,string>={breakfast:'早餐',lunch:'午餐',dinner:'晚餐',other:'其他'};
export function mealSlot(iso:string,zone='Asia/Shanghai'):MealSlot {
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).format(new Date(iso)));
 return hour<10?'breakfast':hour<15?'lunch':hour<21?'dinner':'other';
}
export function mealLabel(iso:string,zone='Asia/Shanghai') {
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
 return `${date} ${MEAL_SLOT_NAMES[mealSlot(iso,zone)]}`;
}
