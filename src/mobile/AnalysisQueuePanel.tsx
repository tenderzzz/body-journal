import { canQueue, jobLabels, queueVersion, selectedPhotoIndices, type PhoneAnalysisQueue } from './analysis-queue';
import type { Row } from './journal';

export function AnalysisQueuePanel({queue, rows, open, onError}: {
  queue: PhoneAnalysisQueue; rows: Row[]; open: (id: string) => void; onError: (message: string) => void;
}) {
  const {jobs, issue} = queue.snapshot();
  if (!jobs.length && !issue) return null;
  const count = (state: string) => jobs.filter((j) => j.state === state).length;
  const lookup = new Map(rows.map((row) => [row.record.id, row]));
  const action = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { onError((e as Error).message); }
  };
  return <details className="analysis-queue">
    <summary>分析队列 <small>{(['running','waiting','failed','done'] as const)
      .filter((s) => count(s)).map((s) => jobLabels[s] + ' ' + count(s)).join(' · ')}</small></summary>
    <p>打开 App 并联网时依次处理，可以切换到其他页面。</p>
    {issue && <p role="alert">{issue}</p>}
    <ul>{jobs.map((job) => {
      const row = lookup.get(job.id);
      const retry = job.state === 'failed' && row && canQueue(row) && queueVersion(row) === job.version;
      return <li key={job.id + ':' + job.version}>
        {row ? <button className="queue-title text" onClick={() => open(job.id)}>
          {row.record.text.slice(0, 55) || (row.record.kind === 'training' ? '训练记录' : '餐食照片')}
        </button> : <span>已移除的记录</span>}
        <small>{jobLabels[job.state]}{job.message && ' · ' + job.message}</small>
        <div className="queue-actions">
          {retry && <button className="text" onClick={() => void action(() =>
            queue.enqueue([{row, photos:selectedPhotoIndices(job, row)}]))}>重试</button>}
          {(job.state === 'waiting' || job.state === 'failed') &&
            <button className="text" onClick={() => void action(() => queue.remove(job))}>
              {job.state === 'waiting' ? '取消排队' : '移除'}
            </button>}
        </div>
      </li>;
    })}</ul>
    {count('done') > 0 && <button className="text" onClick={() => void action(() => queue.clearDone())}>清除已完成项</button>}
  </details>;
}
