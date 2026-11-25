import type {
  HealthRecord,
  DailyEnergyInput,
  EnergyProfile,
  EnergyTarget,
  DailyEnergyEstimate,
  StepReference,
  ActivityLevel,
} from './types';
import { addDays, indexEnergyRecords, estimateDay } from './energy';
import { journalDay } from './dates';
import { daySchema } from '../../electron/core/energy-validation';
const median = (values: number[]) => {
  const a = [...values].sort((x, y) => x - y),
    n = a.length;
  return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null;
};
export type EnergyRead = ReturnType<EnergyReader['read']>;
export abstract class EnergyReader {
  constructor(
    private sourceRecords: () => HealthRecord[],
    private sourceZone: () => string,
    private sourceHash?: (value: unknown) => string,
  ) {}
  abstract profiles(): EnergyProfile[];
  abstract targets(): EnergyTarget[];
  abstract days(): DailyEnergyInput[];
  today(now = new Date()) {
    return journalDay(now.toISOString(), this.sourceZone());
  }
  read(records = this.sourceRecords()) {
    const zone = this.sourceZone(),
      index = indexEnergyRecords(records, zone);
    const profiles = this.profiles(),
      targets = this.targets(),
      days = this.days(),
      weights = new Map<string, number[]>();
    for (const r of index.weights) {
      const date = index.dates.get(r.id)!;
      const group = weights.get(date);
      if (group) group.push(r.body!.weightKg!);
      else weights.set(date, [r.body!.weightKg!]);
    }
    const stepDates = new Set(days.filter((day) => day.timezone === zone).map((day) => day.date));
    for (const [date, group] of index.civil)
      if (group.some((record) => record.analysis?.dailyActivity)) stepDates.add(date);
    const sampleDays = new Map([...stepDates].map((date, order) => [date, { date, order }]));
    return {
      zone,
      records,
      index,
      profiles,
      targets,
      days,
      weights,
      sampleDays,
      inputs: new Map(days.filter((d) => d.timezone === zone).map((d) => [d.date, d])),
      estimates: new Map<string, DailyEnergyEstimate>(),
      samples: new Map<string, DailyEnergyEstimate>(),
      hashes: new Map<string, string>(),
    };
  }
  profileAt(date: string, read?: EnergyRead) {
    return (read?.profiles ?? this.profiles())
      .filter((p) => p.effectiveDate <= date)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
      .at(-1);
  }
  targetAt(date: string, read?: EnergyRead) {
    const t = (read?.targets ?? this.targets())
      .filter((t) => !t.undoneAt && t.effectiveDate <= date)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
      .at(-1);
    return t && !t.cleared ? t : null;
  }
  protected stepReference(
    date: string,
    read: EnergyRead,
    activityOverride?: ActivityLevel,
    fallbackProfile?: EnergyProfile,
  ): StepReference | undefined {
    const profile = this.profileAt(date, read) ?? fallbackProfile;
    if (!profile) return;
    const activity = activityOverride ?? read.inputs.get(date)?.activity ?? profile.activity;
    if (!read.sampleDays.size) return;
    const window = Array.from({ length: 28 }, (_, i) => read.sampleDays.get(addDays(date, -i - 1)));
    // Preserve saved evidence order when old days were entered retrospectively.
    const candidates = window.filter((v) => v !== undefined).sort((a, b) => a.order - b.order);
    const samples = candidates.flatMap(({ date }) => {
      const input = read.inputs.get(date),
        p = this.profileAt(date, read) ?? fallbackProfile;
      if (!p || (input?.activity ?? p.activity) !== activity) return [];
      // Reference extraction consumes each candidate once and does not recurse into older references.
      const key = p.id + '/' + date;
      let day = read.samples.get(key);
      if (!day) {
        day = estimateDay(date, read.zone, read.index, p, input, null);
        read.samples.set(key, day);
      }
      return day.activityComplete &&
        day.walking?.coverage === 'full' &&
        day.walking.nonTrainingSteps !== undefined &&
        !day.walking.nonTrainingStepRange &&
        !day.walking.pending
        ? [{ date, steps: day.walking.nonTrainingSteps, sources: day.sources }]
        : [];
    });
    if (samples.length < 7) return;
    const steps = Math.round(median(samples.map((s) => s.steps))!);
    return {
      method: 'history',
      steps: { low: steps, high: steps },
      dates: samples.map((s) => s.date).sort(),
      sources: [...new Map(samples.flatMap((s) => s.sources).map((s) => [s.id, s])).values()],
    };
  }
  day(date: string, read = this.read()) {
    daySchema.parse(date);
    const cached = read.estimates.get(date);
    if (cached) return cached;
    const profile = this.profileAt(date, read);
    const estimate = estimateDay(
      date,
      read.zone,
      read.index,
      profile,
      read.inputs.get(date),
      this.targetAt(date, read),
      !profile?.baselineAnchor && profile?.usualSteps === undefined
        ? this.stepReference(date, read)
        : undefined,
    );
    if (
      profile?.baselineAnchor?.dayEvidence?.some(
        (e) => this.sourceHash && this.sourceHash(read.inputs.get(e.date) ?? null) !== e.hash,
      )
    )
      estimate.assumptions.push(
        '固定参考采用的历史核对资料已有变化；保留原快照，请核对滚动建议并保存新版资料。',
      );
    read.estimates.set(date, estimate);
    return estimate;
  }
}
