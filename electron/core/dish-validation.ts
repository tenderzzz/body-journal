import {z} from 'zod';
import {idSchema} from './validation';
import {dishIdentityKey,primaryDishName} from '../../src/shared/dishes';
export const dishInputSchema=z.object({id:idSchema.optional(),name:z.string().trim().min(1).max(160).optional(),aliases:z.array(z.string().trim().min(1).max(200)).max(50).optional(),recordIds:z.array(idSchema).min(1).max(1000).optional(),active:z.boolean().optional()}).strict();
export const dishDefinitionsSchema=z.array(z.object({id:idSchema,name:z.string().trim().min(1).max(160),aliases:z.array(z.string().trim().min(1).max(200)).max(50),recordIds:z.array(idSchema).max(1000),recordKeys:z.record(z.string(),z.string().max(1000)).optional(),active:z.boolean()})).max(1000).superRefine((definitions,ctx)=>{
 const ids=new Set<string>(),aliases=new Map<string,string>();
 for(const d of definitions){
  if(ids.has(d.id))ctx.addIssue({code:'custom',message:'餐食分组编号重复'});ids.add(d.id);
  for(const name of [d.name,...d.aliases]){const key=dishIdentityKey(primaryDishName(name)??name),old=aliases.get(key);if(old&&old!==d.id)ctx.addIssue({code:'custom',message:'同一个餐食名称属于多个分组，请编辑原分组'});aliases.set(key,d.id);}
 }
});
