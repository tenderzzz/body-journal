import {z} from 'zod';
import {bodySchema,idSchema,timeSchema,memoryInputSchema,settingsSchema} from './validation';

export const mutationSchemas={
  'record:update':z.object({id:idSchema,revision:z.number().int().positive(),text:z.string().max(100000).optional(),occurredAt:timeSchema.optional(),body:bodySchema.nullable().optional(),deleted:z.boolean().optional(),followup:z.object({answer:z.string().min(1).max(100000),questions:z.array(z.string().max(5000)).max(20)}).strict().optional()}).strict(),
  'record:setDeleted':z.object({id:idSchema,deleted:z.boolean()}).strict(),
  'memory:save':z.object({id:idSchema.optional(),memory:memoryInputSchema}).strict(),
  'settings:save':settingsSchema,
};
export function validateMutation(action:string,payload:unknown){
  const schema=mutationSchemas[action as keyof typeof mutationSchemas];
  return schema?schema.parse(payload):payload;
}
