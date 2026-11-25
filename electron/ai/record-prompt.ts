import type { HealthRecord, FoodPreset, CommonDish, Memory } from '../../src/shared/types';
import type { FoodCatalog } from '../core/nutrition';
import { matchDish, dishNameSimilarity } from '../../src/shared/dishes';
import { journalDay } from '../../src/shared/dates';
import { mealSlot } from '../../src/shared/meals';
export type PromptData = {
  record: (id: string) => HealthRecord;
  records: () => HealthRecord[];
  foodPresets: (at: Date) => FoodPreset[];
  commonDishes: (at: Date) => CommonDish[];
  catalog: FoodCatalog;
  timezone: string;
  memoryContext: (purpose: 'meal' | 'training', query: string, at: Date) => { items: Memory[] };
};
export function recordPrompt(data: PromptData, id: string) {
  const r = data.record(id),
    previousAnalysis =
      r.kind === 'meal'
        ? r.analysis?.ingredients?.length
          ? r.analysis
          : (r.followups?.at(-1)?.previousAnalysis ?? r.analysis)
        : (r.followups?.at(-1)?.previousAnalysis ?? r.analysis);
  const personalFoods = data
    .foodPresets(new Date(r.occurredAt))
    .sort((a, b) => Number(r.text.includes(b.name)) - Number(r.text.includes(a.name)))
    .slice(0, 12);
  const dishes = r.kind === 'meal' ? data.commonDishes(new Date(r.occurredAt)).filter((d) => d.active) : [];
  const commonDish = matchDish(r, dishes);
  const matchedDish = dishes.find((d) => d.id === commonDish?.id);
  const commonDishCandidates = dishes
    .filter((d) => d.id !== commonDish?.id)
    .sort((a, b) => dishNameSimilarity(r.text, b.name) - dishNameSimilarity(r.text, a.name))
    .slice(0, 8)
    .map((d) => ({
      id: d.id,
      name: d.name,
      brand: d.brand,
      aliases: d.aliases,
      sourceRecordId: d.latestRecordId,
      ingredients: d.template,
    }));
  const foods = data.catalog
    .promptCatalog(r.text)
    .map((f) => ({ id: f.id, name: f.zh ?? f.description, description: f.description }));
  const selection = data.memoryContext(
    r.kind === 'training' ? 'training' : 'meal',
    r.text,
    new Date(r.occurredAt),
  );
  const personalMemories = selection.items
    .filter((m) => !commonDish || m.autoCategory !== 'meal' || m.subject !== commonDish.id)
    .slice(0, 40)
    .map(
      ({
        id,
        revision,
        kind,
        text,
        subject,
        versionStartsAt,
        startsAt,
        expiresAt,
        evidence,
        confirmed,
        mealTemplate,
        topicKey,
        food,
      }) => ({
        id,
        revision,
        kind,
        text,
        subject,
        versionStartsAt,
        startsAt,
        expiresAt,
        evidence,
        confirmed,
        mealTemplate,
        topicKey,
        food: food ? { name: food.name, brand: food.brand } : undefined,
      }),
    );
  const mealHistory =
    r.kind === 'meal' && /一样|照旧|同上|同款|相同/.test(r.text)
      ? data
          .records()
          .filter(
            (x) =>
              !x.deleted &&
              x.kind === 'meal' &&
              x.id !== r.id &&
              Date.parse(x.occurredAt) <= Date.parse(r.occurredAt) &&
              Date.parse(x.occurredAt) >= Date.parse(r.occurredAt) - 90 * 86400000 &&
              x.analysis?.ingredients?.length,
          )
          .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
          .slice(0, 40)
          .map((x) => ({
            id: x.id,
            occurredAt: x.occurredAt,
            day: journalDay(x.occurredAt, data.timezone),
            slot: mealSlot(x.occurredAt, x.timezone),
            text: x.text.slice(0, 240),
            ingredients: x.analysis!.ingredients!.map((i) => ({
              name: i.name,
              grams: i.grams,
              amount: i.amount,
              consumedFraction: i.consumedFraction,
              portionSource: i.portionSource,
              foodState: i.foodState,
              productId: i.productId,
            })),
            macros: x.analysis!.macros
              ? { kcal: x.analysis!.macros.kcal, protein: x.analysis!.macros.protein }
              : undefined,
          }))
      : [];
  const prompt = JSON.stringify({
    personalMemories,
    personalFoods,
    mealHistory,
    commonDish: matchedDish
      ? {
          id: matchedDish.id,
          name: matchedDish.name,
          brand: matchedDish.brand,
          sourceRecordId: matchedDish.latestRecordId,
          occurredAt: matchedDish.latestAt,
          ...(!previousAnalysis?.ingredients?.length ? { ingredients: matchedDish.template } : {}),
        }
      : undefined,
    commonDishCandidates,
    now: new Date().toISOString(),
    record: {
      id: r.id,
      kind: r.kind,
      occurredAt: r.occurredAt,
      timeSource: r.timeSource,
      dateResolution: r.dateResolution,
      text: r.text,
      attachments: r.attachments.map((a) => ({ sha256: a.sha256, name: a.name })),
      body: r.body,
      previousIngredients: previousAnalysis?.ingredients,
      followups: r.followups?.map(({ answer, questions, at }) => ({ answer, questions, at })),
      previousAnalysis: previousAnalysis
        ? {
            summary: previousAnalysis.summary,
            questions: previousAnalysis.questions,
            assumptions: previousAnalysis.assumptions,
            training: previousAnalysis.training,
            sets: previousAnalysis.sets,
            run: previousAnalysis.run,
          }
        : undefined,
    },
    foodCatalog: foods,
  });
  return { r, prompt };
}
