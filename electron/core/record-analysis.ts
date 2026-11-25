import type { Analysis, HealthRecord, ModelRun, FoodPreset, ExerciseRules } from '../../src/shared/types';
import { normalizeAnalysis, type ExerciseAlias } from '../../src/shared/exercises';
import { prepareMealIngredients, ingredientIdentity } from '../../src/shared/food';
import { mealLabel, mealSlot } from '../../src/shared/meals';
import { analysisSchema } from './validation';
import { localAnalysisSchema } from '../../src/shared/record-detail';
import { normalizeModelOutput } from '../ai/model-output';
import { parseTraining } from './parser';
import { FoodCatalog } from './nutrition';
export type AnalysisContext = {
  catalog: FoodCatalog;
  record(id: string): HealthRecord;
  foodPresets(at: Date): FoodPreset[];
  exerciseAliases(): ExerciseAlias[];
  exerciseRules(): ExerciseRules;
};
// Model output cannot replace user corrections, including fields explicitly cleared.
export function withActivityOverrides<
  T extends Pick<Analysis, 'run' | 'training' | 'dailyActivity' | 'activityOverrides'>,
>(analysis: T, overrides: Analysis['activityOverrides']): T {
  const next = { ...analysis, activityOverrides: overrides };
  for (const group of ['run', 'training', 'dailyActivity'] as const) {
    if (overrides?.[group]) Object.assign(next, { [group]: { ...next[group], ...overrides[group] } });
  }
  for (const field of overrides?.cleared ?? []) {
    const [group, key] = field.split('.');
    if (['run', 'training', 'dailyActivity'].includes(group) && key) {
      const object = next[group as 'run'] as Record<string, unknown> | undefined;
      if (object) delete object[key];
    }
  }
  return next;
}

export function parseAnalysisOutput(old: HealthRecord, value: unknown, engine: Analysis['engine']) {
  // Earlier meal prompts requested only the source id for an identical meal.
  // Supply the display text locally for that response; ordinary analyses still
  // require their summary, and source/ingredient validation below stays intact.
  const normalized =
    engine === 'local'
      ? { value, memoryWarnings: [] as string[] }
      : normalizeModelOutput(value, 'analysis');
  value = normalized.value;
  const result =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const copyResult =
    old.kind === 'meal' && result?.summary === undefined && typeof result?.copyFromRecordId === 'string';
  const schema = engine === 'local' ? localAnalysisSchema : analysisSchema;
  let a = withActivityOverrides(
    schema.parse(copyResult ? { ...result, summary: '按历史同款餐食复用' } : value),
    old.analysis?.activityOverrides,
  );
  if (engine !== 'local') {
    a = { ...a, memoryWarnings: normalized.memoryWarnings };
    if (a.sets) {
      const source = [old.text, ...(old.followups ?? []).map((f) => f.answer)].join('\n');
      const sourceSets = old.attachments.length ? [] : (parseTraining(source)?.sets ?? []);
      a.sets = a.sets.map((set) => {
        const named = sourceSets.filter(
          (s) =>
            s.exercise === set.exercise ||
            s.originalExercise === set.exercise ||
            (s.originalExercise === set.originalExercise && !!set.originalExercise),
        );
        const missingWeight =
          named.length > 0 &&
          named.every((s) => s.kg === null) &&
          !/(?:kg|公斤|千克|磅|lb|斤)/i.test(source);
        return {
          ...set,
          ...(set.loadBasis === 'unknown' ? { basisSource: 'unresolved', confirmed: false } : {}),
          ...(missingWeight && set.kg !== null ? { kg: null, confirmed: false } : {}),
        };
      });
    }
  }
  return { a, normalized };
}
export function finishRecordAnalysis(
  context: AnalysisContext,
  old: HealthRecord,
  a: ReturnType<typeof parseAnalysisOutput>['a'],
  engine: Analysis['engine'],
  manualMeal = false,
  modelRun?: ModelRun,
) {
  // 明确说“和某天哪一餐一样”时，食材与分量整份复制，本地重新计算营养；模型的临时估算不采用。
  const changedPortion =
    engine !== 'local' &&
    a.copyFromRecordId &&
    /(?:但|改成|改为|这次).{0,20}(?:半|少|多|换|去掉|不加|没吃)/.test(old.text);
  const halfName = old.text.match(
    /(?:^|[，,、。；;\s])([^，,、。；;\s]{1,24}?)(?:改成|改为|吃了|只吃)?半份(?:$|[，,、。；;\s])/u,
  )?.[1];
  if (changedPortion && !halfName) {
    a = {
      ...a,
      copyFromRecordId: undefined,
      ...(!a.ingredients?.length ? { questions: ['和上次相比，哪些食材或分量有变化？'] } : {}),
    };
  }
  const mealClarification =
    old.kind === 'meal' &&
    engine !== 'local' &&
    !a.ingredients?.length &&
    !a.copyFromRecordId &&
    /照旧|一样|同上|同款|相同/.test(old.text)
      ? a.questions[0]
      : undefined;
  if (mealClarification && old.analysis?.ingredients?.length)
    a = { ...a, ingredients: old.analysis.ingredients };
  if (a.copyFromRecordId) {
    let source;
    try {
      source = context.record(a.copyFromRecordId);
    } catch {
      throw new Error('引用的那餐记录不存在，请换一条或直接描述这餐。');
    }
    if (Date.parse(source.occurredAt) > Date.parse(old.occurredAt))
      throw new Error('不能使用发生日期之后的餐食作历史依据');
    if (source.id === old.id) throw new Error('不能把这条记录设为复制自身');
    if (source.kind !== 'meal' || source.deleted || !source.analysis?.ingredients?.length)
      throw new Error('引用的那餐没有可复制的食材记录，请换一条或直接描述这餐。');
    const label = mealLabel(source.occurredAt, source.timezone);
    const matching = halfName
      ? source.analysis.ingredients.filter((i) => i.name.includes(halfName) || halfName.includes(i.name))
      : [];
    if (halfName && matching.length !== 1) throw Error('请指出历史餐食中哪一项改为半份，然后重试。');
    a = {
      ...a,
      copyFromRecordId: undefined,
      ingredients: source.analysis.ingredients.map((i) => ({
        ...i,
        ...(matching.includes(i)
          ? {
              consumedFraction: { low: 0.5, high: 0.5 },
              userCorrected: true,
              portionSource: 'reported' as const,
            }
          : {}),
        assumption: `${i.assumption}；复制自 ${label}`,
      })),
      summary: `${a.summary}（按 ${label} 的同款记录复制）`,
      assumptions: [...a.assumptions, `食材与分量取自 ${label} 的同款记录；如需改动可在记录详情调整。`],
      copiedFrom: {
        recordId: source.id,
        occurredAt: source.occurredAt,
        slot: mealSlot(source.occurredAt, source.timezone),
        label,
      },
    };
  }
  // 常用食物（蛋白粉等）的标签营养由本地强制覆盖，避免模型每次重新估计。
  if (a.ingredients) {
    const exclusions = new Set(old.analysis?.excludedIngredientIdentities ?? []);
    if (manualMeal) {
      const incoming = new Set(a.ingredients.map(ingredientIdentity));
      for (const i of old.analysis?.ingredients ?? [])
        if (!incoming.has(ingredientIdentity(i))) exclusions.add(ingredientIdentity(i));
      for (const id of incoming) exclusions.delete(id);
    }
    a = {
      ...a,
      excludedIngredientIdentities: [...exclusions],
      ingredients: prepareMealIngredients(
        context.catalog.resolveIngredients(a.ingredients),
        context.foodPresets(new Date(old.occurredAt)),
        {
          previous: old.analysis?.ingredients,
          manual: manualMeal,
          text: old.text,
          attachHashes: old.attachments.map((a) => a.sha256),
        },
      ).filter((i) => !exclusions.has(ingredientIdentity(i))),
    };
    const sourceNotes = a
      .ingredients!.filter((i) => i.nutrition?.provenance === 'preset')
      .map(
        (i) =>
          `营养按常用食物“${i.name}”的${i.nutrition?.source === 'label' ? '标签数据' : '已保存的估算数据'}计算。`,
      );
    a = {
      ...a,
      assumptions: [
        ...new Set([
          ...a.assumptions.filter(
            (note) => !/^营养按常用食物“.*”的(?:标签数据|已保存的估算数据)计算。$/.test(note),
          ),
          ...sourceNotes,
        ]),
      ].slice(0, 20),
    };
    if (old.kind === 'meal')
      a = { ...a, questions: context.catalog.mealQuestions(a.ingredients!, a.questions) };
  }
  const calc: Partial<ReturnType<FoodCatalog['calculate']>> = a.ingredients
    ? context.catalog.calculate(a.ingredients)
    : {};
  if (
    old.kind === 'meal' &&
    engine !== 'local' &&
    !mealClarification &&
    (!a.ingredients?.length || ('unmatched' in calc && calc.unmatched?.length))
  ) {
    const detail = calc.unmatched?.slice(0, 6).join('、') || '模型未返回可计算的食材';
    throw new Error(`食材暂时不能合计：${detail}。原记录已保留，请核对计量单位或营养估算依据。`);
  }
  if (mealClarification) a = { ...a, questions: [mealClarification] };
  const analysis: Analysis = normalizeAnalysis(
    {
      ...a,
      ...calc,
      engine,
      ...(engine !== 'local' && modelRun ? { modelRun } : {}),
      at: new Date().toISOString(),
    },
    old.text,
    context.exerciseAliases(),
    context.exerciseRules(),
  );
  const status: HealthRecord['status'] = mealClarification
    ? 'needs_info'
    : old.kind === 'meal' && (!a.ingredients?.length || ('unmatched' in calc && calc.unmatched?.length))
      ? 'pending'
      : a.questions.length
        ? 'needs_info'
        : 'ready';
  return { analysis, status };
}
