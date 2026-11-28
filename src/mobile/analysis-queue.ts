import { heads } from '../shared/device-sync';
import type { PhoneAnalysis } from './analysis';
import type { PhoneJournalModel, Row } from './journal';

export type AnalysisJob = {
  id: string;
  version: string;
  photos: string[];
  state: 'waiting' | 'running' | 'failed' | 'done';
  message?: string;
};
export type AnalysisPick = { row: Row; photos: number[] };
export const jobLabels = { waiting: '排队中', running: '分析中', failed: '需处理', done: '已完成' };

export function canQueue(row: Row) {
  return !row.record.deleted && ['meal', 'training'].includes(row.record.kind) &&
    (!row.replica || heads(row.replica).length === 1);
}
export function queueVersion(row: Row) {
  // Delivery acknowledgements change the local SQLite revision, but not the content head.
  return row.replica ? heads(row.replica).map((op) => op.id).sort().join('|') : 'local-' + row.revision;
}
export function selectedPhotoIndices(job: AnalysisJob, row: Row) {
  const indices = job.photos.map((hash) => row.record.photos.findIndex((p) => p.hash === hash));
  if (indices.includes(-1)) throw Error('所选照片已变化，请在详情中重新选择。');
  return indices;
}

export class PhoneAnalysisQueue {
  private view: {jobs: AnalysisJob[]; issue: string} = {jobs: [], issue: ''};
  private listeners = new Set<() => void>();
  private saved = new Set<(row: Row) => void>();
  private loaded?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private worker?: Promise<void>;
  private active = false;

  constructor(private phone: PhoneJournalModel, private service: Pick<PhoneAnalysis, 'analyze'>) {}
  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  onSaved(listener: (row: Row) => void) {
    this.saved.add(listener);
    return () => { this.saved.delete(listener); };
  }
  private publish(jobs: AnalysisJob[], issue = '') {
    this.view = {jobs, issue};
    for (const listener of this.listeners) listener();
  }
  async start() {
    this.loaded ??= this.restore().catch((error) => {
      this.loaded = undefined;
      throw error;
    });
    await this.loaded;
    this.kick();
  }
  private async restore() {
    const stored = await this.phone.analysisQueue();
    const jobs = stored.map((job): AnalysisJob => job.state === 'running'
      ? {...job, state:'failed', message:'上次分析中断。可先查看记录，再决定是否重试。'}
      : job);
    if (jobs.some((job, i) => job !== stored[i])) await this.phone.saveAnalysisQueue(jobs);
    this.publish(jobs);
  }
  setActive(active: boolean) {
    this.active = active;
    this.kick();
  }
  private update(change: (jobs: AnalysisJob[]) => AnalysisJob[]) {
    const write = this.writing.then(async () => {
      if (this.view.issue) throw Error(this.view.issue);
      const next = change(this.view.jobs);
      if (next === this.view.jobs) return;
      // Keep actionable jobs until the user removes them. Bound the completed history.
      const old = new Set(next.filter((j) => j.state === 'done').slice(0, -30));
      const jobs = old.size ? next.filter((j) => !old.has(j)) : next;
      await this.phone.saveAnalysisQueue(jobs);
      this.publish(jobs);
    });
    this.writing = write.catch(() => {});
    return write;
  }
  async enqueue(picks: AnalysisPick[]) {
    const additions = picks.map(({row, photos}): AnalysisJob => {
      if (!canQueue(row)) throw Error('请选择有效的餐食或训练记录，并先解决同步冲突。');
      if (photos.some((i) => !Number.isInteger(i) || !row.record.photos[i])) throw Error('请重新选择照片。');
      return {id:row.record.id, version:queueVersion(row), state:'waiting',
        photos:[...new Set(photos.map((i) => row.record.photos[i].hash))]};
    });
    await this.start();
    await this.update((current) => {
      let jobs = [...current];
      for (const job of additions) {
        const previous = jobs.find((j) => j.id === job.id && j.version === job.version);
        if (previous && (previous.state === 'running' || previous.state === 'done')) continue;
        if (previous?.state === 'waiting') {
          jobs[jobs.indexOf(previous)] = job;
          continue;
        }
        jobs = jobs.filter((j) => j.id !== job.id || j.state === 'running');
        jobs.push(job);
      }
      return jobs;
    });
    this.kick();
  }
  async remove(job: AnalysisJob) {
    await this.update((jobs) => jobs.filter((j) => j.id !== job.id || j.version !== job.version || j.state === 'running'));
  }
  async clearDone() {
    await this.update((jobs) => jobs.filter((j) => j.state !== 'done'));
  }
  private kick() {
    if (!this.active || this.worker || this.view.issue || !this.view.jobs.some((j) => j.state === 'waiting')) return;
    this.worker = this.drain().catch((error) => {
      this.publish(this.view.jobs, '队列保存失败，请重新打开 App 核对进度。' + (error as Error).message);
    }).finally(() => { this.worker = undefined; this.kick(); });
  }
  async whenIdle() {
    while (this.worker) await this.worker;
  }
  private async drain() {
    while (this.active) {
      let job: AnalysisJob | undefined;
      await this.update((jobs) => {
        const next = this.active && jobs.find((j) => j.state === 'waiting');
        if (!next) return jobs;
        job = {...next, state:'running'};
        return jobs.map((j) => j === next ? job! : j);
      });
      if (!job) return;
      let outcome: AnalysisJob, saved: Row | undefined;
      try {
        const row = await this.phone.row(job.id);
        if (!row || !canQueue(row)) throw Error('记录已删除或存在冲突，请先查看记录。');
        if (queueVersion(row) !== job.version) throw Error('排队期间记录已修改，请在详情中重新加入。');
        saved = await this.service.analyze(row, selectedPhotoIndices(job, row));
        outcome = {...job, state:'done'};
      } catch (error) {
        outcome = {...job, state:'failed', message:(error as Error).message};
      }
      await this.update((jobs) => jobs.map((j) => j === job ? outcome : j));
      if (saved) for (const listener of this.saved) listener(saved);
    }
  }
}
