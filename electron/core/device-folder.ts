import {PersonalSync} from './personal-library';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { HealthStore } from './store';
import { atomicWrite } from './store';
import {
  heads,
  recoveryParts,
  type SyncSettings,
  type SyncReport,
  type PhotoRef,
} from '../../src/shared/device-sync';
import { publishInsights } from './phone-insights';
import { calendarDay } from '../../src/shared/dates';
import { exchange, type ExchangeFolder } from '../../src/shared/device-exchange';

type Prefs = { device: string; enabled: boolean; folder?: string; archive?: string };
type Secrets = { read: () => Promise<string>; write: (code: string) => Promise<void> };
export class NativeFolder implements ExchangeFolder {
  constructor(
    private binary: string,
    private args: { code: string; folder: string; local: string },
    private active = () => true,
  ) {}
  call(command: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.active()) throw Error('同步已暂停，待发修改保留在本机。');
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '',
        err = '';
      child.stdout.setEncoding('utf8').on('data', (v) => (out += v));
      child.stderr.setEncoding('utf8').on('data', (v) => (err += v));
      child.once('error', reject);
      child.stdin.on('error', () => {});
      child.once('close', (code) => {
        if (code !== 0) return reject(Error(err || '目录操作未完成，请重新选择共享目录。'));
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(Error('目录读取未完成，请重试。'));
        }
      });
      child.stdin.end(JSON.stringify({ ...this.args, command, ...args }));
    });
  }
  async list(): Promise<string[]> {
    return (await this.call('list')).names;
  }
  async read(name: string): Promise<string> {
    return (await this.call('read', { name })).text;
  }
  async write(name: string, text: string) {
    await this.call('write', { name, text });
  }
  async photo(record: string, photo: PhotoRef, upload: boolean) {
    await this.call('photo', { record, photo, upload });
  }
}
export class MacDeviceSync {
  private prefs: Prefs;
  private personal:PersonalSync;
  private report?: SyncReport;
  private running?: Promise<SyncSettings>;
  private timer?: ReturnType<typeof setTimeout>;
  private binding = false;
  private insightStamp = '';
  private requestedWhileRunning = false;
  constructor(
    private store: HealthStore,
    private file: string,
    private binary: string,
    private secrets: Secrets,
    private changed: () => void,
  ) {
    this.personal=new PersonalSync(store);
    this.prefs = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { device: randomUUID(), enabled: false };
    this.store.deviceRecords.device = this.prefs.device;
    if (this.prefs.archive !== this.store.deviceRecords.archive) this.prefs.enabled = false;
    this.save();
  }
  private save() {
    atomicWrite(this.file, JSON.stringify(this.prefs));
  }
  status(): SyncSettings {
    const replicas = this.store.deviceRecords.all();
    return {
      ...this.prefs,
      archive: this.store.deviceRecords.archive,
      report: this.report,
      conflicts: replicas.filter((r) => heads(r).length > 1).map((r) => r.ops[0].record.id),
      pending: replicas.reduce(
        (n, r) => n + r.ops.filter((o) => o.device === this.prefs.device && !r.written.includes(o.id)).length,
        0,
      ),
    };
  }
  async recovery() {
    const code = await this.secrets.read();
    if (!code || recoveryParts(code).archive !== this.store.deviceRecords.archive)
      throw Error('本机没有该档案的恢复码，请从配对设备取回。');
    return code;
  }
  async configure(folder: string, mode: 'create' | 'join' | 'reconnect', input?: string) {
    if (this.binding) throw Error('正在配对，请稍候。');
    this.binding = true;
    try {
      if (this.running) await this.running;
      const selected = realpathSync(folder);
      const overlaps = (target: string) => {
        if (!target) return false;
        const full = existsSync(target) ? realpathSync(target) : path.resolve(target);
        return (
          selected === full || selected.startsWith(full + path.sep) || full.startsWith(selected + path.sep)
        );
      };
      if (overlaps(this.store.root) || overlaps(this.store.getSettings().inbox))
        throw Error('请选择独立的共享目录，与本地档案和快捷指令收件箱分开。');
      const bound = this.store.deviceRecords.archive;
      if (mode === 'create' && bound) throw Error('请重新选择原目录或输入原档案恢复码。');
      if (mode === 'create' && this.prefs.archive) throw Error('此设备已有配对记录，请用原恢复码连接。');
      const staged = mode === 'create' ? await this.secrets.read() : '';
      const code =
        mode === 'join'
          ? input?.trim()
          : mode === 'reconnect'
            ? await this.recovery()
            : staged || 'BJ1.' + randomUUID() + '.' + randomBytes(32).toString('base64');
      const { archive } = recoveryParts(code ?? '');
      if (bound && bound !== archive) throw Error('恢复码属于另一个档案，请核对后重新选择。');
      const dir = new NativeFolder(this.binary, {
        folder: selected,
        code: code!,
        local: path.join(this.store.root, 'attachments'),
      });
      // Save a new key before the first encrypted marker is committed.
      if (mode === 'create') await this.secrets.write(code!);
      await dir.call(mode === 'create' ? 'create' : 'bind');
      if (mode === 'join') await this.secrets.write(code!);
      if(mode==='join'&&!this.store.records(true).length)this.store.setConfig('personalRestoreReader',true);
      this.store.deviceRecords.bind(archive);
      this.prefs = { ...this.prefs, archive, folder: selected, enabled: true };
      this.save();
      this.report = undefined;
    } finally {
      this.binding = false;
    }
    return this.sync();
  }
  async pause() {
    this.prefs.enabled = false;
    this.save();
    clearTimeout(this.timer);
    if (this.running) await this.running;
    return this.status();
  }
  request(delay = 250) {
    if (!this.prefs.enabled || this.binding) return;
    if (this.running) {
      this.requestedWhileRunning = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.sync().catch(() => {});
    }, delay);
  }
  sync(): Promise<SyncSettings> {
    if (this.running) return this.running;
    if (!this.prefs.enabled || this.binding) return Promise.resolve(this.status());
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.requestedWhileRunning) {
        this.requestedWhileRunning = false;
        this.request();
      }
    });
    return this.running;
  }
  private async run() {
    const { folder, archive, device } = this.prefs;
    try {
      if (!folder || !archive || this.store.deviceRecords.archive !== archive)
        throw Error('请核对恢复的档案并重新配对。');
      const dir = new NativeFolder(
        this.binary,
        { folder, code: await this.recovery(), local: path.join(this.store.root, 'attachments') },
        () => this.prefs.enabled,
      );
      this.store.deviceRecords.backfill();
      const files = await dir.list();
      this.report = await exchange({ archive, device }, this.store.deviceRecords, dir, files);
      try {
        if (await this.personal.exchange({ archive, device }, dir, files)) this.requestedWhileRunning = true;
      } catch (e) {
        this.report.issues.push('历史档案：' + (e as Error).message);
      }
      const now = new Date();
      const stamp = [
        archive,
        this.store.db.prepare('SELECT total_changes() AS n').get()!.n,
        this.store.energy.today(now),
        calendarDay(now.toISOString(), this.store.getSettings().timezone),
      ].join('/');
      if (stamp !== this.insightStamp || !files.includes('overview-' + device)) {
        try {
          await publishInsights(this.store, { archive, device }, dir, files, now);
          this.insightStamp = stamp;
        } catch (e) {
          this.report.issues.push('能量和趋势等待更新：' + (e instanceof Error ? e.message : String(e)));
        }
      }
    } catch (e) {
      this.report = {
        at: new Date().toISOString(),
        waiting: 0,
        changed: 0,
        issues: [
          (e instanceof Error ? e.message : String(e)) + ' 请检查目录授权或可用空间，再点「立即同步」。',
        ],
      };
    }
    this.changed();
    return this.status();
  }
}
