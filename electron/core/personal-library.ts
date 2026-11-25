import { createHash, randomUUID } from 'node:crypto';
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { HealthStore } from './store';
import type { PersonalLibrary, LibraryRevision, HistoryResult } from '../../src/shared/personal-library';
import {
  validateLibrary,
  exchangeHistory,
  publishLibrary,
  pullLibrary,
} from '../../src/shared/personal-library';
import { heads, photoSchema, type Identity } from '../../src/shared/device-sync';
import type { ExchangeFolder } from '../../src/shared/device-exchange';
import type { HealthRecord } from '../../src/shared/types';
export const hashText = async (text: string) => createHash('sha256').update(text).digest('hex');
function revisions(store: HealthStore): LibraryRevision[] {
  return store.db
    .prepare("SELECT entity,id,at,doc FROM revisions WHERE entity IN ('record','memory') ORDER BY seq")
    .all()
    .map((r) => ({
      entity: r.entity as LibraryRevision['entity'],
      id: String(r.id),
      at: String(r.at),
      doc: JSON.parse(String(r.doc)),
    }));
}
function libraryOf(store: HealthStore): PersonalLibrary {
  const prior = revisions(store),
    photos = new Map<string, PersonalLibrary['photos'][number]>();
  for (const r of [
    ...store.records(true),
    ...prior.filter((v) => v.entity === 'record').map((v) => v.doc as HealthRecord),
  ]) {
    for (const a of r.attachments) {
      const key = r.id + '/' + a.sha256;
      if (photos.has(key)) continue;
      const file = path.join(store.root, 'attachments', r.id, a.sha256 + '.' + a.mime.split('/')[1]);
      if (!existsSync(file)) throw Error('有原照片尚未到达本机，补齐后可继续迁移。');
      photos.set(key, {
        record: r.id,
        photo: photoSchema.parse({ hash: a.sha256, bytes: statSync(file).size, mime: a.mime }),
      });
    }
  }
  return {
    version: 1,
    timezone: store.getSettings().timezone,
    goals: store.getSettings().goals,
    coach: store.coachProfile(),
    rules: store.exerciseRules(),
    aliases: store.exerciseAliases(),
    dishes: store.commonDishes(),
    definitions: store.dishDefinitions(),
    memories: store.memories(),
    messages: store.messages(),
    revisions: prior,
    energy: store.energy.export(),
    photos: [...photos.values()].sort(
      (a, b) => a.record.localeCompare(b.record) || a.photo.hash.localeCompare(b.photo.hash),
    ),
  };
}
export type MigrationInventory = {
  records: number;
  analyses: number;
  revisions: number;
  photos: number;
  memories: number;
  messages: number;
  dishes: number;
  targets: number;
  backup: string;
  ticket: string;
  enabled: boolean;
};
export function migrationPreview(store: HealthStore): MigrationInventory {
  if (!store.deviceRecords.archive) throw Error('请先连接原共享目录。');
  const file = path.join(store.root, 'backups', 'before-personal-' + randomUUID() + '.bodyjournal');
  store.backup(file);
  const data = libraryOf(store),
    records = store.records(true),
    ticket = randomUUID();
  const inventory = {
    records: records.length,
    analyses: records.filter((r) => r.analysis).length,
    revisions: data.revisions.length,
    photos: new Set(data.photos.map((p) => p.photo.hash)).size,
    memories: data.memories.length,
    messages: data.messages.length,
    dishes: data.dishes.length,
    targets: data.energy.targets.length,
    backup: path.basename(file),
    ticket,
    enabled: !!store.getConfig('personalLibraryEnabled'),
  };
  store.setConfig('personalMigrationPreview', { archive: store.deviceRecords.archive, ticket, file });
  return inventory;
}
export function confirmMigration(store: HealthStore, ticket: string) {
  const preview = store.getConfig<{ archive: string; ticket: string; file: string }>(
    'personalMigrationPreview',
  );
  if (
    !preview ||
    preview.ticket !== ticket ||
    preview.archive !== store.deviceRecords.archive ||
    !existsSync(preview.file)
  )
    throw Error('请先备份并查看当前档案清单。');
  store.setConfig('personalMigrationConfirmed', true);
}
function restoreLibrary(store: HealthStore, data: PersonalLibrary) {
  store.transaction(() => {
    for (const table of ['memories', 'messages'] as const) {
      for (const doc of data[table])
        store.db
          .prepare('INSERT OR REPLACE INTO ' + table + '(id,doc) VALUES(?,?)')
          .run(doc.id, JSON.stringify(doc));
    }
    const insert = store.db.prepare(
      'INSERT INTO revisions(entity,id,at,doc) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM revisions WHERE entity=? AND id=? AND at=? AND doc=?)',
    );
    for (const v of data.revisions) {
      const args = [v.entity, v.id, v.at, JSON.stringify(v.doc)];
      insert.run(...args, ...args);
    }
    store.setConfig('dishDefinitions', data.definitions);
    store.setConfig('coachProfile', data.coach);
    store.setConfig('exerciseAliases', data.aliases);
    store.setConfig('exerciseRules', data.rules);
    store.setSettings({ ...store.getSettings(), goals: data.goals, timezone: data.timezone });
    store.energy.restore(data.energy);
  });
}
export class PersonalSync {
  private stamp = '';
  constructor(private store: HealthStore) {}
  async exchange(id: Identity, dir: ExchangeFolder, files: string[]) {
    const store = this.store;
    const history = store.getConfig<HistoryResult[]>('recordAnalysisHistory') ?? [];
    await exchangeHistory(id, dir, files, history, async (item) => {
      const rows = store.getConfig<HistoryResult[]>('recordAnalysisHistory') ?? [];
      if (!rows.some((r) => r.id === item.id)) store.setConfig('recordAnalysisHistory', [...rows, item]);
    });
    if (store.getConfig('personalRestoreReader') && !store.getConfig('personalMigrationConfirmed')) {
      const prior = store.getConfig<string>('personalRestoreHash');
      const next = await pullLibrary(id.archive, dir, files, prior);
      if (next) {
        if ((await hashText(next.text)) !== next.manifest.hash) throw Error('完整档案摘要不一致。');
        const data = validateLibrary(JSON.parse(next.text));
        for (const { record, photo } of data.photos) await dir.photo(record, photo, false);
        restoreLibrary(store, data);
        store.setConfig('personalRestoreHash', next.manifest.hash);
      }
      return;
    }
    if (!store.getConfig('personalMigrationConfirmed')) return;
    if (!store.getConfig('personalLibraryEnabled')) {
      let ready = false;
      for (const file of files.filter((n) => /^ready-[a-f0-9-]{36}$/.test(n))) {
        const r = JSON.parse(await dir.read(file));
        if (
          r.archive === id.archive &&
          file === 'ready-' + r.device &&
          r.role === 'iphone' &&
          r.backup === true
        )
          ready = true;
      }
      if (!ready) throw Error('Mac 已确认。请在 iPhone「同步 → 历史档案」备份、确认后继续。');
      store.setConfig('personalLibraryEnabled', true);
    }
    const change = String(store.db.prepare('SELECT total_changes() n').get()!.n);
    if (this.stamp === change && files.includes('library-' + id.device)) return;
    let addedOperations = false;
    for (const r of store.records(true)) {
      const replica = store.deviceRecords.get(r.id);
      if (replica && heads(replica).length > 1) continue;
      if (store.deviceRecords.userChange(r, true)) addedOperations = true;
    }
    const data = validateLibrary(libraryOf(store));
    // Original bytes are already content addressed. Save a durable cursor before advancing the index.
    const photosHash = await hashText(JSON.stringify(data.photos)),
      cursor = store.getConfig<{ hash: string; next: number }>('personalPhotoCursor');
    let pos = cursor?.hash === photosHash ? cursor.next : 0;
    while (pos < data.photos.length) {
      const p = data.photos[pos];
      await dir.photo(p.record, p.photo, true);
      pos++;
      if (pos % 12 === 0 || pos === data.photos.length)
        store.setConfig('personalPhotoCursor', { hash: photosHash, next: pos });
    }
    await publishLibrary(id, data, dir, files, hashText);
    this.stamp = String(store.db.prepare('SELECT total_changes() n').get()!.n);
    return addedOperations;
  }
}
