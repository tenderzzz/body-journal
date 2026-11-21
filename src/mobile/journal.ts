import { registerPlugin } from '@capacitor/core';
import { calendarDay } from '../shared/dates';
import {
  addOperation,
  appendLocal,
  emptyReplica,
  heads,
  syncRecordSchema,
  type Delivery,
  type Operation,
  type PhoneRecord,
  type PhotoRef,
  type Replica,
  type SyncSettings,
  type SyncReport,
} from '../shared/device-sync';
import { exchange, type ReplicaStore, type ExchangeFolder } from '../shared/device-exchange';

export type Row = { revision: number; record: PhoneRecord; replica: Replica | null };
export type PhoneIdentity = Pick<SyncSettings, 'archive' | 'enabled' | 'device' | 'folder'>;
export interface JournalBridge {
  request<T>(args: Record<string, unknown>): Promise<T>;
}
const native = registerPlugin<JournalBridge>('Journal');
const stale = () => Error('这条记录已更新，请重新打开后保存。');
export const stamp = (row: Row) =>
  JSON.stringify([row.record, row.replica ? heads(row.replica).map((o) => o.id) : []]);
function projection(record: PhoneRecord, photos: PhotoRef[]) {
  const { id, kind, text, occurredAt, timezone, deleted, portions } = record;
  return syncRecordSchema.parse({ id, kind, text, occurredAt, timezone, deleted, portions, photos });
}
function selectPhotos(record: PhoneRecord, indices: number[]) {
  if (indices.some((i) => !Number.isInteger(i) || !record.photos[i]))
    throw Error('请重新选择需要同步的照片。');
  return record.kind === 'meal' ? record.photos.filter((_, i) => indices.includes(i)) : [];
}
export function validatePhoneRecord(r: PhoneRecord) {
  if (!r.text.trim() && !r.photos.length && !Object.values(r.body ?? {}).length && r.steps === undefined)
    throw Error('请填写记录内容。');
  if (r.text.length > 100000 || r.photos.length > 8 || !Number.isFinite(Date.parse(r.occurredAt)))
    throw Error('请核对记录长度、时间和照片张数。');
  if (r.kind === 'steps' && (!Number.isInteger(r.steps) || r.steps! < 0 || r.steps! > 100000))
    throw Error('请填写 0 到 100000 之间的整数步数。');
  const { weightKg, waistCm, bodyFatPercent } = r.body ?? {};
  if (
    (weightKg !== undefined && !(weightKg >= 10 && weightKg <= 500)) ||
    (waistCm !== undefined && !(waistCm >= 20 && waistCm <= 300)) ||
    (bodyFatPercent !== undefined && !(bodyFatPercent > 0 && bodyFatPercent < 100))
  )
    throw Error('请核对体重、腰围和体脂率的数值。');
}
export class PhoneJournalModel implements ReplicaStore {
  private serial: Promise<unknown> = Promise.resolve();
  private running?: Promise<SyncReport | undefined>;
  private rerun = false;
  report?: SyncReport;
  constructor(private bridge: JournalBridge = native) {}
  call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.bridge.request<T>({ method, ...args });
  }
  identity() {
    return this.call<PhoneIdentity>('identity');
  }
  async rows(): Promise<Row[]> {
    return (await this.call<{ rows: string[] }>('rows')).rows.map((s) => JSON.parse(s));
  }
  async replicas() {
    return (await this.rows()).flatMap((row) => (row.replica ? [row.replica] : []));
  }
  private async row(id: string): Promise<Row | null> {
    const { doc } = await this.call<{ doc: string | null }>('row', { id });
    return doc ? JSON.parse(doc) : null;
  }
  private locked<T>(action: () => Promise<T>) {
    const next = this.serial.then(action);
    this.serial = next.catch(() => {});
    return next;
  }
  private async write(record: PhoneRecord, replica: Replica | null, prior: Row | null) {
    const next = { record, replica, revision: (prior?.revision ?? 0) + 1 };
    await this.call('save', { id: record.id, previous: prior?.revision ?? 0, doc: JSON.stringify(next) });
    return next;
  }
  save(record: PhoneRecord, expected: string | null, enroll?: number[]) {
    return this.locked(async () => {
      validatePhoneRecord(record);
      const prior = await this.row(record.id);
      if ((prior ? stamp(prior) : null) !== expected) throw stale();
      if (record.kind === 'steps' && !record.deleted) {
        const day = calendarDay(record.occurredAt, record.timezone);
        if (
          (await this.rows()).some(
            (r) =>
              r.record.id !== record.id &&
              r.record.kind === 'steps' &&
              !r.record.deleted &&
              calendarDay(r.record.occurredAt, r.record.timezone) === day,
          )
        )
          throw Error('当天已有步数，请打开原记录修改。');
      }
      let replica = prior?.replica ?? null;
      if (replica || enroll) {
        const { archive, device } = await this.identity();
        if (!archive) throw Error('请先完成档案配对。');
        const photos = replica ? heads(replica)[0].record.photos : selectPhotos(record, enroll!);
        replica = appendLocal(replica ?? emptyReplica(), projection(record, photos), { archive, device });
      }
      return this.write(record, replica, prior);
    });
  }
  private fromReplica(prior: Row | null, replica: Replica): PhoneRecord {
    const incoming = heads(replica)[0].record;
    if (
      prior?.replica &&
      JSON.stringify(heads(prior.replica)[0].record.photos) === JSON.stringify(incoming.photos)
    )
      return { ...incoming, photos: prior.record.photos };
    const selected = new Set(
      [...(prior?.replica ? heads(prior.replica)[0].record.photos : []), ...incoming.photos].map(
        (p) => p.hash,
      ),
    );
    const originals = prior?.record.photos ?? [];
    const photos = originals.some((p) => !selected.has(p.hash))
      ? [...originals, ...incoming.photos.filter((p) => !originals.some((o) => o.hash === p.hash))]
      : incoming.photos;
    return { ...incoming, photos };
  }
  accept(op: Operation) {
    return this.locked(async () => {
      const prior = await this.row(op.record.id),
        state = prior?.replica ?? emptyReplica();
      const next = addOperation(state, op, (await this.identity()).archive ?? '');
      if (next === 'waiting') return 'waiting' as const;
      if (next === state) return 'duplicate' as const;
      if (prior && !prior.replica) throw Error('本机已有同编号记录，请核对并选入后处理冲突。');
      await this.write(this.fromReplica(prior, next), next, prior);
      return 'added' as const;
    });
  }
  resolve(id: string, parents: string[], choice: string, text?: string) {
    return this.locked(async () => {
      const prior = await this.row(id),
        state = prior?.replica;
      const selected = state && heads(state).find((o) => o.id === choice);
      const { archive, device } = await this.identity();
      if (!prior || !state || !selected || !archive) throw stale();
      const next = appendLocal(
        state,
        { ...selected.record, text: text ?? selected.record.text },
        { archive, device },
        parents,
      );
      return this.write(this.fromReplica(prior, next), next, prior);
    });
  }
  async mark(id: string, op: string, status: Delivery) {
    await this.locked(async () => {
      const prior = await this.row(id),
        state = prior?.replica;
      if (prior && state && !state[status].includes(op))
        await this.write(prior.record, { ...state, [status]: [...state[status], op] }, prior);
    });
  }
  async hydrate() {
    /* Verified bytes already occupy the photo's content-addressed local path. */
  }
  async sync() {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        const id = await this.identity();
        if (!id.enabled || !id.archive) return this.report;
        const command = <T>(name: string, args: Record<string, unknown> = {}) =>
          this.call<T>('folder', { args: { command: name, ...args } });
        const folder: ExchangeFolder = {
          list: async () => (await command<{ names: string[] }>('list')).names,
          read: async (name) => (await command<{ text: string }>('read', { name })).text,
          write: async (name, text) => {
            await command('write', { name, text });
          },
          photo: async (record, photo, upload) => {
            await command('photo', { record, photo, upload });
          },
        };
        try {
          this.report = await exchange({ archive: id.archive, device: id.device }, this, folder);
        } catch (e) {
          this.report = {
            at: new Date().toISOString(),
            changed: 0,
            waiting: 0,
            issues: [
              (e instanceof Error ? e.message : String(e)) + ' 请检查共享文件夹授权和剩余空间后重试。',
            ],
          };
        }
      } while (this.rerun);
      return this.report;
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
