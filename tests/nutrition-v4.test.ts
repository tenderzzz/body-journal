import test from 'node:test';
import assert from 'node:assert/strict';
import { FoodCatalog } from '../electron/core/nutrition';
import { applyFoodPreset, foodPer100g, foodProductId, matchFoodPreset, normalizeFoodName, prepareMealIngredients } from '../src/shared/food';
import { foodPresetSchema, ingredientSchema } from '../electron/core/validation';
import type { Food, FoodPreset, Ingredient } from '../src/shared/types';
const preset:FoodPreset={name:'乳清粉（香草味）',brand:'示例营养',servingGrams:30,perServing:{kcal:120,protein:24,carbs:3,fat:1.5}};
const item=(name='乳清粉（香草味）',over:Partial<Ingredient>={}):Ingredient=>({name,foodId:null,grams:{low:30,high:30},assumption:'测试分量',...over});
const catalog=new FoodCatalog([]);
test('product identity retains flavor and rejects same-brand unrelated or ambiguous products',()=>{
 assert.notEqual(normalizeFoodName(preset.name),normalizeFoodName('乳清粉（巧克力味）'));
 assert.equal(matchFoodPreset([preset],'示例营养花生酱'),undefined);
 assert.equal(matchFoodPreset([preset],'乳清粉（巧克力味）'),undefined);
 assert.equal(matchFoodPreset([preset],'示例营养'),undefined);
 assert.equal(matchFoodPreset([preset],'乳清粉(香草味)'),preset);
 assert.equal(matchFoodPreset([preset,{...preset,brand:'另一品牌'}],preset.name),undefined);
 const aliased={...preset,aliases:['我确认的香草粉']};assert.equal(matchFoodPreset([aliased],'我确认的香草粉'),aliased);
 assert.equal(matchFoodPreset([preset],preset.name,foodProductId(preset)),preset);
 assert.equal(matchFoodPreset([preset],'完全不同名称',foodProductId(preset)),undefined);
 assert.equal(foodProductId(preset),foodProductId({...preset,servingGrams:60}));
});
test('raw ml labels scale in ml without inventing a gram density',()=>{
 const drink=foodPresetSchema.parse({name:'测试饮料',labelBasis:{quantity:100,unit:'ml'},perServing:{kcal:42,protein:3,carbs:5,fat:1}});
 const ml=applyFoodPreset(item('测试饮料',{grams:{low:0,high:0},amount:{low:250,high:250,unit:'ml'}}),drink);
 assert.equal(ml.nutrition!.per100g,undefined);
 assert.deepEqual(catalog.calculate([ml]).macros!.kcal,{low:105,high:105});
 assert.throws(()=>foodPer100g(drink),/密度/);
 const grams={...ml,amount:{low:250,high:250,unit:'g' as const}};
 assert.equal(catalog.calculate([grams]).macros,null);assert.match(catalog.calculate([grams]).unmatched[0],/单位/);
 const known=applyFoodPreset(grams,{...drink,densityGramsPerMl:1.05});
 assert.ok(Math.abs(catalog.calculate([known]).macros!.kcal.low-100)<.1);
});
test('serving labels and leftovers preserve actual consumption without conversion assumptions',()=>{
 const portions:FoodPreset={name:'测试营养棒',labelBasis:{quantity:1,unit:'serving'},perServing:{kcal:200,protein:10,carbs:20,fat:8}};
 const bar=applyFoodPreset(item('测试营养棒',{grams:{low:0,high:0},amount:{low:2,high:2,unit:'serving'},consumedFraction:{low:.5,high:.75}}),portions);
 assert.deepEqual(catalog.calculate([bar]).macros!.kcal,{low:200,high:300});
 assert.throws(()=>ingredientSchema.parse({...bar,consumedFraction:{low:.8,high:.2}}));
 assert.equal(foodPresetSchema.safeParse({name:'没有份量',perServing:portions.perServing}).success,false);
});
test('confirmed product labels override estimates while current quoted labels and manual edits win',()=>{
 const estimate=item(undefined,{nutrition:{source:'estimate',basis:'模型估计',per100g:{kcal:{low:200,high:300},protein:{low:10,high:15},carbs:{low:10,high:15},fat:{low:10,high:15}}}});
 assert.equal(prepareMealIngredients([estimate],[preset])[0].nutrition!.provenance,'preset');
 const current={...estimate,nutrition:{...estimate.nutrition!,source:'label' as const,provenance:'current' as const,labelEvidence:'本次每100g 300kcal'}};
 assert.equal(prepareMealIngredients([current],[preset],{text:'本次每100g 300kcal'})[0].nutrition!.provenance,'current');
 assert.equal(prepareMealIngredients([current],[preset],{text:'没有标签'})[0].nutrition!.provenance,'preset');
 const photo={...current,nutrition:{...current.nutrition,labelAttachmentSha256:'a'.repeat(64)}};
 assert.equal(prepareMealIngredients([photo],[preset],{attachHashes:['a'.repeat(64)]})[0].nutrition!.provenance,'current');
 assert.equal(prepareMealIngredients([photo],[preset],{attachHashes:['b'.repeat(64)]})[0].nutrition!.provenance,'preset');
 const correction=prepareMealIngredients([{...estimate,grams:{low:45,high:45}}],[preset],{manual:true})[0];
 const next=prepareMealIngredients([item('其他食物'),estimate],[preset],{previous:[correction]});
 assert.deepEqual(next[1].grams,{low:45,high:45});assert.equal(next[1].userCorrected,true);
 assert.equal(next[0].userCorrected,undefined);
 const identified={...correction,productId:foodProductId(preset)};
 assert.deepEqual(prepareMealIngredients([estimate],[preset],{previous:[identified]})[0].grams,{low:45,high:45});
});
test('whole dish composition excludes only same-group included components and cooking oil',()=>{
 const dish=applyFoodPreset(item('测试整道菜',{grams:{low:100,high:100},compositionGroup:'dish1',role:'whole_dish',includesAddedFat:true}),{...preset,name:'测试整道菜',servingGrams:100});
 const oil=applyFoodPreset(item('油',{grams:{low:10,high:10},compositionGroup:'dish1',role:'added_fat'}),{...preset,name:'油',servingGrams:10});
 const unrelated={...oil,name:'另一道菜的油',compositionGroup:'dish2'};
 const prepared=prepareMealIngredients([dish,oil,unrelated],[]);
 assert.ok(prepared[1].excludedFromTotal);assert.equal(prepared[2].excludedFromTotal,undefined);
 assert.deepEqual(catalog.calculate(prepared).macros!.kcal,{low:240,high:240});
});
test('Chinese meal sentences retrieve English corpus beyond translated entries and respect raw/cooked state',()=>{
 const food=(id:number,description:string,zh?:string):Food=>({id,description,zh,kcal:100,protein:10,carbs:10,fat:1,source:'test'});
 const c=new FoodCatalog([food(1,'Fish, salmon, raw'),food(2,'Fish, salmon, cooked'),food(3,'Nuts, cashew nuts, raw'),food(4,'Rice, cooked','白米饭（熟）')]);
 const results=c.search('晚饭吃了熟三文鱼和米饭，还有腰果');assert.ok(results.some(f=>f.id===3));assert.ok(results.some(f=>f.id===4));
 assert.equal(c.search('三文鱼 raw')[0].id,1);assert.equal(c.search('三文鱼 cooked')[0].id,2);
 assert.equal(c.resolveIngredients([item('白米饭（熟）',{foodState:'cooked'})])[0].foodId,4);
 assert.equal(c.resolveIngredients([item('白米饭（熟）',{foodState:'raw'})])[0].foodId,null);
});
test('meal followup selects one question about the largest avoidable calorie uncertainty',()=>{
 const uncertain=(name:string,low:number,high:number)=>applyFoodPreset(item(name,{grams:{low,high}}),{...preset,name,servingGrams:100});
 const foods=[uncertain('米饭',100,110),uncertain('油',10,100)];
 assert.deepEqual(catalog.mealQuestions(foods,['米饭有剩吗？','油用了多少？']),['油用了多少？']);
 assert.ok(catalog.mealQuestions(foods,[]).length<=1);
});
