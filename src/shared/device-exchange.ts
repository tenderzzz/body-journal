import {
  operationSchema,
  type Operation,
  type PhotoRef,
  type Replica,
  type Delivery,
  type Identity,
  type SyncReport,
} from './device-sync';

export interface ReplicaStore {
  replicas(): Promise<Replica[]>;
  accept(op: Operation): Promise<'waiting' | 'duplicate' | 'added'>;
  mark(record: string, op: string, status: Delivery): Promise<void>;
  hydrate(record: string, photos: PhotoRef[]): Promise<void>;
}
export interface ExchangeFolder {
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  write(name: string, text: string): Promise<void>;
  photo(record: string, ref: PhotoRef, upload: boolean): Promise<void>;
}
const guid = '[a-f0-9-]{36}';
const operationFile = new RegExp('^op-(' + guid + ')$');
const receiptFile = new RegExp('^ack-(' + guid + ')-(' + guid + ')$');
export async function exchange(
  id: Identity,
  store: ReplicaStore,
  folder: ExchangeFolder,
  listing?: string[],
): Promise<SyncReport> {
  const report: SyncReport = { at: new Date().toISOString(), changed: 0, waiting: 0, issues: [] };
  const issues = new Set<string>();
  const issue = (e: unknown) => issues.add(e instanceof Error ? e.message : String(e));
  const files = listing ?? (await folder.list());
  let replicas = await store.replicas();
  const known = new Map(replicas.flatMap((r) => r.ops.map((op) => [op.id, op] as const)));
  const pending: Operation[] = [];
  for (const file of files) {
    const match = operationFile.exec(file);
    if (!match || known.has(match[1])) continue;
    try {
      const input = JSON.parse(await folder.read(file));
      if (input.version !== 1 && input.version !== 2 && input.version !== 3 && input.version !== 4) throw Error('发现新版变更，升级两端后点「立即同步」。');
      const op = operationSchema.parse(input);
      if (op.id !== match[1] || op.archive !== id.archive) throw Error('共享变更与文件编号或档案不一致。');
      pending.push(op);
    } catch (e) {
      issue(e);
    }
  }
  // An iCloud listing has no causal ordering. A missing parent stays on disk for the next scan.
  let remaining = pending;
  while (remaining.length) {
    const next: Operation[] = [];
    for (const op of remaining) {
      try {
        const result = await store.accept(op);
        if (result === 'waiting') next.push(op);
        else {
          known.set(op.id, op);
          if (result === 'added') report.changed++;
        }
      } catch (e) {
        issue(e);
      }
    }
    if (next.length === remaining.length) {
      report.waiting += next.length;
      break;
    }
    remaining = next;
  }
  replicas = await store.replicas();
  for (const r of replicas) {
    for (const op of r.ops) {
      const own = op.device === id.device;
      if (own ? r.written.includes(op.id) : r.receipts.includes(op.id)) continue;
      try {
        // Publish text first. The receiver acknowledges only after all image bytes verify locally.
        if (own) await folder.write('op-' + op.id, JSON.stringify(op));
        let complete = true;
        const arrived: PhotoRef[] = [];
        for (const [index, p] of op.record.photos.entries()) {
          try {
            await folder.photo(op.record.id, p, own);
            arrived.push(p);
          } catch (e) {
            complete = false;
            issue('第 ' + (index + 1) + ' 张照片：' + (e instanceof Error ? e.message : String(e)));
          }
        }
        if (arrived.length) await store.hydrate(op.record.id, arrived);
        if (!complete) {
          report.waiting++;
          continue;
        }
        if (!own) {
          await folder.write(
            'ack-' + op.id + '-' + id.device,
            JSON.stringify({ version: 1, archive: id.archive, op: op.id, device: id.device }),
          );
        }
        await store.mark(op.record.id, op.id, own ? 'written' : 'receipts');
      } catch (e) {
        issue(e);
      }
    }
  }
  for (const file of files) {
    const match = receiptFile.exec(file);
    if (!match || match[2] === id.device) continue;
    const op = known.get(match[1]);
    if (!op || op.device !== id.device) continue;
    if (replicas.find((r) => r.ops.some((v) => v.id === op.id))?.acknowledged.includes(op.id)) continue;
    try {
      const ack = JSON.parse(await folder.read(file));
      if (ack.version !== 1 || ack.archive !== id.archive || ack.op !== op.id || ack.device !== match[2])
        throw Error('回执编号不一致，请重新同步。');
      await store.mark(op.record.id, op.id, 'acknowledged');
    } catch (e) {
      issue(e);
    }
  }
  report.issues = [...issues].slice(0, 30);
  return report;
}
