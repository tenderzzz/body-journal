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
    { kind: 'body' },
    { kind: 'steps' },
    { kind: 'training', photos: [ref] },
    { analysis: {} },
    { body: { weightKg: 75 } },
  ])
    assert.equal(syncRecordSchema.safeParse({ ...wire, ...sensitive }).success, false);
  assert.equal(operationSchema.safeParse({ ...start.ops[0], version: 2 }).success, false);
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
      assert.equal((await phoneApp.rows()).find((v) => v.record.id === priv.id)!.replica, null);
      await assert.rejects(() => phoneApp.save({ ...priv, id: randomUUID() }, null, []));
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
    assert.equal(desktop.records().length, 1);
  },
);

test('selective shortcut migration preserves id, private photos, original order and pre-enrollment history', async (t) => {
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
  replicas.bind(archive);
  store.revise(legacy.id, { text: '第一次历史修改' }, 1);
  replicas.enroll(legacy.id, 2, [0, 2, 3, 6]);
  replicas.enroll(legacy.id, 2, [0, 1]);
  assert.equal(replicas.get(legacy.id)!.ops.length, 1);
  assert.equal(replicas.get(legacy.id)!.ops[0].record.photos.length, 4);
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
  assert.equal(replicas.get(legacy.id)!.ops.length, 3);
  const steps = store.importEnvelope({
    ...legacy,
    kind: 'note',
    id: 'legacy-steps',
    text: '全天步数：6000步',
    attachments: [],
  }).record;
  assert.ok(steps.analysis?.dailyActivity);
  assert.equal(replicas.info(steps.id).eligible, false);
  assert.throws(() => replicas.enroll(steps.id, steps.revision, []));
  assert.equal(replicas.get(steps.id), null);
  const body = store.importEnvelope({
    ...legacy,
    kind: 'body',
    id: 'legacy-body',
    body: { weightKg: 70 },
    attachments: [],
  }).record;
  assert.throws(() => replicas.enroll(body.id, body.revision, []));
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
    [future, '{"version":2}'],
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
  assert.equal(files.get(future), '{"version":2}');
  assert.equal(s.records().length, 2);
});
