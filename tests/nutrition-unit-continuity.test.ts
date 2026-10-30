import test from 'node:test';
import assert from 'node:assert/strict';
import {FoodCatalog} from '../electron/core/nutrition';
import {applyFoodPreset,ingredientScale} from '../src/shared/food';
import type {Food,FoodNutrition,Ingredient} from '../src/shared/types';

const values={kcal:{low:140,high:160},protein:{low:5,high:7},carbs:{low:20,high:25},fat:{low:3,high:5}};
const exactFood:Food={id:123456,description:'Synthetic food',kcal:100,protein:2,carbs:18,fat:1,source:'synthetic fixture'};
const nutrition:FoodNutrition={source:'estimate',basis:'合成估算依据',per100g:values};
const ingredient=(over:Partial<Ingredient>={}):Ingredient=>({name:'合成食物',foodId:null,grams:{low:100,high:150},assumption:'合成单位回归',nutrition,...over});

test('exact catalogue matching preserves calculable ml estimates and labels without assuming density',()=>{
 const c=new FoodCatalog([exactFood]);
 for(const source of ['estimate','label'] as const){
  const item=ingredient({catalogQuery:exactFood.description,grams:{low:0,high:0},amount:{low:25,high:50,unit:'ml'},nutrition:{source,basis:'合成每100ml依据',labelBasis:{quantity:100,unit:'ml'},perBasis:values}}),before=JSON.stringify(item);
  const [resolved]=c.resolveIngredients([item]);
  assert.equal(resolved.foodId,null);assert.deepEqual(resolved.nutrition,item.nutrition);assert.deepEqual(c.calculate([resolved]),c.calculate([item]));assert.deepEqual(c.calculate([resolved]).unmatched,[]);assert.equal(JSON.stringify(item),before);
 }
});

test('compatible gram quantities still prefer a complete exact catalogue match',()=>{
 const c=new FoodCatalog([exactFood]),item=ingredient({catalogQuery:exactFood.description}),before=JSON.stringify(item),[resolved]=c.resolveIngredients([item]);
 assert.equal(resolved.foodId,exactFood.id);assert.equal(resolved.nutrition,undefined);assert.deepEqual(c.calculate([resolved]).macros?.kcal,{low:100,high:150});assert.equal(JSON.stringify(item),before);
});

test('incomplete catalogue nutrition cannot replace a calculable supplied estimate',()=>{
 const c=new FoodCatalog([{...exactFood,kcal:null}]),item=ingredient({catalogQuery:exactFood.description});
 const [resolved]=c.resolveIngredients([item]);assert.equal(resolved.foodId,null);assert.deepEqual(resolved.nutrition,item.nutrition);assert.deepEqual(c.calculate([resolved]).unmatched,[]);
});

test('ml amounts with per100g nutrition remain unmatched without density even when a gram field is present',()=>{
 const c=new FoodCatalog([exactFood]),item=ingredient({catalogQuery:exactFood.description,amount:{low:10,high:20,unit:'ml'},grams:{low:10,high:20}}),before=JSON.stringify(item);
 assert.equal(ingredientScale(item),null);assert.equal(c.calculate(c.resolveIngredients([item])).macros,null);assert.match(c.calculate(c.resolveIngredients([item])).unmatched[0],/计量单位或密度/);assert.equal(JSON.stringify(item),before);
});

test('count or serving amounts use the provided total gram range with per100g nutrition',()=>{
 const item=ingredient({amount:{low:8,high:8,unit:'serving'},grams:{low:180,high:260},consumedFraction:{low:.5,high:.75},portionSource:'estimated'}),before=JSON.stringify(item);
 const scale=ingredientScale(item)!;assert.equal(scale.low,.9);assert.ok(Math.abs(scale.high-1.95)<1e-9);
 const result=new FoodCatalog([]).calculate([item]);assert.deepEqual(result.unmatched,[]);assert.deepEqual(result.macros?.kcal,{low:126,high:312});assert.equal(item.amount?.unit,'serving');assert.equal(item.portionSource,'estimated');assert.equal(JSON.stringify(item),before);
});

test('counts without a positive total mass do not imply grams or a standard serving size',()=>{
 for(const grams of [{low:0,high:0},{low:0,high:200}]){
  const item=ingredient({amount:{low:8,high:8,unit:'serving'},grams});assert.equal(ingredientScale(item),null);assert.equal(new FoodCatalog([]).calculate([item]).macros,null);
 }
});

test('confirmed preset serving size takes priority over the compatibility gram field',()=>{
 const item=applyFoodPreset(ingredient({amount:{low:2,high:2,unit:'serving'},grams:{low:1000,high:1000}}),{name:'合成已核对食品',servingGrams:30,perServing:{kcal:150,protein:20,carbs:10,fat:3}});
 assert.deepEqual(ingredientScale(item),{low:2,high:2});assert.deepEqual(new FoodCatalog([]).calculate([item]).macros?.kcal,{low:300,high:300});assert.deepEqual(item.grams,{low:1000,high:1000});
});
