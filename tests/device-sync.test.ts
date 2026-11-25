import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixture from './fixtures/device-sync.json';
import {
  addOperation,
  appendLocal,
  emptyReplica,
  heads,
  deliveryLabel,
  operationSchema,
  syncRecordSchema,
  type PhoneRecord,
  type Replica,
} from '../src/shared/device-sync';
import { exchange } from '../src/shared/device-exchange';
import { PhoneJournalModel, stamp, type JournalBridge } from '../src/mobile/journal';
import { NativeFolder } from '../electron/core/device-folder';
import { HealthStore } from '../electron/core/store';
import { FoodCatalog } from '../electron/core/nutrition';
import { calendarDay, journalDay } from '../src/shared/dates';

const { archive, mac, phone, id, text, occurredAt } = fixture;
const identity = { archive, device: phone };
const wire = syncRecordSchema.parse({
  id,
  kind: 'meal',
  text,
  occurredAt,
  timezone: 'Asia/Shanghai',
  photos: [],
  portions: [],
  deleted: false,
});
const png = Buffer.from(fixture.png, 'base64');
const ref = {
  mime: 'image/png' as const,
  hash: createHash('sha256').update(png).digest('hex'),
  bytes: png.length,
};
test('shared operations wait for parents, replay once, preserve competing deletes and require explicit resolution', () => {
  const start = appendLocal(emptyReplica(), wire, identity);
  const left = appendLocal(start, { ...wire, deleted: true }, identity);
  const right = appendLocal(start, { ...wire, text: '半碗' }, { archive, device: mac });
  assert.equal(addOperation(emptyReplica(), right.ops[1], archive), 'waiting');
  assert.equal(addOperation(start, start.ops[0], archive), start);
  assert.throws(() =>
    addOperation(start, { ...start.ops[0], record: { ...wire, text: '冒用编号' } }, archive),
  );
  const a = addOperation(left, right.ops[1], archive) as Replica,
    b = addOperation(right, left.ops[1], archive) as Replica;
  assert.deepEqual(heads(a), heads(b));
  assert.equal(heads(a)[0].record.deleted, true);
  assert.throws(() => appendLocal(a, wire, identity), /冲突/);
  const joined = appendLocal(
    a,
    { ...wire, text: '合并后保留半碗' },
    identity,
    heads(a).map((o) => o.id),
  );
  assert.deepEqual(heads(addOperation(b, joined.ops.at(-1)!, archive) as Replica), heads(joined));
  assert.throws(() => addOperation(start, { ...right.ops[1], record: { ...wire, deleted: true } }, archive));
  assert.throws(() => addOperation(start, right.ops[1], randomUUID()), /档案/);
  for (const sensitive of [
    { kind: 'body', body: { weightKg: -1 } },
    { kind: 'steps' },
    { kind: 'training', photos: [ref] },
    { analysis: {} },
    { body: { weightKg: 75 } },
  ])
    assert.equal(syncRecordSchema.safeParse({ ...wire, ...sensitive }).success, false);
  assert.equal(operationSchema.safeParse({ ...start.ops[0], version: 5 }).success, false);
  assert.equal(journalDay(occurredAt), '2026-11-19');
  assert.equal(journalDay(occurredAt.replace('03:59', '04:00')), '2026-11-20');
  assert.equal(calendarDay(occurredAt), '2026-11-20');
});

test(
  'native Apple transport and phone SQLite exchange synthetic meal, photos, portions, receipts and offline conflicts',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bodyjournal-sync-test-'));
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const bin = path.join(dir, 'folder-tool'),
      phoneBin = path.join(dir, 'phone-tool'),
      cache = path.join(tmpdir(), 'bodyjournal-swift-modules');
    for (const [target, inputs] of [
      [bin, ['native/SyncDirectory.swift', 'native/main.swift']],
      [phoneBin, ['native/SyncDirectory.swift', 'native/PhoneDatabase.swift', 'tests/native/main.swift']],
    ] as const)
      execFileSync('xcrun', ['swiftc', '-module-cache-path', cache, ...inputs, '-o', target]);
    const folder = path.join(dir, 'shared'),
      local = path.join(dir, 'phone'),
      vault = path.join(dir, 'mac');
    mkdirSync(folder);
    mkdirSync(path.join(local, 'photos'), { recursive: true });
    const code = 'BJ1.' + archive + '.' + randomBytes(32).toString('base64');
    const deskDir = new NativeFolder(bin, { folder, code, local: path.join(vault, 'attachments') });
    await deskDir.call('create');
    let connected = false;
    const bridge: JournalBridge = {
      async request<T>(args: Record<string, unknown>): Promise<T> {
        if (args.method === 'identity') return { archive, device: phone, enabled: connected } as T;
        return JSON.parse(
          execFileSync(phoneBin, [], {
            input: JSON.stringify({ local, folder, code, ...args }),
            encoding: 'utf8',
          }),
        );
      },
    };
    const first = new PhoneJournalModel(bridge);
    const r: PhoneRecord = { ...wire, photos: [ref] };
    writeFileSync(path.join(local, 'photos', ref.hash + '.png'), png);
    await first.save(r, null, [0]);
    await first.sync();
    assert.equal(readdirSync(folder).length, 1);
    const phoneApp = new PhoneJournalModel(bridge);
    assert.equal((await phoneApp.rows())[0].record.text, text);
    const desktop = new HealthStore(vault, new FoodCatalog([]), path.join(dir, 'inbox'), false);
    t.after(() => desktop.close());
    const replica = desktop.deviceRecords;
    replica.device = mac;
    replica.bind(archive);
    const deskSync = () => exchange({ archive, device: mac }, replica, deskDir);
    connected = true;
    assert.deepEqual((await phoneApp.sync())!.issues, []);
    const blob = path.join(folder, 'img-' + ref.hash),
      held = path.join(dir, 'held-photo');
    renameSync(blob, held);
    const partial = await deskSync();
    assert.equal(partial.waiting, 1);
    assert.equal(desktop.record(id).text, text);
    assert.equal(desktop.record(id).attachments.length, 0);
    assert.equal(
      readdirSync(folder).some((n) => n.startsWith('ack-')),
      false,
    );
    writeFileSync(blob, Buffer.alloc(30));
    assert.ok((await deskSync()).issues.length);
    assert.equal(desktop.record(id).attachments.length, 0);
    rmSync(blob);
    renameSync(held, blob);
    assert.deepEqual((await deskSync()).issues, []);
    assert.equal(desktop.record(id).attachments[0].sha256, ref.hash);
    await phoneApp.sync();
    assert.equal(deliveryLabel((await phoneApp.rows())[0].replica, phone), '另一台设备已接收');
    const current = desktop.record(id);
    const analyzed = desktop.applyAnalysis(
      id,
      { summary: '仅 Mac 的估算', questions: [], assumptions: [], ingredients: [] },
      'local',
      current.revision,
    );
    assert.equal(replica.get(id)!.ops.length, 1);
    desktop.applyAnalysis(
      id,
      {
        summary: '手动核对',
        questions: [],
        assumptions: [],
        ingredients: [
          {
            name: '米饭',
            foodId: null,
            grams: { low: 150, high: 150 },
            assumption: '一碗',
            consumedFraction: { low: 0.5, high: 0.5 },
          },
        ],
      },
      'local',
      analyzed.revision,
      true,
    );
    await deskSync();
    await phoneApp.sync();
    await deskSync();
    let row = (await phoneApp.rows())[0];
    assert.equal(row.record.portions[0].eaten!.low, 0.5);
    assert.deepEqual(row.record.photos, [ref]);
    assert.equal(desktop.records().length, 1);
    assert.equal(replica.get(id)!.ops.length, 2);
    assert.equal(deliveryLabel(replica.get(id), mac), '另一台设备已接收');
    for (const file of readdirSync(folder)) {
      const data = readFileSync(path.join(folder, file));
      assert.ok(
        !data.includes(Buffer.from(text)) &&
          !data.includes(png) &&
          !data.includes(Buffer.from('米饭')) &&
          !data.includes(Buffer.from(code)),
      );
    }
    await phoneApp.save({ ...row.record, deleted: true }, stamp(row));
    desktop.revise(id, { text: 'Mac 离线补记' }, desktop.record(id).revision);
    await phoneApp.sync();
    await deskSync();
    await phoneApp.sync();
    row = (await phoneApp.rows())[0];
    const tips = heads(row.replica!);
    assert.equal(tips.length, 2);
    assert.deepEqual(tips, heads(replica.get(id)!));
    await phoneApp.resolve(
      id,
      tips.map((o) => o.id),
      tips.find((o) => !o.record.deleted)!.id,
      '两端合并',
    );
    await phoneApp.sync();
    await deskSync();
    assert.equal(desktop.record(id).text, '两端合并');
    assert.equal(desktop.record(id).deleted, false);
    desktop.setRecordDeleted(id, true);
    await deskSync();
    await phoneApp.sync();
    assert.equal((await phoneApp.rows())[0].record.deleted, true);
    desktop.setRecordDeleted(id, false);
    await deskSync();
    await phoneApp.sync();
    assert.equal((await phoneApp.rows())[0].record.deleted, false);
    const count = replica.get(id)!.ops.length;
    await deskSync();
    await phoneApp.sync();
    assert.equal(replica.get(id)!.ops.length, count);
    for (const kind of ['body', 'steps'] as const) {
      const priv = {
        ...wire,
        kind,
        id: randomUUID(),
        ...(kind === 'steps' ? { steps: 0 } : { body: { bodyFatPercent: 20 } }),
      };
      await phoneApp.save(priv, null);
      assert.equal((await phoneApp.rows()).find((v) => v.record.id === priv.id)!.replica?.ops.length, 1);
      await phoneApp.sync();
      await deskSync();
      const received = desktop.record(priv.id);
      if (kind === 'body') assert.equal(received.body?.bodyFatPercent, 20);
      else {
        assert.equal(received.analysis?.dailyActivity?.steps, 0);
        assert.equal(received.status, 'ready');
        assert.equal(desktop.energy.day(calendarDay(occurredAt)).walking?.steps, 0);
        await assert.rejects(() => phoneApp.save({ ...priv, id: randomUUID() }, null), /当天已有步数/);
      }
    }
    const bad = new NativeFolder(bin, {
      folder,
      code: 'BJ1.' + archive + '.' + randomBytes(32).toString('base64'),
      local,
    });
    await assert.rejects(() => bad.list(), /不匹配/);
    const backup = path.join(dir, 'snapshot.bodyjournal');
    desktop.backup(backup);
    const backupOps = replica.get(id)!.ops.length;
    desktop.revise(id, { text: '备份之后的修改' }, desktop.record(id).revision);
    await deskSync();
    await phoneApp.sync();
    desktop.restoreFile(backup);
    assert.equal(replica.get(id)!.ops.length, backupOps);
    await deskSync();
    assert.equal(desktop.record(id).text, '备份之后的修改');
    // Recover into a clean phone profile with the same folder and key. No old device ID is reused.
    const restoredPhone = path.join(dir, 'clean-phone'),
      replacementId = randomUUID();
    const recoveryBridge: JournalBridge = {
      async request<T>(args: Record<string, unknown>): Promise<T> {
        if (args.method === 'identity') return { archive, device: replacementId, enabled: true } as T;
        return JSON.parse(
          execFileSync(phoneBin, [], {
            input: JSON.stringify({ local: restoredPhone, folder, code, ...args }),
            encoding: 'utf8',
          }),
        );
      },
    };
    const replacement = new PhoneJournalModel(recoveryBridge);
    assert.deepEqual((await replacement.sync())!.issues, []);
    const recovered = await replacement.rows();
    assert.equal(recovered.length, 3);
    recovered.sort((a, b) => Number(b.record.id === id) - Number(a.record.id === id));
    assert.equal(recovered[0].record.text, '备份之后的修改');
    assert.deepEqual(recovered[0].record.photos, [ref]);
    assert.deepEqual(readFileSync(path.join(restoredPhone, 'photos', ref.hash + '.png')), png);

    assert.equal(desktop.records().length, 3);
  },
);

test('automatic shortcut and historical backfill preserves IDs, selected photos, prior revisions and tombstones', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bodyjournal-select-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const inbox = path.join(dir, 'legacy-inbox');
  mkdirSync(inbox);
  const store = new HealthStore(path.join(dir, 'vault'), new FoodCatalog([]), inbox, false);
  t.after(() => store.close());
  const legacy = {
    version: 1,
    id: 'legacy-test-meal',
    timezone: 'Asia/Shanghai',
    occurredAt,
    kind: 'meal',
    text,
    attachments: Array.from({ length: 8 }, (_, i) => ({
      name: '合成样例-' + i + '.png',
      base64: fixture.png,
    })),
  };
  writeFileSync(path.join(inbox, 'meal.json'), JSON.stringify(legacy));
  assert.equal(store.scanInbox().imported, 1);
  const replicas = store.deviceRecords;
  replicas.device = mac;
  store.revise(legacy.id, { text: '第一次历史修改' }, 1);
  replicas.bind(archive);
  replicas.backfill();
  replicas.backfill();
  assert.equal(replicas.get(legacy.id)!.ops.length, 1);
  assert.deepEqual(replicas.get(legacy.id)!.ops[0].record.photos, []);
  replicas.enroll(legacy.id, 2, [0, 2, 3, 6]);
  replicas.enroll(legacy.id, 2, [0, 2, 3, 6]);
  assert.equal(replicas.get(legacy.id)!.ops.length, 2);
  assert.equal(heads(replicas.get(legacy.id)!)[0].record.photos.length, 4);
  assert.equal(store.scanInbox().imported, 0);
  assert.equal(store.records().length, 1);
  assert.equal(store.history(legacy.id).length, 1);
  await replicas.hydrate(legacy.id);
  assert.deepEqual(
    store.record(legacy.id).attachments.map((a) => a.name),
    legacy.attachments.map((a) => a.name),
  );
  store.revise(legacy.id, { text: '再改一次' }, store.record(legacy.id).revision);
  store.undoRecord(legacy.id);
  assert.equal(heads(replicas.get(legacy.id)!)[0].record.text, '第一次历史修改');
  assert.equal(replicas.get(legacy.id)!.ops.length, 4);
  const steps = store.importEnvelope({
    ...legacy,
    kind: 'note',
    id: 'legacy-steps',
    text: '全天步数：6000步',
    attachments: [],
  }).record;
  assert.ok(steps.analysis?.dailyActivity);
  assert.equal(replicas.get(steps.id)?.ops[0].record.text, steps.text);
  const body = store.importEnvelope({
    ...legacy,
    kind: 'body',
    id: 'legacy-body',
    body: { weightKg: 70 },
    attachments: [],
  }).record;
  assert.deepEqual(replicas.get(body.id)?.ops[0].record.body, { weightKg: 70 });
  store.setRecordDeleted(body.id, true);
  replicas.backfill();
  assert.equal(heads(replicas.get(body.id)!)[0].record.deleted, true);
});

test('eight late photos are checked individually, other records progress and future-version packets survive retries', async (t) => {
  const { crc32 } = await import('node:zlib');
  // Add valid PNG tEXt chunks to one synthetic pixel to give the eight images independent hashes.
  const images = Array.from({ length: 8 }, (_, i) => {
    const payload = Buffer.from('tEXtlabel\x00sample-' + i),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(payload.length - 4);
    crc.writeUInt32BE(crc32(payload));
    const data = Buffer.concat([png.subarray(0, -12), size, payload, crc, png.subarray(-12)]);
    return {
      data,
      photo: { ...ref, hash: createHash('sha256').update(data).digest('hex'), bytes: data.length },
    };
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'bodyjournal-late-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const s = new HealthStore(dir, new FoodCatalog([]), path.join(dir, 'inbox'), false);
  t.after(() => s.close());
  const records = s.deviceRecords;
  records.device = mac;
  records.bind(archive);
  const root = appendLocal(emptyReplica(), { ...wire, photos: images.map((i) => i.photo) }, identity);
  const change = appendLocal(root, { ...root.ops[0].record, text: '晚到的第二版' }, identity).ops[1];
  const other = appendLocal(emptyReplica(), { ...wire, id: 'another-meal' }, identity).ops[0],
    future = 'op-' + randomUUID();
  const files = new Map<string, string>([
    ['op-' + change.id, JSON.stringify(change)],
    ['op-' + other.id, JSON.stringify(other)],
    [future, '{"version":5}'],
  ]);
  let capacity = 3;
  const folder = {
    list: async () => [...files.keys()],
    read: async (name: string) => files.get(name)!,
    write: async (name: string, data: string) => {
      files.set(name, data);
    },
    photo: async (record: string, p: typeof ref) => {
      const i = images.findIndex((img) => img.photo.hash === p.hash);
      if (i >= capacity) throw Error('测试磁盘空间不足');
      const dest = path.join(dir, 'attachments', record);
      mkdirSync(dest, { recursive: true });
      writeFileSync(path.join(dest, p.hash + '.png'), images[i].data);
    },
  };
  const sync = () => exchange({ archive, device: mac }, records, folder);
  const first = await sync();
  assert.equal(first.waiting, 1);
  assert.ok(first.issues.some((s) => s.includes('升级')));
  assert.equal(s.records().length, 1);
  files.set('op-' + root.ops[0].id, JSON.stringify(root.ops[0]));
  const partial = await sync();
  assert.equal(s.record(id).text, '晚到的第二版');
  assert.equal(s.record(id).attachments.length, 3);
  assert.equal(records.get(id)!.receipts.length, 0);
  assert.ok(partial.issues.some((v) => v.includes('第 8 张')));
  assert.ok(files.has('ack-' + other.id + '-' + mac));
  capacity = 8;
  await sync();
  assert.deepEqual(
    s.record(id).attachments.map((a) => a.sha256),
    images.map((i) => i.photo.hash),
  );
  assert.equal(records.get(id)!.receipts.length, 2);
  assert.equal(files.get(future), '{"version":5}');
  assert.equal(s.records().length, 2);
});

test('upgrade seeds offline phone history once and resumes without sharing unselected photos or reviving trash', async () => {
  let paired = false;
  const rows = new Map<string, string>(),
    files = new Map<string, string>();
  const bridge: JournalBridge = {
    async request<T>(args: Record<string, unknown>) {
      const id = String(args.id),
        data = args.args as { command: string; name: string; text: string } | undefined;
      switch (args.method) {
        case 'personalSet': return {} as T;
        case 'personalGet': return {doc:null} as T;
        case 'identity':
          return { device: phone, archive: paired ? archive : undefined, enabled: paired } as T;
        case 'row':
          return { doc: rows.get(id) ?? null } as T;
        case 'rows':
          return { rows: [...rows.values()] } as T;
        case 'save':
          rows.set(id, String(args.doc));
          return {} as T;
        case 'folder':
          if (data?.command === 'list') return { names: [...files.keys()] } as T;
          if (data?.command === 'write') {
            files.set(data.name, data.text);
            return {} as T;
          }
      }
      throw Error('unexpected test bridge operation');
    },
  };
  const app = new PhoneJournalModel(bridge);
  await app.save({ ...wire, photos: [ref] }, null);
  await app.save({ ...wire, kind: 'steps', id: 'old-steps', steps: 3275, text: '' }, null);
  await app.save({ ...wire, id: 'old-trash', deleted: true }, null);
  assert.ok((await app.rows()).every((row) => !row.replica));
  paired = true;
  assert.deepEqual((await app.sync())?.issues, []);
  assert.equal(files.size, 2);
  const meal = (await app.rows()).find((r) => r.record.id === id)!;
  assert.deepEqual(heads(meal.replica!)[0].record.photos, []);
  assert.equal(meal.record.photos.length, 1);
  await app.save({ ...meal.record, text: '晚到的离线修改' }, stamp(meal));
  const restarted = new PhoneJournalModel(bridge);
  await restarted.sync();
  await restarted.sync();
  assert.equal(files.size, 3);
  assert.equal((await restarted.rows()).filter((r) => r.record.deleted && !r.replica).length, 1);
});

test('phone statistics match desktop estimates and atomically replace cached history after late months arrive', async (t) => {
  const { publishInsights } = await import('../electron/core/phone-insights');
  const { receiveInsights } = await import('../src/shared/phone-insights');
  const dir = mkdtempSync(path.join(tmpdir(), 'bodyjournal-insights-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HealthStore(dir, new FoodCatalog([]), path.join(dir, 'inbox'), false);
  t.after(() => store.close());
  const first = new Date('2026-11-21T02:30:00+08:00'),
    today = store.energy.today(first);
  const old = store.importEnvelope({
    version: 1,
    id: 'older-measurement',
    kind: 'body',
    occurredAt: '2025-02-01T10:00:00+08:00',
    timezone: 'Asia/Shanghai',
    text: '',
    body: { weightKg: 73 },
  }).record;
  store.energy.saveSteps(
    { date: '2026-11-21', steps: 0, timezone: 'Asia/Shanghai', coverage: 'partial' },
    first,
  );
  const data = new Map<string, string>(),
    puts: string[] = [];
  const folder = {
    list: async () => [...data.keys()],
    read: async (n: string) => {
      if (!data.has(n)) throw Error('waiting for iCloud');
      return data.get(n)!;
    },
    write: async (n: string, v: string) => {
      data.set(n, v);
      puts.push(n);
    },
    photo: async () => {},
  };
  const publish = (time: Date) =>
    publishInsights(store, { archive, device: mac }, folder, [...data.keys()], time);
  await publish(first);
  const cache = await receiveInsights(archive, [...data.keys()], folder, null);
  assert.ok(cache);
  assert.equal(cache.manifest.today, today);
  assert.equal(cache.manifest.civilToday, '2026-11-21');
  assert.equal(cache.days.find((d) => d.date === '2025-02-01')!.weight, 73);
  assert.equal(cache.days.find((d) => d.date === '2026-11-21')!.steps, 0);
  const selected = store.energy.overview(first);
  assert.deepEqual(cache.days.find((d) => d.date === today)!.intake, selected.days.at(-1)!.intake);
  assert.deepEqual(cache.days.find((d) => d.date === today)!.balance, selected.balance);
  const count = puts.length;
  await publish(new Date(+first + 1000));
  assert.equal(puts.length, count);
  store.revise(old.id, { body: { weightKg: 75 } }, old.revision);
  await publish(new Date(+first + 2000));
  assert.equal(puts.length, count + 2);
  const file = puts.at(-2)!,
    bytes = data.get(file)!;
  data.delete(file);
  await assert.rejects(receiveInsights(archive, [...data.keys()], folder, cache), /waiting/);
  assert.equal(cache.days.find((d) => d.date === '2025-02-01')!.weight, 73);
  data.set(file, bytes);
  const updated = await receiveInsights(archive, [...data.keys()], folder, cache);
  assert.equal(updated!.days.find((d) => d.date === '2025-02-01')!.weight, 75);
  assert.ok(!JSON.stringify(updated).includes(old.id));
  assert.equal(await receiveInsights(archive, [...data.keys()], folder, updated), updated);
});
