import path from 'node:path';
import { statSync } from 'node:fs';
import { ingredientAmount } from '../../src/shared/food';
import {
  addOperation,
  appendLocal,
  emptyReplica,
  heads,
  photoSchema,
  syncRecordSchema,
  type Delivery,
  type Operation,
  type PhotoRef,
  type Portion,
  type RecordSyncInfo,
  type Replica,
  type SyncRecord,
} from '../../src/shared/device-sync';
import type { HealthRecord, Ingredient } from '../../src/shared/types';
import type { HealthStore } from './store';
import type { ReplicaStore } from '../../src/shared/device-exchange';

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
function visible(r: HealthRecord, photos: PhotoRef[]): SyncRecord {
  return syncRecordSchema.parse({
    id: r.id,
    kind: r.kind,
    text: r.text,
    occurredAt: r.occurredAt,
    timezone: r.timezone,
    deleted: r.deleted,
    photos,
    portions: r.kind === 'meal' ? confirmedPortions(r) : [],
  });
}
export class MacReplicas implements ReplicaStore {
  device: string = crypto.randomUUID();
  constructor(private store: HealthStore) {}
  get archive() {
    return this.store.getConfig<string>('deviceSyncArchive');
  }
  bind(archive: string) {
    if (this.archive && this.archive !== archive) throw Error('此本地档案已绑定其他共享档案。请选择原目录。');
    this.store.setConfig('deviceSyncArchive', archive);
  }
  get(id: string): Replica | null {
    const row = this.store.db.prepare('SELECT doc FROM device_records WHERE id=?').get(id);
    return row ? JSON.parse(String(row.doc)) : null;
  }
  all(): Replica[] {
    return this.store.db
      .prepare('SELECT doc FROM device_records')
      .all()
      .map((row) => JSON.parse(String(row.doc)));
  }
  async replicas() {
    return this.all();
  }
  private put(id: string, r: Replica) {
    this.store.db
      .prepare('INSERT INTO device_records VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc')
      .run(id, JSON.stringify(r));
  }
  info(id: string): RecordSyncInfo {
    const r = this.store.record(id),
      replica = this.get(id);
    const photos =
      r.kind === 'meal'
        ? r.attachments.map((a) =>
            photoSchema.parse({
              hash: a.sha256,
              mime: a.mime,
              bytes: statSync(path.join(this.store.root, a.file)).size,
            }),
          )
        : [];
    const missing = (replica ? heads(replica)[0].record.photos : []).flatMap((p, i) =>
      photos.some((a) => a.hash === p.hash) ? [] : [i + 1],
    );
    return {
      device: this.device,
      archive: this.archive,
      replica,
      photos,
      missing,
      eligible: r.kind !== 'body' && !r.analysis?.dailyActivity,
    };
  }
  enroll(id: string, revision: number, indices: number[]) {
    if (!this.archive) throw Error('请先在「连接与数据」配对共享文件夹。');
    return this.store.transaction(() => {
      const r = this.store.record(id);
      if (this.get(id)) return;
      if (r.revision !== revision) throw Error('记录已更新，请重新预览后选入。');
      const info = this.info(id);
      if (!info.eligible || indices.some((i) => !info.photos[i])) throw Error('记录或照片不在可选范围。');
      const photos = info.photos.filter((_, i) => indices.includes(i));
      this.put(
        id,
        appendLocal(emptyReplica(), visible(r, photos), { archive: this.archive!, device: this.device }),
      );
    });
  }
  userChange(r: HealthRecord) {
    const replica = this.get(r.id);
    if (!replica) return;
    const current = heads(replica)[0];
    this.put(
      r.id,
      appendLocal(replica, visible(r, current.record.photos), {
        archive: current.archive,
        device: this.device,
      }),
    );
  }
  async accept(op: Operation) {
    return this.store.transaction(() => {
      const prior = this.get(op.record.id) ?? emptyReplica();
      const next = addOperation(prior, op, this.archive ?? '');
      if (next === 'waiting') return 'waiting' as const;
      if (next === prior) return 'duplicate' as const;
      if (!prior.ops.length && this.store.db.prepare('SELECT 1 FROM records WHERE id=?').get(op.record.id))
        throw Error('本机已有同编号记录。请先在记录详情核对并选入，再处理版本。');
      this.put(op.record.id, next);
      this.materialize(prior, next);
      return 'added' as const;
    });
  }
  private materialize(prior: Replica, next: Replica) {
    const previous = heads(prior)[0],
      chosen = heads(next)[0];
    if (previous?.id !== chosen.id) this.store.applyDeviceRecord(chosen.record, previous?.record);
  }
  resolve(id: string, parents: string[], choice: string, text?: string) {
    this.store.transaction(() => {
      const prior = this.get(id);
      const chosen = prior && heads(prior).find((op) => op.id === choice);
      if (!chosen || !prior || !this.archive) throw Error('请重新打开冲突详情。');
      const record = { ...chosen.record, text: text ?? chosen.record.text };
      const next = appendLocal(prior, record, { archive: this.archive, device: this.device }, parents);
      this.put(id, next);
      this.materialize(prior, next);
    });
  }
  async mark(id: string, op: string, status: Delivery) {
    const r = this.get(id);
    if (r && !r[status].includes(op)) this.put(id, { ...r, [status]: [...r[status], op] });
  }
  async hydrate(id: string) {
    const r = this.get(id);
    if (r) this.store.transaction(() => this.store.applyDeviceRecord(heads(r)[0].record, heads(r)[0].record));
  }
}
