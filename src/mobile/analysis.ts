import { parseAnalysisOutput, finishRecordAnalysis } from '../../electron/core/record-analysis';
import { FoodCatalog } from '../../electron/core/nutrition';
import { recordPrompt } from '../../electron/ai/record-prompt';
import { parseModelJSON } from '../../electron/ai/transport';
import { analysisInstructions } from '../../electron/ai/prompts/analysis';
import { CURRENT_PROMPT } from '../../electron/ai/prompts/version';
import { coachInstructions, DEFAULT_COACH } from '../../electron/core/coaching';
import { selectMemories } from '../../electron/core/memory';
import { EMPTY_RULES } from '../shared/exercises';
import { validMemory } from '../shared/stats';
import { editedPortions } from '../shared/portions';
import { detailOf } from '../shared/record-detail';
import { newDeviceUUID, type PhoneRecord } from '../shared/device-sync';
import type { HealthRecord, Analysis, Food, SetEntry } from '../shared/types';
import type { PersonalLibrary } from '../shared/personal-library';
import type { MobileModels } from './models';
import { stamp, type Row, type PhoneJournalModel } from './journal';
import dataset from '../../data/foods.json';
const catalog = new FoodCatalog(dataset.foods as Food[]);
export function healthRecord(r: PhoneRecord): HealthRecord {
  const detail = r.detail;
  const steps =
    r.kind === 'steps'
      ? {
          engine: 'local' as const,
          at: r.occurredAt,
          summary: '手动记录步数',
          questions: [],
          assumptions: [],
          dailyActivity: {
            steps: r.steps,
            coverage: r.stepCoverage ?? ('partial' as const),
            scope: 'all' as const,
            sourceApp: 'iPhone 手动记录',
          },
        }
      : null;
  return {
    id: r.id,
    text: r.text,
    kind: r.kind === 'steps' ? 'note' : r.kind,
    occurredAt: r.occurredAt,
    timezone: r.timezone,
    deleted: r.deleted,
    attachments: r.photos.map((p, i) => ({
      name: '照片 ' + (i + 1),
      file: p.hash + '.' + p.mime.split('/')[1],
      sha256: p.hash,
      mime: p.mime,
    })),
    body: r.body ?? null,
    analysis: detail?.analysis ?? steps,
    revision: detail?.revision ?? 1,
    createdAt: detail?.createdAt ?? r.occurredAt,
    updatedAt: detail?.updatedAt ?? r.occurredAt,
    userPortions: r.portions,
    followups: detail?.followups ?? [],
    analysisPending: detail?.pending,
    status: detail?.status ?? (steps || r.kind === 'body' ? 'ready' : 'pending'),
    dishId: detail?.dishId,
    source: 'iPhone',
  };
}
function context(records: HealthRecord[], lib: PersonalLibrary | null, zone: string) {
  const memoriesAt = (date: Date) => {
    const versions =
      lib?.revisions
        .filter((r) => r.entity === 'memory')
        .map((r) => r.doc as import('../shared/types').Memory) ?? [];
    const found = new Map<string, import('../shared/types').Memory>();
    for (const m of [...versions, ...(lib?.memories ?? [])]) {
      if (Date.parse(m.versionStartsAt ?? m.startsAt) > +date) continue;
      const prev = found.get(m.id);
      if (!prev || (m.revision ?? 1) >= (prev.revision ?? 1)) found.set(m.id, m);
    }
    return [...found.values()];
  };
  return {
    catalog,
    record: (id: string) => {
      const r = records.find((x) => x.id === id);
      if (!r) throw Error('找不到这条历史记录。');
      return r;
    },
    records: () => records,
    timezone: lib?.timezone ?? zone,
    exerciseAliases: () => lib?.aliases ?? [],
    exerciseRules: () => lib?.rules ?? EMPTY_RULES,
    commonDishes: (at: Date) => (lib?.dishes ?? []).filter((d) => Date.parse(d.latestAt) <= +at),
    foodPresets: (at: Date) =>
      memoriesAt(at)
        .filter((m) => m.kind === 'food' && m.food && validMemory(m, at))
        .map((m) => m.food!),
    memoryContext: (purpose: 'meal' | 'training', query: string, at: Date) =>
      selectMemories(memoriesAt(at), purpose, query, at),
  };
}
export class PhoneAnalysis {
  private pending = new Map<string, Promise<Row>>();
  constructor(
    private phone: PhoneJournalModel,
    private models: MobileModels,
  ) {}
  analyze(row: Row, photos: number[]) {
    const existing = this.pending.get(row.record.id);
    if (existing) return existing;
    const request = this.run(row, photos).finally(() => this.pending.delete(row.record.id));
    this.pending.set(row.record.id, request);
    return request;
  }
  private async run(row: Row, photos: number[]) {
    const r = row.record,
      source = healthRecord(r);
    if (r.deleted || !['meal', 'training'].includes(r.kind)) throw Error('请选择一条有效餐食或训练记录。');
    const library = await this.phone.library(),
      records = (await this.phone.rows()).map((x) => healthRecord(x.record));
    const indices = [...new Set(photos)];
    if (indices.some((i) => !Number.isInteger(i) || !r.photos[i]))
      throw Error('所选照片已变化，请重新选择。');
    const input = { ...source, attachments: indices.map((i) => source.attachments[i]) };
    const data = context([input, ...records.filter((other) => other.id !== r.id)], library, r.timezone);
    const { prompt } = recordPrompt(data, r.id);
    const images = [];
    for (const index of indices) {
      const { url } = await this.phone.call<{ url?: string }>('preview', {
        photo: r.photos[index],
        full: true,
      });
      if (!url) throw Error('所选原照片尚未到达，请稍后重试或取消勾选。');
      images.push(url);
    }
    const reply = await this.models.infer(
      analysisInstructions(
        source.kind,
        source.kind === 'training'
          ? coachInstructions(library?.coach ?? DEFAULT_COACH, '训练记录').text
          : '',
      ),
      prompt,
      images,
    );
    const { a } = parseAnalysisOutput(input, parseModelJSON(reply.text), reply.provider);
    // Model-proposed memories need supporting evidence. A phone analysis may read confirmed memories.
    a.memoryChanges = [];
    const { analysis, status } = finishRecordAnalysis(data, input, a, reply.provider, false, {
      provider: reply.provider,
      model: reply.model,
      promptVersion: CURRENT_PROMPT,
    });
    const current = {
      ...source,
      analysis,
      status,
      analysisPending: false,
      revision: source.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    try {
      return await this.phone.save({ ...r, detail: detailOf(current) }, stamp(row));
    } catch (error) {
      const latest = (await this.phone.rows()).find((v) => v.record.id === r.id);
      if (!latest || stamp(latest) === stamp(row)) throw error;
      await this.phone.keepAttempt({
        id: newDeviceUUID(),
        record: r.id,
        revision: source.revision,
        at: analysis.at,
        analysis: detailOf(current).analysis!,
      });
      throw Error('分析期间记录已修改。返回结果已保存在本条的分析历史。');
    }
  }
  async correct(row: Row, update: { food: number; fraction: number } | { sets: SetEntry[] }) {
    const source = healthRecord(row.record),
      prior = source.analysis;
    if (!prior || source.deleted) throw Error('请先分析记录。');
    let changes: Partial<Analysis>;
    if ('food' in update) {
      if (
        !prior.ingredients?.[update.food] ||
        !Number.isFinite(update.fraction) ||
        update.fraction < 0 ||
        update.fraction > 1
      )
        throw Error('请核对食材和食用比例。');
      changes = {
        ingredients: prior.ingredients.map((i, n) =>
          n === update.food
            ? {
                ...i,
                consumedFraction: { low: update.fraction, high: update.fraction },
                userCorrected: true,
              }
            : i,
        ),
      };
    } else changes = { sets: update.sets };
    const lib = await this.phone.library(),
      data = context([source], lib, source.timezone);
    const { a } = parseAnalysisOutput(source, { ...prior, ...changes }, 'local');
    const { analysis, status } = finishRecordAnalysis(data, source, a, 'local', 'food' in update);
    const portions =
      'food' in update ? editedPortions(source, analysis.ingredients ?? []) : row.record.portions;
    return this.phone.save(
      {
        ...row.record,
        portions,
        detail: detailOf({
          ...source,
          analysis,
          status,
          analysisPending: false,
          revision: source.revision + 1,
          updatedAt: new Date().toISOString(),
        }),
      },
      stamp(row),
    );
  }
  async followup(row: Row, answer: string) {
    const r = healthRecord(row.record);
    if (!answer.trim() || answer.length > 10000) throw Error('请填写 1 至 10000 字补充。');
    const at = new Date().toISOString(),
      followups = [
        ...(r.followups ?? []),
        {
          answer: answer.trim(),
          questions: r.analysis?.questions ?? [],
          at,
          previousAnalysis: r.analysis ?? undefined,
        },
      ];
    return this.phone.save(
      {
        ...row.record,
        detail: detailOf({
          ...r,
          revision: r.revision + 1,
          updatedAt: at,
          followups,
          analysisPending: true,
        }),
      },
      stamp(row),
    );
  }
}
