import test from 'node:test';
import assert from 'node:assert/strict';
import {organizeDishFoods} from '../src/shared/dish-foods';
import type {CommonDish,Memory} from '../src/shared/types';

test('saved dish and ingredient labels appear under their dishes while supplements stay independent',()=>{
 const memory=(id:string,name:string):Memory=>({id,kind:'food',text:name,food:{name,servingGrams:100,perServing:{kcal:100,protein:10,carbs:10,fat:2}},active:true,confirmed:true,stale:false,startsAt:'2026-10-20T00:00:00Z',expiresAt:null,sourceIds:[]});
 const foods=[memory('whole','合成鸡蛋牛肉可颂'),memory('ingredient','合成面皮'),memory('supplement','合成蛋白粉')];
 const dish={id:'dish-1',name:'合成甲店鸡蛋牛肉可颂套餐',aliases:['合成鸡蛋牛肉可颂，一杯咖啡'],template:[{name:'合成面皮',foodId:null,grams:{low:100,high:120},assumption:'合成分量'}]} as CommonDish;
 const before=JSON.stringify([dish,foods]),result=organizeDishFoods([dish],foods);
 assert.deepEqual(result.nested.get(dish.id)?.map(m=>m.id),['whole','ingredient']);assert.deepEqual(result.standalone.map(m=>m.id),['supplement']);assert.equal(JSON.stringify([dish,foods]),before);
});

test('same-named whole-meal food data respects dish brands while ingredient brands stay independent',()=>{
 const food=(id:string,name:string,brand:string)=>({id,kind:'food',food:{name,brand,servingGrams:100,perServing:{kcal:100,protein:10,carbs:10,fat:2}}} as Memory);
 const a=food('a','合成鸡肉饭','合成甲店'),b=food('b','合成鸡肉饭','合成乙店'),ingredient=food('c','合成配菜','合成供应商品牌');
 const amount={low:100,high:100};
 const dish:CommonDish={id:'dish-a',name:'合成鸡肉饭',brand:'合成甲店',aliases:[],recordIds:[],days:1,latestAt:'2026-10-20T00:00:00Z',latestRecordId:'synthetic-brand-meal',macros:{kcal:amount,protein:amount,carbs:amount,fat:amount},active:true,auto:false,template:[{name:'合成鸡肉饭',foodId:null,grams:{low:100,high:100},assumption:'合成估算'},{name:'合成配菜',foodId:null,grams:{low:20,high:30},assumption:'合成估算'}]};
 const result=organizeDishFoods([dish],[a,b,ingredient]);assert.deepEqual(result.nested.get(dish.id)?.map(m=>m.id),['a','c']);assert.deepEqual(result.standalone.map(m=>m.id),['b']);
});
