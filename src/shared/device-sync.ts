import { z } from 'zod';

export function newDeviceUUID() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
export const deviceId = z.uuid().regex(/^[a-f0-9-]+$/);
const recordId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const range = z
  .strictObject({ low: z.number().min(0).max(10000), high: z.number().min(0).max(10000) })
  .refine((v) => v.low <= v.high);
export const photoSchema = z.strictObject({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  mime: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
});
const portionSchema = z.strictObject({
  name: z.string().min(1).max(200),
  amount: range,
  unit: z.enum(['g', 'ml', 'serving']),
  eaten: range.refine((v) => v.high <= 1).optional(),
});
export const syncRecordSchema = z
  .strictObject({
    id: recordId,
    kind: z.enum(['meal', 'training', 'note', 'body', 'steps']),
    body: z
      .strictObject({
        weightKg: z.number().min(10).max(500).optional(),
        waistCm: z.number().min(20).max(300).optional(),
        bodyFatPercent: z.number().gt(0).lt(100).optional(),
      })
      .optional(),
    steps: z.number().int().min(0).max(100000).optional(),
    stepCoverage: z.enum(['partial', 'full']).optional(),
    text: z.string().max(100000),
    occurredAt: z.iso.datetime({ offset: true }),
    timezone: z
      .string()
      .min(1)
      .max(80)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }),
    deleted: z.boolean(),
    photos: z.array(photoSchema).max(8),
    portions: z.array(portionSchema).max(40),
  })
  .refine((r) => r.kind === 'body' || r.body === undefined)
  .refine((r) =>
    r.kind === 'steps' ? r.steps !== undefined : r.steps === undefined && r.stepCoverage === undefined,
  )
  .refine((r) => r.kind === 'meal' || (!r.photos.length && !r.portions.length), '仅餐食可共享照片和食材分量');
export type PhotoRef = z.infer<typeof photoSchema>;
export type Portion = z.infer<typeof portionSchema>;
export type SyncRecord = z.infer<typeof syncRecordSchema>;
// Local records may also contain photos that never enter the encrypted exchange.
export type PhoneRecord = SyncRecord;
function supportsOriginalFormat(r: SyncRecord) {
  return r.kind !== 'steps' && r.kind !== 'body' && !!(r.text.trim() || r.photos.length || r.portions.length);
}
export const operationSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    archive: deviceId,
    id: deviceId,
    device: deviceId,
    parents: z.array(deviceId).max(64),
    action: z.enum(['create', 'edit', 'delete', 'restore', 'merge']),
    record: syncRecordSchema,
  })
  .refine((o) => o.version === 2 || supportsOriginalFormat(o.record))
  .refine((o) => new Set(o.parents).size === o.parents.length && !o.parents.includes(o.id));
export type Operation = z.infer<typeof operationSchema>;
export type Replica = { ops: Operation[]; written: string[]; acknowledged: string[]; receipts: string[] };
export const emptyReplica = (): Replica => ({ ops: [], written: [], acknowledged: [], receipts: [] });
export type Identity = { archive: string; device: string };
export type Delivery = 'written' | 'acknowledged' | 'receipts';
export type SyncReport = { issues: string[]; waiting: number; changed: number; at: string };
export const recoveryPattern = /^BJ1\.([a-f0-9-]{36})\.([A-Za-z0-9+/]{43}=)$/;
export function recoveryParts(code: string) {
  const match = recoveryPattern.exec(code.trim());
  if (!match || !deviceId.safeParse(match[1]).success)
    throw Error('配对码格式不完整，请重新扫描或填写完整恢复码。');
  return { archive: match[1], key: match[2] };
}
export function heads(state: Replica) {
  const used = new Set(state.ops.flatMap((op) => op.parents));
  return state.ops
    .filter((op) => !used.has(op.id))
    .sort((a, b) => Number(b.record.deleted) - Number(a.record.deleted) || (a.id < b.id ? -1 : 1));
}
export function addOperation(state: Replica, input: Operation, archive: string): Replica | 'waiting' {
  const op = operationSchema.parse(input);
  if (op.archive !== archive) throw Error('档案标识不匹配，请重新选择已配对目录。');
  const same = state.ops.find((v) => v.id === op.id);
  if (same) {
    if (JSON.stringify(operationSchema.parse(same)) !== JSON.stringify(op))
      throw Error('同一操作编号出现不同内容，已保留本机版本。');
    return state;
  }
  if (
    state.ops.some(
      (v) => v.archive !== archive || v.record.id !== op.record.id || v.record.kind !== op.record.kind,
    )
  )
    throw Error('记录编号或类别不一致');
  if (
    op.action === 'create'
      ? op.parents.length !== 0
      : op.action === 'merge'
        ? op.parents.length < 2
        : op.parents.length !== 1
  )
    throw Error('变更的父版本无效');
  const parents = op.parents.map((id) => state.ops.find((v) => v.id === id));
  if (parents.some((p) => !p)) return 'waiting';
  if (op.action !== 'create' && op.action !== 'merge') {
    const prior = parents[0]!.record;
    if (
      op.action === 'delete'
        ? prior.deleted || !op.record.deleted
        : op.action === 'restore'
          ? !prior.deleted || op.record.deleted
          : prior.deleted !== op.record.deleted
    )
      throw Error('删除或恢复操作不匹配');
    if (op.version === 1 && JSON.stringify(prior.photos) !== JSON.stringify(op.record.photos))
      throw Error('选入的照片清单发生变化');
  }
  return { ...state, ops: [...state.ops, op] };
}
export function appendLocal(state: Replica, record: SyncRecord, identity: Identity, mergeParents?: string[]) {
  const tips = heads(state);
  if (mergeParents) {
    if (
      tips.length < 2 ||
      JSON.stringify(tips.map((t) => t.id).sort()) !== JSON.stringify([...mergeParents].sort())
    )
      throw Error('冲突版本已更新，请重新查看。');
  } else if (tips.length > 1) throw Error('请先在同步详情中处理这条记录的冲突。');
  const previous = tips[0]?.record;
  const clean = syncRecordSchema.parse(record);
  if (!mergeParents && previous && JSON.stringify(previous) === JSON.stringify(clean)) return state;
  const action = mergeParents
    ? 'merge'
    : !previous
      ? 'create'
      : previous.deleted === record.deleted
        ? 'edit'
        : record.deleted
          ? 'delete'
          : 'restore';
  const next = addOperation(
    state,
    {
      version:
        supportsOriginalFormat(clean) &&
        (!previous || JSON.stringify(previous.photos) === JSON.stringify(clean.photos))
          ? 1
          : 2,
      ...identity,
      id: newDeviceUUID(),
      parents: tips.map((t) => t.id),
      action,
      record: clean,
    },
    identity.archive,
  );
  if (next === 'waiting') throw Error('缺少本地版本');
  return next;
}
export function deliveryLabel(replica: Replica | null | undefined, device: string) {
  if (!replica) return '已存本机';
  const tips = heads(replica);
  if (tips.length > 1) return '两端修改有冲突';
  const tip = tips[0];
  if (!tip) return '已存本机';
  if (tip.device !== device)
    return replica.receipts.includes(tip.id) ? '另一台设备已接收' : '照片或回执待补齐';
  if (replica.acknowledged.includes(tip.id)) return '另一台设备已接收';
  return replica.written.includes(tip.id) ? '已写入共享文件夹' : '待发送';
}
export function portionLabel(p: Portion) {
  const amount = p.amount.low === p.amount.high ? String(p.amount.low) : p.amount.low + '–' + p.amount.high;
  const fraction = p.eaten
    ? p.eaten.low === p.eaten.high
      ? Math.round(p.eaten.low * 100) + '%'
      : Math.round(p.eaten.low * 100) + '–' + Math.round(p.eaten.high * 100) + '%'
    : null;
  return (
    p.name +
    ' ' +
    amount +
    ' ' +
    { g: '克', ml: '毫升', serving: '份' }[p.unit] +
    (fraction ? '，吃了' + (fraction === '50%' ? '一半' : fraction) : '')
  );
}
export type RecordSyncInfo = {
  device: string;
  archive?: string;
  replica: Replica | null;
  photos: PhotoRef[];
  missing: number[];
  eligible: boolean;
};
export type SyncSettings = {
  archive?: string;
  device: string;
  enabled: boolean;
  folder?: string;
  report?: SyncReport;
  conflicts: string[];
  pending: number;
};
