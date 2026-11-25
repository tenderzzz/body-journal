import {
  exchangeHistory,
  pullLibrary,
  validateLibrary,
  type HistoryResult,
  type PersonalLibrary,
} from '../shared/personal-library';
import { registerPlugin } from '@capacitor/core';
import { receiveInsights, type PhoneInsights } from '../shared/phone-insights';
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
export function stepsForDay(rows: Row[], day: string, excluding?: string) {
  return rows.find(
    ({ record }) =>
      record.kind === 'steps' &&
      !record.deleted &&
      record.id !== excluding &&
      calendarDay(record.occurredAt, record.timezone) === day,
  );
}
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
  return syncRecordSchema.parse({
    id,
    kind,
    text,
    occurredAt,
    timezone,
    deleted,
    portions,
    photos,
    detail: record.detail,
    ...(kind === 'body' && record.body ? { body: record.body } : {}),
    ...(kind === 'steps' ? { steps: record.steps, stepCoverage: record.stepCoverage ?? 'partial' } : {}),
  });
}
function selectPhotos(record: PhoneRecord, indices: number[]) {
  if (indices.some((i) => !Number.isInteger(i) || !record.photos[i]))
    throw Error('请重新选择需要同步的照片。');
  return record.kind === 'meal' || record.detail ? record.photos.filter((_, i) => indices.includes(i)) : [];
}
export function validatePhoneRecord(r: PhoneRecord, existingEmpty = false) {
  if (
    !existingEmpty &&
    !r.text.trim() &&
    !r.photos.length &&
    !Object.values(r.body ?? {}).length &&
    r.steps === undefined
  )
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
  async insights(): Promise<PhoneInsights | null> {
    const { doc } = await this.call<{ doc: string | null }>('insights');
    return doc ? JSON.parse(doc) : null;
  }
  private cachedLibrary?: PersonalLibrary | null;
  private getPersonal<T>(name: string): Promise<T | null> {
    return this.call<{ doc: string | null }>('personalGet', { name }).then(({ doc }) =>
      doc ? JSON.parse(doc) : null,
    );
  }
  private setPersonal(name: string, value: unknown) {
    return this.call('personalSet', { name, doc: JSON.stringify(value) });
  }
  async library(): Promise<PersonalLibrary | null> {
    if (this.cachedLibrary === undefined)
      this.cachedLibrary = await this.getPersonal<PersonalLibrary>('library');
    return this.cachedLibrary;
  }
  attempts() {
    return this.getPersonal<HistoryResult[]>('attempts').then((v) => v ?? []);
  }
  keepAttempt(value: HistoryResult) {
    return this.locked(async () => {
      const rows = await this.attempts();
      if (!rows.some((r) => r.id === value.id)) await this.setPersonal('attempts', [...rows, value]);
    });
  }
  migrationOn() {
    return this.getPersonal<boolean>('migration');
  }
  async migrationPreview() {
    await this.call('personalBackup');
    const id = await this.identity();
    const rows = await this.rows(),
      refs = new Set(rows.flatMap((r) => r.record.photos.map((p) => p.hash)));
    return {
      records: rows.length,
      photos: refs.size,
      pending: rows.filter(
        (r) =>
          !r.replica ||
          r.replica.ops.some((o) => !r.replica!.written.includes(o.id) && o.device === id.device),
      ).length,
      confirmed: !!(await this.getPersonal('migration')),
    };
  }
  async progress() {
    const phase = await this.getPersonal<{ phase: string; at: string; files?: number; issues?: string[] }>(
      'lastSync',
    );
    const cursor = await this.getPersonal<{ next: number }>('migrationCursor');
    const library = await this.library();
    return {
      phase,
      photos: cursor?.next ?? 0,
      total: library?.photos.length ?? 0,
      revisions: library?.revisions.length ?? 0,
    };
  }
  async confirmMigration() {
    const id = await this.identity();
    if (!id.archive || !id.enabled) throw Error('请先连接原共享目录。');
    await this.call('personalBackup');
    await this.setPersonal('migration', true);
    return this.sync();
  }
  private async personalSync(
    id: { archive: string; device: string },
    folder: ExchangeFolder,
    files: string[],
  ) {
    const oldHash = await this.getPersonal<string>('libraryHash');
    await this.setPersonal('lastSync', {
      phase: '核对历史档案',
      files: files.length,
      at: new Date().toISOString(),
    });
    const downloaded = await pullLibrary(id.archive, folder, files, oldHash ?? undefined);
    let library = await this.library();
    if (downloaded) {
      const checked = await this.call<{ hex: string }>('modelDigest', { text: downloaded.text });
      if (checked.hex !== downloaded.manifest.hash) throw Error('完整档案校验失败，已保留上次副本。');
      library = validateLibrary(JSON.parse(downloaded.text));
      await this.call('personalBackup');
      await this.setPersonal('library', library);
      await this.setPersonal('libraryHash', downloaded.manifest.hash);
      this.cachedLibrary = library;
    }
    await exchangeHistory(id, folder, files, await this.attempts(), (v) => this.keepAttempt(v));
    const consent = await this.getPersonal<boolean>('migration');
    if (consent && !files.includes('ready-' + id.device))
      await folder.write(
        'ready-' + id.device,
        JSON.stringify({ version: 1, ...id, role: 'iphone', backup: true }),
      );
    if (!library) return;
    if (consent) {
      for (const row of await this.rows()) {
        const selected = row.replica ? heads(row.replica) : [];
        if (selected.length !== 1 || !row.record.detail) continue;
        const shared = selected[0].record.photos;
        if (row.record.photos.some((p) => !shared.some((s) => s.hash === p.hash))) {
          await this.save(
            row.record,
            stamp(row),
            row.record.photos.map((_, i) => i),
          );
          this.rerun = true;
        }
      }
    }
    const key = downloaded?.manifest.hash ?? oldHash;
    const progress = await this.getPersonal<{ hash: string; next: number }>('migrationCursor');
    let index = progress?.hash === key ? (progress?.next ?? 0) : 0;
    while (index < library.photos.length) {
      const { record, photo } = library.photos[index];
      await folder.photo(record, photo, false);
      index++;
      if (index % 12 === 0 || index === library.photos.length)
        await this.setPersonal('migrationCursor', { hash: key, next: index });
    }
  }
  private backfill(archive: string, device: string) {
    return this.locked(async () => {
      for (const row of await this.rows()) {
        if (row.replica || row.record.deleted) continue;
        const next = appendLocal(emptyReplica(), projection(row.record, []), { archive, device });
        await this.write(row.record, next, row);
      }
    });
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
      const prior = await this.row(record.id);
      if (
        prior?.record.detail &&
        record.detail &&
        prior.record.detail.revision === record.detail.revision &&
        (prior.record.text !== record.text ||
          prior.record.occurredAt !== record.occurredAt ||
          prior.record.deleted !== record.deleted ||
          JSON.stringify(prior.record.body) !== JSON.stringify(record.body))
      ) {
        const content = prior.record.text !== record.text;
        record = {
          ...record,
          detail: {
            ...record.detail,
            revision: record.detail.revision + 1,
            updatedAt: new Date().toISOString(),
            ...(content
              ? {
                  pending: true,
                  status: 'pending',
                  analysis: record.detail.analysis ? { ...record.detail.analysis, macros: null } : null,
                }
              : {}),
          },
        };
      }
      validatePhoneRecord(record, !!prior && !prior.record.text.trim() && !prior.record.photos.length);
      if ((prior ? stamp(prior) : null) !== expected) throw stale();
      if (record.kind === 'steps' && !record.deleted) {
        const day = calendarDay(record.occurredAt, record.timezone);
        if (stepsForDay(await this.rows(), day, record.id)) throw Error('当天已有步数，请打开原记录修改。');
      }
      let replica = prior?.replica ?? null;
      const { archive, device } = await this.identity();
      if (archive && (replica || !record.deleted)) {
        const previous = replica ? heads(replica)[0].record.photos : [];
        const additions = selectPhotos(record, enroll ?? []);
        const photos = [
          ...previous,
          ...additions.filter((p) => !previous.some((old) => old.hash === p.hash)),
        ];
        replica = appendLocal(replica ?? emptyReplica(), projection(record, photos), { archive, device });
      } else if (enroll?.length) throw Error('请先完成档案配对。');
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
          await this.backfill(id.archive, id.device);
          await this.setPersonal('lastSync', { phase: '读取共享目录', at: new Date().toISOString() });
          const files = await folder.list();
          await this.setPersonal('lastSync', {
            phase: '接收记录及统计',
            files: files.length,
            at: new Date().toISOString(),
          });
          let viewError = '';
          try {
            if (files.some((f) => f.startsWith('overview-'))) {
              const prior = await this.insights();
              const view = await receiveInsights(id.archive, files, folder, prior);
              if (view && view !== prior)
                await this.call('saveInsights', { archive: id.archive, doc: JSON.stringify(view) });
            }
          } catch (e) {
            viewError = '能量和趋势等待更新：' + (e instanceof Error ? e.message : String(e));
          }
          this.report = await exchange({ archive: id.archive, device: id.device }, this, folder, files);
          if (viewError) this.report.issues.push(viewError);
          try {
            await this.personalSync({ archive: id.archive, device: id.device }, folder, files);
          } catch (e) {
            this.report.issues.push('历史档案等待同步：' + (e as Error).message);
          }
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
        await this.setPersonal('lastSync', {
          phase: this.report?.issues.length ? '等待同步重试' : '本次同步已完成',
          at: new Date().toISOString(),
          issues: this.report?.issues ?? [],
        });
      } while (this.rerun);
      return this.report;
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
