import { z } from 'zod';
import { deviceId } from './device-sync';
import type { ExchangeFolder } from './device-exchange';

const date = z.iso.date();
const range = z.strictObject({ low: z.number(), high: z.number() }).nullable();
const count = z.number().int().nonnegative();
const daySchema = z.strictObject({
  date,
  intake: range,
  protein: range,
  carbs: range,
  fat: range,
  expenditure: range,
  balance: range,
  mealComplete: z.boolean(),
  activityComplete: z.boolean(),
  meals: count,
  estimatedMeals: count,
  targetKcal: z.number().nullable(),
  targetProtein: z.number().nullable(),
  steps: count.nullable(),
  stepCoverage: z.enum(['full', 'partial']).nullable(),
  stepScope: z.enum(['all', 'nonTraining']).nullable(),
  stepConflict: z.boolean(),
  weight: z.number().nullable(),
  waist: z.number().nullable(),
  bodyFat: z.number().nullable(),
  strength: count,
  workSets: count,
  cardio: count,
  cardioKm: z.number().nonnegative(),
});
const month = z.string().regex(/^\d{4}-(0[1-9]|1[012])$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({
  version: z.literal(1),
  archive: deviceId,
  device: deviceId,
  updated: z.iso.datetime(),
  timezone: z.string().min(1).max(80),
  today: date,
  civilToday: date,
  months: z.record(month, digest),
});
export type InsightDay = z.infer<typeof daySchema>;
export type InsightManifest = z.infer<typeof manifestSchema>;
export type PhoneInsights = { manifest: InsightManifest; days: InsightDay[] };

export async function receiveInsights(
  archive: string,
  files: string[],
  folder: ExchangeFolder,
  cached: PhoneInsights | null,
): Promise<PhoneInsights | null> {
  const manifests: InsightManifest[] = [];
  for (const file of files.filter((f) => /^overview-[a-f0-9-]{36}$/.test(f))) {
    const entry = manifestSchema.parse(JSON.parse(await folder.read(file)));
    if (entry.archive !== archive || file !== 'overview-' + entry.device) throw Error('统计所属档案不一致。');
    manifests.push(entry);
  }
  const latest = manifests.sort(
    (a, b) => b.updated.localeCompare(a.updated) || b.device.localeCompare(a.device),
  )[0];
  if (!latest || (cached?.manifest.archive === archive && latest.updated < cached.manifest.updated))
    return cached;
  if (cached && JSON.stringify(latest) === JSON.stringify(cached.manifest)) return cached;
  const days: InsightDay[] = [];
  for (const [key, hash] of Object.entries(latest.months).sort()) {
    if (cached?.manifest.archive === archive && cached.manifest.months[key] === hash) {
      days.push(...cached.days.filter((d) => d.date.startsWith(key)));
      continue;
    }
    const rows = z
      .array(daySchema)
      .min(1)
      .max(31)
      .parse(JSON.parse(await folder.read('view-' + hash)));
    if (rows.some((d, i) => !d.date.startsWith(key) || (i > 0 && d.date <= rows[i - 1].date)))
      throw Error('统计日期不连续或月份不匹配。');
    days.push(...rows);
  }
  return { manifest: latest, days };
}
