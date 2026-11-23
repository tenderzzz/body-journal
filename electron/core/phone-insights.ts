import { createHash } from 'node:crypto';
import { addCalendarDays, calendarDay } from '../../src/shared/dates';
import { computeStats } from '../../src/shared/stats';
import type { InsightDay, InsightManifest } from '../../src/shared/phone-insights';
import type { Identity } from '../../src/shared/device-sync';
import type { ExchangeFolder } from '../../src/shared/device-exchange';
import type { HealthStore } from './store';

export function buildInsights(store: HealthStore, now = new Date()) {
  const read = store.energy.read(),
    timezone = read.zone,
    today = store.energy.today(now);
  const civilToday = calendarDay(now.toISOString(), timezone);
  const dates = new Set([
    ...read.index.dates.values(),
    ...read.inputs.keys(),
    ...read.index.civil.keys(),
    civilToday,
  ]);
  for (let i = 0; i < 90; i++) dates.add(addCalendarDays(today, -i));
  const stats = computeStats(read.records, timezone, { rules: store.exerciseRules() });
  const meals = new Map(stats.nutrition.map((r) => [r.date, r]));
  const measurements = new Map<string, { weight?: number; waist?: number; bodyFat?: number }>();
  for (const row of stats.measurements) {
    const values = measurements.get(row.date) ?? {};
    if (row.weightKg !== undefined) values.weight = row.weightKg;
    if (row.waistCm !== undefined) values.waist = row.waistCm;
    if (row.bodyFatPercent !== undefined) values.bodyFat = row.bodyFatPercent;
    measurements.set(row.date, values);
  }
  const training = new Map<
    string,
    { strength: number; workSets: number; cardio: number; cardioKm: number }
  >();
  const activity = (date: string) => {
    let row = training.get(date);
    if (!row) {
      row = { strength: 0, workSets: 0, cardio: 0, cardioKm: 0 };
      training.set(date, row);
    }
    return row;
  };
  for (const row of stats.trainingDetails) {
    const a = activity(row.date);
    a.strength++;
    a.workSets += row.workSets;
  }
  for (const row of stats.runs) {
    const a = activity(row.date);
    a.cardio++;
    a.cardioKm += row.km ?? 0;
  }
  const months = new Map<string, InsightDay[]>();
  for (const date of [...dates].filter((d) => d <= civilToday).sort()) {
    const d = store.energy.day(date, read),
      m = meals.get(date),
      body = measurements.get(date),
      a = training.get(date);
    const row: InsightDay = {
      date,
      intake: d.intake.kcal,
      protein: d.intake.protein,
      carbs: m?.estimated ? m.carbs : null,
      fat: m?.estimated ? m.fat : null,
      expenditure: d.expenditure,
      balance: d.balance,
      mealComplete: d.intake.complete,
      activityComplete: d.activityComplete,
      meals: d.intake.meals,
      estimatedMeals: d.intake.estimated,
      targetKcal: d.target?.kcal ?? null,
      targetProtein: d.target?.protein ?? null,
      steps: d.walking?.steps ?? null,
      stepCoverage: d.walking?.coverage ?? null,
      stepScope: d.walking?.scope ?? null,
      stepConflict: !d.walking && d.missing.some((s) => /选择步数来源|步数来源已删除/.test(s)),
      weight: body?.weight ?? null,
      waist: body?.waist ?? null,
      bodyFat: body?.bodyFat ?? null,
      strength: a?.strength ?? 0,
      workSets: a?.workSets ?? 0,
      cardio: a?.cardio ?? 0,
      cardioKm: a?.cardioKm ?? 0,
    };
    const key = date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key)!.push(row);
  }
  return { months, timezone, today, civilToday };
}

// Publish immutable months before replacing the small index. Readers keep the last complete view if iCloud delivers the index first.
export async function publishInsights(
  store: HealthStore,
  id: Identity,
  folder: ExchangeFolder,
  files: string[],
  now = new Date(),
) {
  const { months, ...info } = buildInsights(store, now);
  const known = new Set(files),
    hashes: Record<string, string> = {};
  for (const [month, days] of months) {
    const text = JSON.stringify(days),
      hash = createHash('sha256').update(text).digest('hex'),
      file = 'view-' + hash;
    if (!known.has(file)) await folder.write(file, text);
    hashes[month] = hash;
  }
  const file = 'overview-' + id.device;
  if (known.has(file)) {
    const old: InsightManifest = JSON.parse(await folder.read(file));
    if (
      old.version === 1 &&
      old.archive === id.archive &&
      old.device === id.device &&
      old.today === info.today &&
      old.civilToday === info.civilToday &&
      old.timezone === info.timezone &&
      JSON.stringify(old.months) === JSON.stringify(hashes)
    )
      return;
  }
  const manifest: InsightManifest = {
    version: 1,
    ...id,
    updated: now.toISOString(),
    ...info,
    months: hashes,
  };
  await folder.write(file, JSON.stringify(manifest));
}
