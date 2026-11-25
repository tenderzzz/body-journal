import { z } from 'zod';
import { analysisSchema, setSchema, timeSchema } from '../../electron/core/validation';
import type { HealthRecord } from './types';
const amount = z
  .object({ low: z.number().nonnegative(), high: z.number().nonnegative() })
  .refine((r) => r.low <= r.high);
const modelRun = z.object({
  provider: z.enum(['chatgpt', 'deepseek']),
  model: z.string().max(160),
  promptVersion: z.string().max(100),
});
const savedSetSchema = setSchema.extend({
  basisSource: z.enum(['auto', 'reported', 'manual', 'unresolved']).optional(),
});
export const localAnalysisSchema = analysisSchema.extend({
  sets: z.array(savedSetSchema).max(150).optional(),
});
export const savedAnalysis = localAnalysisSchema.extend({
  macros: z.object({ kcal: amount, carbs: amount, protein: amount, fat: amount }).nullable().optional(),
  estimatedFoods: z.array(z.string().max(200)).max(40).optional(),
  unmatched: z.array(z.string().max(200)).max(40).optional(),
  at: timeSchema,
  engine: z.enum(['local', 'chatgpt', 'deepseek']),
  modelRun: modelRun.optional(),
});
const followup = z.object({
  answer: z.string().min(1).max(100000),
  questions: z.array(z.string().max(5000)).max(20),
  at: timeSchema,
  previousAnalysis: savedAnalysis.partial().optional(),
});
export const detailSchema = z.object({
  revision: z.number().int().positive(),
  status: z.enum(['pending', 'ready', 'needs_info']),
  analysis: savedAnalysis.nullable(),
  followups: z.array(followup).max(30),
  pending: z.boolean(),
  dishId: z.string().max(160).optional(),
  createdAt: timeSchema,
  updatedAt: timeSchema,
});
export type RecordDetail = z.output<typeof detailSchema>;
export function detailOf(r: HealthRecord): RecordDetail {
  return detailSchema.parse({
    revision: r.revision,
    status: r.status,
    analysis: r.analysis,
    followups: r.followups ?? [],
    pending: !!r.analysisPending,
    dishId: r.dishId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}
