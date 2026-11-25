import { EnergyReader } from '../shared/energy-reader';
import { buildDailyInsights } from '../shared/daily-insights';
import { EMPTY_RULES } from '../shared/exercises';
import { journalDay, calendarDay } from '../shared/dates';
import type { PhoneInsights } from '../shared/phone-insights';
import type { PersonalLibrary } from '../shared/personal-library';
import { healthRecord } from './analysis';
import type { PhoneIdentity, Row } from './journal';

export function localInsights(
  rows: Row[],
  lib: PersonalLibrary | null,
  cache: PhoneInsights | null,
  id: PhoneIdentity,
  now = new Date(),
): PhoneInsights | null {
  if (!lib && !rows.some((r) => r.record.detail)) return cache;
  const zone =
    lib?.timezone ?? cache?.manifest.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const records = rows.map((r) => healthRecord(r.record)).filter((r) => !r.deleted);
  class PhoneEnergy extends EnergyReader {
    profiles() {
      return lib?.energy.profiles ?? [];
    }
    targets() {
      return lib?.energy.targets ?? [];
    }
    days() {
      return lib?.energy.days ?? [];
    }
  }
  const energy = new PhoneEnergy(
    () => records,
    () => zone,
  );
  const built = buildDailyInsights(energy, lib?.rules ?? EMPTY_RULES, now);
  const local = [...built.months.values()].flat();
  const days = new Map(cache?.days.map((d) => [d.date, d]));
  const affected = new Set(
    rows
      .filter((r) => r.record.detail)
      .flatMap((r) => [journalDay(r.record.occurredAt, zone), calendarDay(r.record.occurredAt, zone)]),
  );
  for (const day of local) {
    if (lib || !days.has(day.date) || affected.has(day.date)) days.set(day.date, day);
  }
  return {
    local: true,
    partial: !lib && !!cache,
    manifest: {
      version: 1,
      archive: id.archive ?? id.device,
      device: id.device,
      timezone: zone,
      today: built.today,
      civilToday: built.civilToday,
      updated: now.toISOString(),
      months: {},
    },
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
