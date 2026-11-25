import type { Ingredient, HealthRecord } from './types';
import type { Portion } from './device-sync';
import { ingredientAmount } from './food';
function portionOf(i: Ingredient): Portion {
  const { low, high, unit } = ingredientAmount(i);
  return {
    name: i.name,
    amount: { low, high },
    unit,
    ...(i.consumedFraction ? { eaten: i.consumedFraction } : {}),
  };
}
export function confirmedPortions(r: HealthRecord): Portion[] {
  return r.userPortions ?? (r.analysis?.ingredients ?? []).filter((i) => i.userCorrected).map(portionOf);
}
export function editedPortions(old: HealthRecord, items: Ingredient[]): Portion[] {
  const confirmed = confirmedPortions(old),
    before = (old.analysis?.ingredients ?? []).map(portionOf);
  return items
    .map(portionOf)
    .filter(
      (p) =>
        confirmed.some((v) => v.name === p.name) ||
        !before.some((v) => JSON.stringify(v) === JSON.stringify(p)),
    );
}
export function applyPortions(items: Ingredient[], before: Portion[], after: Portion[]): Ingredient[] {
  const previous = [...items];
  const confirmed = after.map((p) => {
    const i = previous.findIndex((v) => v.name === p.name);
    const base =
      i < 0 ? { name: p.name, foodId: null, assumption: '人工核对的分量' } : previous.splice(i, 1)[0];
    return {
      ...base,
      amount: { ...p.amount, unit: p.unit },
      grams: p.unit === 'g' ? p.amount : { low: 0, high: 0 },
      consumedFraction: p.eaten,
      portionSource: 'reported' as const,
      userCorrected: true,
    };
  });
  return [...previous.filter((i) => !before.some((p) => p.name === i.name)), ...confirmed];
}
