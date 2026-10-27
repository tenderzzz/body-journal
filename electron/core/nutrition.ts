import type { Food, Ingredient, Macro, Range } from '../../src/shared/types';
export class FoodCatalog {
  private byId: Map<number, Food>;
  constructor(public foods: Food[]) { this.byId = new Map(foods.map(f => [f.id,f])); }
  get(id: number) { return this.byId.get(id); }
  search(query: string, limit = 30): Food[] {
    const q = query.trim().toLowerCase(); if (!q) return this.foods.filter(x => x.zh).slice(0,limit);
    const tokens = q.split(/\s+/).filter(Boolean);
    return this.foods.filter(f => tokens.every(t => `${f.zh ?? ''} ${f.description} ${f.id}`.toLowerCase().includes(t))).slice(0,limit);
  }
  promptCatalog(text: string): Food[] {
    const common = this.foods.filter(f => f.zh);
    return [...new Map([...common, ...this.search(text,15)].map(f => [f.id,f])).values()].slice(0,120);
  }
  calculate(ingredients: Ingredient[]): { macros: Macro | null; unmatched: string[]; estimatedFoods:string[] } {
    const empty = (): Range => ({ low:0, high:0 });
    const totals: Macro = { kcal:empty(), protein:empty(), carbs:empty(), fat:empty() };
    const unmatched: string[] = [], estimatedFoods:string[]=[]; let matched = 0;
    for (const item of ingredients) {
      const f = item.foodId === null ? null : this.get(item.foodId);
      const custom=item.nutrition;
      if (!custom && (!f || [f.kcal,f.protein,f.carbs,f.fat].some(x => x === null))) { unmatched.push(item.name); continue; }
      matched++;
      if(custom?.source==='estimate')estimatedFoods.push(item.name);
      for (const key of ['kcal','protein','carbs','fat'] as const) {
        const density=custom?.per100g[key]??{low:f![key]!,high:f![key]!};
        totals[key].low += density.low * item.grams.low / 100;
        totals[key].high += density.high * item.grams.high / 100;
      }
    }
    for (const range of Object.values(totals)) { range.low = Math.round(range.low*10)/10; range.high = Math.round(range.high*10)/10; }
    return { macros: matched ? totals : null, unmatched, estimatedFoods };
  }
}
