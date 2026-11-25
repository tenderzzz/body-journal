import { z } from 'zod';
import { deviceId, photoSchema, type Identity, type PhotoRef } from './device-sync';
import {
  idSchema,
  timeSchema,
  zoneSchema,
  memoryInputSchema,
  coachProfileSchema,
} from '../../electron/core/validation';
import { energyBackupSchema } from '../../electron/core/energy-validation';
import { dishDefinitionsSchema } from '../../electron/core/dish-validation';
import { savedAnalysis } from './record-detail';
import type { ExchangeFolder } from './device-exchange';
import type {
  CoachProfile,
  CommonDish,
  ExerciseRules,
  HealthRecord,
  Memory,
  Message,
  Settings,
  EnergyProfile,
  EnergyTarget,
  DailyEnergyInput,
  GoalProposal,
} from './types';
import type { ExerciseAlias } from './exercises';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const historyResult = z.object({
  id: deviceId,
  record: idSchema,
  revision: z.number().int().positive(),
  at: timeSchema,
  analysis: savedAnalysis,
});
export type HistoryResult = z.infer<typeof historyResult>;
export type LibraryRevision = {
  entity: 'record' | 'memory';
  id: string;
  at: string;
  doc: HealthRecord | Memory;
};
export type PersonalLibrary = {
  version: 1;
  timezone: string;
  goals: Settings['goals'];
  coach: CoachProfile;
  rules: ExerciseRules;
  aliases: ExerciseAlias[];
  dishes: CommonDish[];
  definitions: z.infer<typeof dishDefinitionsSchema>;
  memories: Memory[];
  messages: Message[];
  revisions: LibraryRevision[];
  energy: {
    profiles: EnergyProfile[];
    targets: EnergyTarget[];
    days: DailyEnergyInput[];
    proposals: GoalProposal[];
  };
  photos: { record: string; photo: PhotoRef }[];
};
const collection = z.object({ id: idSchema }).passthrough();
const schema = z.object({
  version: z.literal(1),
  timezone: zoneSchema,
  goals: z.object({
    goal: z.string(),
    kcal: z.number().nullable(),
    protein: z.number().nullable(),
    training: z.string(),
  }),
  coach: coachProfileSchema,
  rules: z.object({
    archived: z.array(z.string()),
    overrides: z.record(z.string(), z.enum(['total', 'per_hand', 'machine', 'unknown', 'bodyweight'])),
  }),
  aliases: z.array(z.object({ raw: z.string(), name: z.string() })),
  dishes: z.array(
    collection.extend({
      name: z.string(),
      template: z.array(z.object({ name: z.string() }).passthrough()),
      active: z.boolean(),
    }),
  ),
  definitions: dishDefinitionsSchema,
  memories: z.array(
    collection.extend({ text: z.string(), kind: z.string(), sourceIds: z.array(z.string()) }),
  ),
  messages: z.array(
    collection.extend({
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      createdAt: timeSchema,
      sources: z.array(z.object({ id: idSchema, revision: z.number() })),
    }),
  ),
  revisions: z.array(
    z.object({ entity: z.enum(['record', 'memory']), id: idSchema, at: timeSchema, doc: collection }),
  ),
  energy: energyBackupSchema,
  photos: z.array(z.object({ record: idSchema, photo: photoSchema })),
});
export function validateLibrary(value: unknown): PersonalLibrary {
  const data = schema.parse(value);
  for (const m of data.memories) memoryInputSchema.parse(m);
  for (const r of data.revisions) if (r.id !== r.doc.id) throw Error('历史修订编号不一致。');
  return data as unknown as PersonalLibrary;
}
const manifestSchema = z.strictObject({
  version: z.literal(1),
  archive: deviceId,
  device: deviceId,
  parts: z.array(digest).min(1),
  hash: digest,
  updated: timeSchema,
});
export type LibraryManifest = z.infer<typeof manifestSchema>;
export type Digest = (text: string) => Promise<string>;
export async function publishLibrary(
  id: Identity,
  library: PersonalLibrary,
  folder: ExchangeFolder,
  files: string[],
  hash: Digest,
) {
  const text = JSON.stringify(library),
    sum = await hash(text),
    index = 'library-' + id.device,
    known = new Set(files);
  if (known.has(index)) {
    const previous = manifestSchema.parse(JSON.parse(await folder.read(index)));
    if (
      previous.archive === id.archive &&
      previous.device === id.device &&
      previous.hash === sum &&
      previous.parts.every((p) => known.has('part-' + p))
    )
      return previous;
  }
  const parts: string[] = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + 100000, text.length);
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff)
      end--;
    const chunk = text.slice(i, end),
      key = await hash(chunk),
      name = 'part-' + key;
    if (!known.has(name)) {
      await folder.write(name, chunk);
      known.add(name);
    }
    parts.push(key);
    i = end;
  }
  const manifest: LibraryManifest = {
    version: 1,
    ...id,
    hash: sum,
    parts,
    updated: new Date().toISOString(),
  };
  await folder.write(index, JSON.stringify(manifest));
  return manifest;
}
export async function pullLibrary(
  archive: string,
  folder: ExchangeFolder,
  files: string[],
  priorHash?: string,
) {
  const manifests: LibraryManifest[] = [];
  for (const file of files.filter((f) => /^library-[a-f0-9-]{36}$/.test(f))) {
    const manifest = manifestSchema.parse(JSON.parse(await folder.read(file)));
    if (manifest.archive !== archive || file !== 'library-' + manifest.device)
      throw Error('历史档案编号不一致。');
    manifests.push(manifest);
  }
  const latest = manifests.sort(
    (a, b) => b.updated.localeCompare(a.updated) || b.device.localeCompare(a.device),
  )[0];
  if (!latest || latest.hash === priorHash) return;
  const parts = [];
  // SyncDirectory authenticates every part, including its SHA-256 filename, before decoding UTF-8.
  for (const p of latest.parts) parts.push(await folder.read('part-' + p));
  const text = parts.join('');
  return { manifest: latest, text };
}
export async function exchangeHistory(
  id: Identity,
  folder: ExchangeFolder,
  files: string[],
  local: HistoryResult[],
  accept: (item: HistoryResult) => Promise<void>,
) {
  const known = new Set(local.map((v) => v.id)),
    remote = new Set(files);
  for (const item of local)
    if (!remote.has('attempt-' + item.id))
      await folder.write('attempt-' + item.id, JSON.stringify({ archive: id.archive, item }));
  for (const file of files.filter((f) => /^attempt-[a-f0-9-]{36}$/.test(f) && !known.has(f.slice(8)))) {
    const raw = JSON.parse(await folder.read(file)),
      item = historyResult.parse(raw.item);
    if (raw.archive !== id.archive || file !== 'attempt-' + item.id) throw Error('历史分析编号不一致。');
    await accept(item);
  }
}
