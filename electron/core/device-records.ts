import {detailOf} from '../../src/shared/record-detail';
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

export { confirmedPortions,editedPortions,applyPortions } from '../../src/shared/portions';
import {confirmedPortions} from '../../src/shared/portions';
function visible(r: HealthRecord, photos: PhotoRef[], prior?: SyncRecord, detailed = !!prior?.detail): SyncRecord {
  return syncRecordSchema.parse({
    detail: detailed ? detailOf(r) : undefined,
    id: r.id,
    kind: prior?.kind === 'steps' ? 'steps' : r.kind,
    ...(r.kind === 'body' && r.body ? { body: r.body } : {}),
    ...(prior?.kind === 'steps'
      ? {
          steps: r.analysis?.dailyActivity?.steps ?? prior.steps,
          stepCoverage: r.analysis?.dailyActivity?.coverage ?? prior.stepCoverage,
        }
      : {}),
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
      r.kind === 'meal' || !!heads(replica ?? emptyReplica())[0]?.record.detail || !!this.store.getConfig('personalLibraryEnabled')
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
      eligible: true,
    };
  }
  enroll(id: string, revision: number, indices: number[]) {
    if (!this.archive) throw Error('请先在「连接与数据」配对共享文件夹。');
    return this.store.transaction(() => {
      const r = this.store.record(id);
      if (r.revision !== revision) throw Error('记录已更新，请重新打开后选择照片。');
      const info = this.info(id);
      if (indices.some((i) => !info.photos[i])) throw Error('请重新选择餐食照片。');
      const replica = info.replica ?? emptyReplica(),
        prior = heads(replica)[0]?.record;
      const existing = prior?.photos ?? [];
      const photos = [
        ...existing,
        ...info.photos.filter((p, i) => indices.includes(i) && !existing.some((old) => old.hash === p.hash)),
      ];
      const next = appendLocal(replica, visible(r, photos, prior), {
        archive: this.archive!,
        device: this.device,
      });
      if (next !== replica) this.put(id, next);
    });
  }
  backfill() {
    if (!this.archive) return;
    const rows = this.store.db
      .prepare(
        `SELECT r.doc FROM records r LEFT JOIN device_records d ON d.id=r.id
      WHERE d.id IS NULL AND COALESCE(json_extract(r.doc,'$.deleted'),0)=0`,
      )
      .all();
    this.store.transaction(() => {
      for (const row of rows) this.userChange(JSON.parse(String(row.doc)));
    });
  }
  userChange(r: HealthRecord, migrate = false) {
    const archive = this.archive;
    if (!archive) return;
    const replica = this.get(r.id) ?? emptyReplica();
    if (r.deleted && !replica.ops.length && !migrate) return;
    const prior = heads(replica)[0]?.record;
    const full = !!this.store.getConfig('personalLibraryEnabled');
    const since = this.store.getConfig<string>('deviceDetailSince');
    const detailed = full || !!prior?.detail || !!since && r.createdAt >= since;
    const available = full ? this.info(r.id).photos : [];
    const photos = full ? [...available,...(prior?.photos??[]).filter(p=>!available.some(v=>v.hash===p.hash))] : prior?.photos ?? [];
    const next = appendLocal(replica, visible(r, photos, prior, detailed), {
      archive,
      device: this.device,
    });
    if (replica === next) return false;
    this.put(r.id, next);
    return true;
  }
  // A fresh reader gets original revisions from the library. Replaying old packets
  // as new edits would create a second, locally dated history for the same records.
  forExchange(files: string[]): ReplicaStore {
    if (!this.store.getConfig('personalRestoreReader') || this.store.getConfig('personalRestoreHash') ||
        !files.some((file) => file.startsWith('library-'))) return this;
    return {
      replicas: () => this.replicas(),
      accept: (op) => this.accept(op, true),
      mark: (id, op, status) => this.mark(id, op, status),
      hydrate: (id, photos) => this.hydrate(id, photos, true),
    };
  }
  async accept(op: Operation, restoring = false) {
    return this.store.transaction(() => {
      const prior = this.get(op.record.id) ?? emptyReplica();
      const next = addOperation(prior, op, this.archive ?? '');
      if (next === 'waiting') return 'waiting' as const;
      if (next === prior) return 'duplicate' as const;
      if (!prior.ops.length && this.store.db.prepare('SELECT 1 FROM records WHERE id=?').get(op.record.id))
        throw Error('本机已有同编号记录。请先在记录详情核对并选入，再处理版本。');
      this.put(op.record.id, next);
      this.materialize(prior, next, restoring);
      return 'added' as const;
    });
  }
  private materialize(prior: Replica, next: Replica, restoring = false) {
    const previous = heads(prior)[0],
      chosen = heads(next)[0];
    if (previous?.id !== chosen.id) {
      const replay = restoring && !next.ops.some((op) => op.device === this.device);
      this.store.applyDeviceRecord(chosen.record, previous?.record, replay ? 'archive' : 'change');
    }
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
  async hydrate(id: string, _photos: PhotoRef[] = [], restoring = false) {
    const replica = this.get(id);
    if (!replica) return;
    const record = heads(replica)[0].record;
    const replay = restoring && !replica.ops.some((op) => op.device === this.device);
    this.store.transaction(() => this.store.applyDeviceRecord(record, record, replay ? 'archive' : 'hydrate'));
  }
}
