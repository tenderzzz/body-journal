import type { Food, Ingredient, Macro, Range } from '../../src/shared/types';
import {ingredientScale,normalizeFoodName,nutritionDisplay} from '../../src/shared/food';
// Search aliases describe ingredients, not measured recipes for Chinese mixed dishes.
const ALIASES:[string[],string[]][]=[
 [['米饭','白米饭'],['rice','cooked']], [['大米','生米'],['rice','raw']], [['糙米饭'],['rice','brown','cooked']], [['燕麦'],['oats']],
 [['鸡胸','鸡胸肉'],['chicken','breast']], [['鸡腿','鸡腿肉'],['chicken','thigh']], [['鸡肉'],['chicken']], [['牛肉'],['beef']], [['猪肉'],['pork']], [['里脊'],['tenderloin']],
 [['三文鱼','鲑鱼'],['salmon']], [['金枪鱼'],['tuna']], [['鳕鱼'],['cod']], [['虾','虾仁'],['shrimp']], [['鲈鱼'],['bass']], [['鲭鱼'],['mackerel']],
 [['鸡蛋','蛋'],['egg']], [['蛋白'],['egg','white']], [['鸭蛋'],['egg','duck']], [['豆腐'],['tofu']], [['豆干'],['tofu','dried']], [['毛豆'],['soybeans','green']],
 [['牛奶'],['milk']], [['酸奶'],['yogurt']], [['奶酪','芝士'],['cheese']], [['豆奶','豆浆'],['soymilk']], [['乳清'],['whey']],
 [['西兰花'],['broccoli']], [['菠菜'],['spinach']], [['白菜'],['cabbage']], [['生菜'],['lettuce']], [['胡萝卜'],['carrots']], [['番茄','西红柿'],['tomatoes']],
 [['黄瓜'],['cucumber']], [['土豆','马铃薯'],['potatoes']], [['红薯','地瓜'],['sweet','potato']], [['玉米'],['corn']], [['蘑菇'],['mushrooms']], [['南瓜'],['pumpkin']],
 [['苹果'],['apples']], [['香蕉'],['bananas']], [['橙子','橙'],['oranges']], [['草莓'],['strawberries']], [['蓝莓'],['blueberries']], [['葡萄'],['grapes']], [['梨'],['pears']],
 [['花生酱'],['peanut','butter']], [['花生'],['peanuts']], [['杏仁'],['almonds']], [['核桃'],['walnuts']], [['腰果'],['cashew']], [['橄榄油'],['oil','olive']], [['大豆油'],['oil','soybean']],
 [['面包'],['bread']], [['面条'],['noodles']], [['意面'],['spaghetti']], [['米粉'],['rice','noodles']], [['白砂糖','糖'],['sugars']], [['蜂蜜'],['honey']]
];
const STATE={raw:/生(?:的|重)?|\braw\b|uncooked/i,cooked:/熟|煮|蒸|烤|炒|煎|\bcooked\b|boiled|roasted|fried/i};
const stateOf=(text:string)=>STATE.raw.test(text)?'raw':STATE.cooked.test(text)?'cooked':undefined;
export class FoodCatalog {
  private byId: Map<number, Food>;
  constructor(public foods: Food[]) { this.byId = new Map(foods.map(f => [f.id,f])); }
  get(id: number) { return this.byId.get(id); }
  search(query: string, limit = 30): Food[] {
    const q = query.trim().toLowerCase(); if (!q) return this.foods.filter(x => x.zh).slice(0,limit);
    const tokens=q.match(/[a-z0-9]+/g)??[],state=stateOf(q);
    const aliases=ALIASES.filter(([names])=>names.some(n=>q.includes(n))).map(([,terms])=>terms);
    const ranked=this.foods.map(f=>{
      const text=`${f.zh??''} ${f.description} ${f.id}`.toLowerCase(),description=f.description.toLowerCase();let score=0;
      if(String(f.id)===q)score=1000;
      if(f.zh&&normalizeFoodName(q)===normalizeFoodName(f.zh))score+=200;
      else if(f.zh&&q.includes(f.zh.replace(/[（(].*$/,'')))score+=50;
      if(tokens.length&&tokens.every(t=>text.includes(t)))score+=30+tokens.length*3;
      for(const terms of aliases)if(terms.every(t=>description.includes(t)))score+=40+terms.length*4;
      if(!score)return {f,score:0};
      const foodState=stateOf(description);
      if(state&&foodState)score+=state===foodState?15:-25;
      // Prefer minimally described ingredients over composite fast-food dishes.
      score-=Math.min(description.length/100,5);
      return {f,score};
    });
    return ranked.filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.f.id-b.f.id).slice(0,limit).map(r=>r.f);
  }
  promptCatalog(text: string): Food[] {
    const common = this.foods.filter(f => f.zh);
    return [...new Map([...this.search(text,80),...common].map(f => [f.id,f])).values()].slice(0,120);
  }
  /** After recognition, accept exact local descriptions only; approximate matches remain estimates. */
  resolveIngredients(ingredients:Ingredient[]):Ingredient[]{return ingredients.map(item=>{
    if(item.foodId!==null||item.nutrition?.source==='label'||item.userCorrected)return item;
    const candidates=this.search(`${item.catalogQuery??item.name} ${item.foodState==='raw'?'raw':item.foodState==='cooked'?'cooked':''}`,20);
    const exact=candidates.find(f=>[f.zh,f.description].some(name=>name&&normalizeFoodName(name)===normalizeFoodName(item.name)||name&&!!item.catalogQuery&&normalizeFoodName(name)===normalizeFoodName(item.catalogQuery)));
    if(!exact)return item;
    const state=stateOf(exact.description);if(item.foodState&&item.foodState!=='unknown'&&state&&item.foodState!==state)return item;
    const resolved={...item,foodId:exact.id,nutrition:undefined,assumption:`${item.assumption}；匹配食材库：${exact.zh??exact.description}`};
    // A per100g catalogue entry cannot replace valid per-ml/per-serving nutrition
    // when the original quantity cannot be expressed in grams.
    if(!ingredientScale(resolved)||[exact.kcal,exact.protein,exact.carbs,exact.fat].some(value=>value===null||!Number.isFinite(value)||value<0))return item;
    return resolved;
  });}
  calculate(ingredients: Ingredient[]): { macros: Macro | null; unmatched: string[]; estimatedFoods:string[] } {
    const empty = (): Range => ({ low:0, high:0 });
    const totals: Macro = { kcal:empty(), protein:empty(), carbs:empty(), fat:empty() };
    const unmatched: string[] = [], estimatedFoods:string[]=[]; let matched = 0;
    for (const item of ingredients) {
      if(item.excludedFromTotal)continue;
      const f = item.foodId === null ? null : this.get(item.foodId);
      const custom=item.nutrition;
      if (!custom && (!f || [f.kcal,f.protein,f.carbs,f.fat].some(x => x === null))) { unmatched.push(item.name); continue; }
      const scale=ingredientScale(item),values=custom?nutritionDisplay(item)?.values:undefined;
      if(!scale||custom&&!values){unmatched.push(`${item.name}（计量单位或密度待补充）`);continue;}
      matched++;
      if(custom?.source==='estimate')estimatedFoods.push(item.name);
      for (const key of ['kcal','protein','carbs','fat'] as const) {
        const density=values?.[key]??{low:f![key]!,high:f![key]!};
        totals[key].low += density.low * scale.low;
        totals[key].high += density.high * scale.high;
      }
    }
    for (const range of Object.values(totals)) { range.low = Math.round(range.low*10)/10; range.high = Math.round(range.high*10)/10; }
    return { macros: matched ? totals : null, unmatched, estimatedFoods };
  }
  mealQuestions(ingredients:Ingredient[],questions:string[]):string[]{
    const unitMissing=ingredients.find(i=>!i.excludedFromTotal&&!ingredientScale(i));
    if(unitMissing)return [`${unitMissing.name}的标签和食用量单位不同，请补充相同单位的食用量或已核对的密度。`];
    const uncertain=ingredients.filter(i=>!i.userCorrected&&i.portionSource!=='measured'&&!i.excludedFromTotal).map(i=>{
      const result=this.calculate([i]).macros;return {i,width:result?result.kcal.high-result.kcal.low:Infinity};
    }).sort((a,b)=>b.width-a.width);
    const biggest=uncertain[0];
    if(biggest&&biggest.width>=50){const relevant=questions.find(q=>q.includes(biggest.i.name));if(relevant)return [relevant];}
    return questions.slice(0,1);
  }
}
