import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PhoneJournalModel, stamp, type JournalBridge } from '../src/mobile/journal';
import { PhoneAnalysis, healthRecord } from '../src/mobile/analysis';
import { PhoneAnalysisQueue } from '../src/mobile/analysis-queue';
import { localInsights } from '../src/mobile/local-insights';
import { detailOf } from '../src/shared/record-detail';
import { heads, type PhoneRecord } from '../src/shared/device-sync';
import { HealthStore } from '../electron/core/store';
import { FoodCatalog } from '../electron/core/nutrition';
import type { MobileModels } from '../src/mobile/models';
import { exchange } from '../src/shared/device-exchange';
import { migrationPreview, confirmMigration, PersonalSync } from '../electron/core/personal-library';
import { pullLibrary, validateLibrary } from '../src/shared/personal-library';
import { buildInsights } from '../electron/core/phone-insights';
const data = JSON.parse(readFileSync(new URL('../data/foods.json', import.meta.url), 'utf8'));
const rice = {
  name: '白米饭（熟）',
  foodId: 168878,
  grams: { low: 200, high: 200 },
  assumption: '给出的熟重',
};
const now = new Date(),
  at = now.toISOString();
function rig(archive: string, device = randomUUID()) {
  const rows = new Map<string, string>(),
    settings = new Map<string, string>();
  const bridge: JournalBridge = {
    async request<T>(v: Record<string, unknown>) {
      const id = String(v.id),
        key = String(v.name);
      const handle = () => {
        switch (v.method) {
          case 'identity':
            return { archive, device, enabled: true };
          case 'rows':
            return { rows: [...rows.values()] };
          case 'row':
            return { doc: rows.get(id) ?? null };
          case 'save': {
            assert.equal(v.previous, JSON.parse(rows.get(id) ?? '{"revision":0}').revision);
            rows.set(id, String(v.doc));
            return {};
          }
          case 'personalGet':
            return { doc: settings.get(key) ?? null };
          case 'personalSet':
            settings.set(key, String(v.doc));
            return {};
          case 'preview':
            return { url: 'data:image/png;base64,fixture' };
          case 'personalBackup':
            return {};
          default:
            throw Error(String(v.method));
        }
      };
      return handle() as T;
    },
  };
  return { phone: new PhoneJournalModel(bridge), device, archive, settings };
}
function record(text = '一碗熟米饭 200 g', kind: PhoneRecord['kind'] = 'meal'): PhoneRecord {
  const r: PhoneRecord = {
    id: randomUUID(),
    kind,
    text,
    occurredAt: at,
    timezone: 'Asia/Shanghai',
    deleted: false,
    portions: [],
    photos: [],
  };
  return { ...r, detail: detailOf(healthRecord(r)) };
}
const response = (value: unknown) => ({
  provider: 'chatgpt' as const,
  model: 'fixture',
  input: 12,
  output: 10,
  text: JSON.stringify(value),
});
const output = { summary: '熟米饭', ingredients: [rice], questions: [], assumptions: [] };
test('phone queue accepts more work while running, deduplicates, isolates failure and respects edits', async () => {
  const { phone } = rig(randomUUID());
  const rows = await Promise.all(['甲', '乙', '丙', '丁'].map((s) => phone.save(record(s), null)));
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const queue = new PhoneAnalysisQueue(phone, { async analyze(row, photos) {
    calls.push(row.record.text); assert.deepEqual(photos, []);
    if (row.record.text === '甲') await gate;
    if (row.record.text === '乙') throw Error('模拟服务错误');
    return row;
  } });
  const select = (row: typeof rows[number]) => ({ row, photos: [] });
  queue.setActive(true);
  await queue.enqueue(rows.slice(0, 2).map(select));
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls, ['甲']);
  await queue.enqueue([rows[0], rows[1], rows[2], rows[3]].map(select));
  await phone.save({ ...rows[2].record, text: '已修改' }, stamp(rows[2]));
  release();
  await queue.whenIdle();
  assert.deepEqual(calls, ['甲', '乙', '丁']);
  assert.deepEqual(queue.snapshot().jobs.map((j) => j.state), ['done', 'failed', 'failed', 'done']);
  assert.match(queue.snapshot().jobs[2].message!, /修改/);
});
test('reopening a phone queue resumes waiting work and leaves an interrupted request for explicit retry', async () => {
  const { phone } = rig(randomUUID());
  const a = await phone.save(record('甲'), null), b = await phone.save(record('乙'), null);
  const first = new PhoneAnalysisQueue(phone, {async analyze(row) { return row; }});
  await first.enqueue([{row:a,photos:[]},{row:b,photos:[]}]);
  const jobs = first.snapshot().jobs.map((j, i) => i === 0 ? {...j, state:'running' as const} : j);
  await phone.saveAnalysisQueue(jobs);
  const calls: string[] = [];
  const reopened = new PhoneAnalysisQueue(phone, { async analyze(row) { calls.push(row.record.text); return row; } });
  reopened.setActive(true);
  await reopened.start();
  await reopened.whenIdle();
  assert.deepEqual(calls, ['乙']);
  assert.equal(reopened.snapshot().jobs[0].state,'failed');
  await reopened.enqueue([{row:a,photos:[]}]); await reopened.whenIdle();
  assert.deepEqual(calls,['乙','甲']);
});
function remote() {
  const files = new Map<string, string>();
  return {
    files,
    folder: {
      list: async () => [...files.keys()],
      read: async (n: string) => {
        if (!files.has(n)) throw Error('not arrived');
        return files.get(n)!;
      },
      write: async (n: string, text: string) => {
        files.set(n, text);
      },
      photo: async () => {},
    },
  };
}
test('offline phone portion updates daily energy and round-trips the saved meal, late response, followup and training', async (t) => {
  const archive = randomUUID(),
    p = rig(archive),
    r = record(),
    first = await p.phone.save(r, null);
  let calls = 0;
  let finish!: (v: ReturnType<typeof response>) => void;
  const service = new PhoneAnalysis(p.phone, {
    infer: async () => {
      calls++;
      return new Promise<ReturnType<typeof response>>((done) => (finish = done));
    },
  } as unknown as MobileModels);
  const analyzed = service.analyze(first, []);
  assert.equal(service.analyze(first, []), analyzed);
  await new Promise((done) => setImmediate(done));
  finish(response(output));
  const full = await analyzed;
  const energy = full.record.detail!.analysis!.macros!.kcal.low;
  assert.ok(energy > 150);
  const half = await service.correct(full, { food: 0, fraction: 0.5 });
  assert.ok(Math.abs(half.record.detail!.analysis!.macros!.kcal.low * 2 - energy) <= 1);
  const view = localInsights([half], null, null, { archive, device: p.device, enabled: true }, now)!;
  assert.equal(
    view.days.find((d) => d.date === view.manifest.today)?.intake?.low,
    half.record.detail!.analysis!.macros!.kcal.low,
  );
  assert.equal(calls, 1);
  const { folder } = remote(),
    tmp = mkdtempSync(path.join(tmpdir(), 'bodyjournal-personal-test-'));
  const mac = new HealthStore(tmp, new FoodCatalog(data.foods), path.join(tmp, 'inbox'), false);
  t.after(() => {
    mac.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const macId = { archive, device: mac.deviceRecords.device };
  mac.deviceRecords.bind(archive);
  await exchange(p, p.phone, folder);
  assert.deepEqual((await exchange(macId, mac.deviceRecords, folder)).issues, []);
  const saved = mac.record(r.id);
  assert.equal(mac.records().length, 1);
  assert.deepEqual(saved.analysis?.macros, half.record.detail!.analysis!.macros);
  assert.equal(saved.analysisPending, false);
  const restored = new PhoneJournalModel((p.phone as unknown as { bridge: JournalBridge }).bridge);
  assert.equal(
    (await restored.rows())[0].record.detail?.analysis?.ingredients?.[0].consumedFraction?.low,
    0.5,
  );
  const late = service.analyze(half, []);
  await new Promise((done) => setImmediate(done));
  const follow = await service.followup(half, '这餐只有半碗');
  finish(response(output));
  await assert.rejects(late, /历史/);
  assert.equal((await p.phone.attempts()).length, 1);
  assert.equal((await p.phone.rows())[0].record.detail?.followups[0].answer, '这餐只有半碗');
  const training = await p.phone.save(record('杠铃深蹲 40kg 3组 每组8次', 'training'), null);
  const tr = service.analyze(training, []);
  await new Promise((done) => setImmediate(done));
  finish(
    response({
      summary: '训练',
      sets: [{ exercise: '杠铃深蹲', kg: 40, reps: 8, sets: 3, loadBasis: 'total', confirmed: true }],
    }),
  );
  const result = await tr,
    sets = result.record.detail!.analysis!.sets!;
  const fixed = await service.correct(result, {
    sets: sets.map((s) => ({ ...s, reps: 6, loadBasis: 'total', basisSource: 'manual' })),
  });
  assert.equal(fixed.record.detail?.analysis?.sets?.[0].basisSource, 'manual');
  await exchange(p, p.phone, folder);
  await exchange(macId, mac.deviceRecords, folder);
  assert.deepEqual(
    mac.record(training.record.id).analysis?.sets,
    JSON.parse(JSON.stringify(fixed.record.detail?.analysis?.sets)),
  );
  assert.equal(mac.record(r.id).followups?.at(-1)?.answer, follow.record.detail?.followups.at(-1)?.answer);
  const prior = mac.record(r.id);
  mac.applyAnalysis(
    r.id,
    {
      ...prior.analysis,
      ingredients: prior.analysis!.ingredients!.map((i) => ({
        ...i,
        consumedFraction: { low: 1, high: 1 },
      })),
    },
    'local',
    prior.revision,
    true,
  );
  await exchange(macId, mac.deviceRecords, folder);
  await exchange(p, p.phone, folder);
  assert.equal(
    (await p.phone.rows()).find((x) => x.record.id === r.id)?.record.detail?.analysis?.ingredients?.[0]
      .consumedFraction?.low,
    1,
  );
  const copy = await p.phone.save(record('和上次一样，米饭半份'), null),
    job = service.analyze(copy, []);
  await new Promise((done) => setImmediate(done));
  finish(response({ copyFromRecordId: r.id }));
  const copied = await job;
  assert.equal(copied.record.detail?.analysis?.copiedFrom?.recordId, r.id);
  assert.equal(copied.record.detail?.analysis?.ingredients?.[0].consumedFraction?.low, 0.5);
});
test('migration requires two local backups and consent, chunks recover after interruption and a clean phone matches Mac energy', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'bodyjournal-library-test-'));
  const store = new HealthStore(root, new FoodCatalog(data.foods), path.join(root, 'inbox'), false);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const archive = randomUUID(),
    pc = { archive, device: store.deviceRecords.device };
  store.deviceRecords.bind(archive);
  const r = store.importEnvelope({
    version: 1,
    id: randomUUID(),
    kind: 'meal',
    text: '熟米饭 200g',
    timezone: 'Asia/Shanghai',
    occurredAt: at,
  }).record;
  store.applyAnalysis(r.id, output, 'chatgpt', r.revision);
  const { files, folder } = remote(),
    service = new PersonalSync(store),
    fresh = rig(archive);
  await service.exchange(pc, folder, []);
  assert.equal(files.size, 0);
  const preview = migrationPreview(store);
  assert.equal(preview.records, 1);
  assert.equal(preview.analyses, 1);
  assert.throws(() => confirmMigration(store, randomUUID()));
  confirmMigration(store, preview.ticket);
  await assert.rejects(service.exchange(pc, folder, []), /iPhone/);
  assert.equal(files.size, 0);
  files.set(
    'ready-' + fresh.device,
    JSON.stringify({ version: 1, device: fresh.device, archive, role: 'iphone', backup: true }),
  );
  await service.exchange(pc, folder, [...files.keys()]);
  await exchange(pc, store.deviceRecords, folder);
  const last = await pullLibrary(archive, folder, [...files.keys()]);
  assert.ok(last);
  const packet = 'part-' + last.manifest.parts[0],
    part = files.get(packet)!;
  files.delete(packet);
  await assert.rejects(pullLibrary(archive, folder, [...files.keys()]));
  files.set(packet, part);
  const again = (await pullLibrary(archive, folder, [...files.keys()]))!;
  assert.equal(createHash('sha256').update(again.text).digest('hex'), again.manifest.hash);
  const lib = validateLibrary(JSON.parse(again.text));
  assert.ok(lib.revisions.length);
  await exchange(fresh, fresh.phone, folder);
  const rows = await fresh.phone.rows();
  assert.equal(rows.length, 1);
  assert.equal(heads(rows[0].replica!)[0].record.id, r.id);
  const phone = localInsights(rows, lib, null, { ...fresh, enabled: true }, now)!;
  assert.deepEqual(phone.days, [...buildInsights(store, now).months.values()].flat());
  const replacement = new HealthStore(path.join(root, 'replacement'), new FoodCatalog(data.foods), path.join(root, 'other-inbox'));
  t.after(() => replacement.close());
  assert.equal(replacement.getSettings().goals.goal, '');
  assert.deepEqual(replacement.memories(), []);
  replacement.migrateMemoryTopics();
  replacement.deviceRecords.bind(archive);
  replacement.setConfig('personalRestoreReader', true);
  const other = { archive, device: replacement.deviceRecords.device };
  const filesOnDisk = [...files.keys()];
  const receivingStore = replacement.deviceRecords.forExchange(filesOnDisk);
  await exchange(other, receivingStore, folder, filesOnDisk);
  await new PersonalSync(replacement).exchange(other, folder, filesOnDisk);
  const revisionHistory = (s: HealthStore) =>
    s.db.prepare('SELECT entity,id,at,doc FROM revisions ORDER BY seq').all()
      .map((r) => ({ ...r, doc: JSON.parse(String(r.doc)) }));
  assert.deepEqual(revisionHistory(replacement), revisionHistory(store));
  assert.equal(replacement.record(r.id).revision, store.record(r.id).revision);
  assert.equal(replacement.record(r.id).updatedAt, store.record(r.id).updatedAt);
  assert.deepEqual(replacement.memories().map((m) => m.id).sort(), store.memories().map((m) => m.id).sort());
});
