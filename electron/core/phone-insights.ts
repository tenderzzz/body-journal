import {buildDailyInsights} from '../../src/shared/daily-insights';
import { createHash } from 'node:crypto';
import type { InsightManifest } from '../../src/shared/phone-insights';
import type { Identity } from '../../src/shared/device-sync';
import type { ExchangeFolder } from '../../src/shared/device-exchange';
import type { HealthStore } from './store';

export function buildInsights(store:HealthStore, now=new Date()){return buildDailyInsights(store.energy,store.exerciseRules(),now);}

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
