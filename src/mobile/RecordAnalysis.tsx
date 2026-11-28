import { useState } from 'react';
import type { SetEntry } from '../shared/types';
import type { Row, PhoneJournalModel } from './journal';
import type { PhoneAnalysis } from './analysis';
import { canQueue, jobLabels, queueVersion, type AnalysisJob, type PhoneAnalysisQueue } from './analysis-queue';
import { ingredientAmount } from '../shared/food';
import type { HistoryResult, LibraryRevision } from '../shared/personal-library';
import { heads } from '../shared/device-sync';

export function RecordAnalysis({
  row,
  service,
  queue,
  job,
  model,
  changed,
}: {
  row: Row;
  service: PhoneAnalysis;
  queue: PhoneAnalysisQueue;
  job?: AnalysisJob;
  model: PhoneJournalModel;
  changed: (r: Row) => void;
}) {
  const r = row.record,
    a = r.detail?.analysis;
  const [busy, work] = useState(false),
    [message, show] = useState(''),
    [answer, reply] = useState('');
  const [photos, select] = useState(() => r.photos.map((_, i) => i));
  const [sets, editSets] = useState<SetEntry[] | null>(null);
  const [history, setHistory] = useState<{ at: string; text: string }[] | null>(null);
  const activeJob = job && job.version === queueVersion(row) && (job.state === 'running' || job.state === 'waiting');
  const enqueue = async () => {
    work(true);
    show('');
    try { await queue.enqueue([{row, photos}]); }
    catch (e) { show((e as Error).message); }
    finally { work(false); }
  };
  const action = async (fn: () => Promise<Row>) => {
    work(true);
    show('');
    try {
      changed(await fn());
      setHistory(null);
    } catch (e) {
      show((e as Error).message);
    } finally {
      work(false);
    }
  };
  const range = (v: { low: number; high: number }) =>
    v.low === v.high
      ? String(Number(v.low.toFixed(1)))
      : Number(v.low.toFixed(1)) + '–' + Number(v.high.toFixed(1));
  const currentHeads = new Set(row.replica ? heads(row.replica).map((o) => o.id) : []);
  return (
    <section className="phone-analysis">
      <h2>记录分析</h2>
      {r.detail?.pending && a && <p>原记录已修改，等待重新分析。</p>}
      {a && (
        <>
          <p>{a.summary}</p>
          {a.macros && (
            <p>
              <strong>{range(a.macros.kcal)} kcal</strong> · 蛋白质 {range(a.macros.protein)} g
            </p>
          )}
          {a.ingredients?.map((i, n) => (
            <div className="food-correction" key={n}>
              <span>
                <b>{i.name}</b>
                <small>
                  {range(ingredientAmount(i))} {ingredientAmount(i).unit} · 已吃{' '}
                  {Math.round(100 * (i.consumedFraction?.low ?? 1))}%
                </small>
              </span>
              <select
                aria-label={i.name + ' 食用比例'}
                disabled={busy || r.deleted}
                value={String(i.consumedFraction?.low ?? 1)}
                onChange={(e) =>
                  void action(() => service.correct(row, { food: n, fraction: Number(e.target.value) }))
                }
              >
                {[...new Set([0, 0.25, 0.5, 0.75, 1, i.consumedFraction?.low ?? 1])]
                  .sort((x, y) => x - y)
                  .map((v) => (
                    <option key={v} value={v}>
                      {v === 0.5 ? '半份' : v === 1 ? '整份' : v * 100 + '%'}
                    </option>
                  ))}
              </select>
            </div>
          ))}
          {!!a.sets?.length && (
            <>
              <ul>
                {a.sets.map((s, n) => (
                  <li key={n}>
                    {s.exercise} · {s.sets} 组 × {s.reps} 次 · {s.kg === null ? '重量未确认' : s.kg + ' kg'}
                  </li>
                ))}
              </ul>
              <button disabled={busy || r.deleted} onClick={() => editSets(structuredClone(a.sets!))}>
                修正训练
              </button>
            </>
          )}
          {a.run && (
            <p>
              有氧训练 {a.run.km ?? '—'} km · {a.run.minutes ?? '—'} 分钟
            </p>
          )}
          {a.questions.map((q, i) => (
            <p key={i}>{q}</p>
          ))}
        </>
      )}
      {sets && (
        <fieldset disabled={busy}>
          {sets.map((s, n) => {
            function update(p: Partial<SetEntry>) {
              editSets(
                sets!.map((v, i) => (i === n ? { ...v, ...p, confirmed: true, basisSource: 'manual' } : v)),
              );
            }
            return (
              <div key={n}>
                <label>
                  动作
                  <input
                    value={s.exercise}
                    onChange={(e) =>
                      update({
                        exercise: e.target.value,
                        originalExercise: e.target.value,
                        exerciseManuallyClassified: true,
                      })
                    }
                  />
                </label>
                {(['sets', 'reps', 'kg'] as const).map((k) => (
                  <label key={k}>
                    {{ sets: '组数', reps: '次数', kg: '重量 kg' }[k]}
                    <input
                      type="number"
                      value={s[k] ?? ''}
                      onChange={(e) =>
                        update({ [k]: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
                  </label>
                ))}
                <label>
                  重量口径
                  <select
                    value={s.loadBasis}
                    onChange={(e) => update({ loadBasis: e.target.value as SetEntry['loadBasis'] })}
                  >
                    {Object.entries({
                      total: '总重',
                      per_hand: '单手',
                      machine: '器械',
                      bodyweight: '自重',
                      unknown: '未确认',
                    }).map(([v, t]) => (
                      <option key={v} value={v}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })}
          <button
            onClick={() =>
              void action(async () => {
                const updated = await service.correct(row, { sets });
                editSets(null);
                return updated;
              })
            }
          >
            保存训练修正
          </button>
          <button onClick={() => editSets(null)}>取消</button>
        </fieldset>
      )}
      {!r.deleted && (
        <fieldset disabled={busy}>
          {r.photos.length > 0 && (
            <div>
              {r.photos.map((p, n) => (
                <label key={p.hash + n}>
                  <input
                    type="checkbox"
                    checked={photos.includes(n)}
                    onChange={(e) =>
                      select(e.target.checked ? [...photos, n] : photos.filter((i) => i !== n))
                    }
                  />{' '}
                  分析照片 {n + 1}
                </label>
              ))}
            </div>
          )}
          <button className="primary" disabled={!!activeJob || !canQueue(row)} onClick={() => void enqueue()}>
            {activeJob ? jobLabels[job.state] : '分析这条记录'}
          </button>
          {activeJob && <p role="status">已加入分析队列，可以返回手记继续操作。</p>}
          {job?.state === 'failed' && <p role="status">{job.message}</p>}
          {a && (
            <>
              <label>
                补充说明
                <input maxLength={10000} value={answer} onChange={(e) => reply(e.target.value)} />
              </label>
              <button
                disabled={!answer.trim() || !canQueue(row)}
                onClick={() =>
                  void action(async () => {
                    const added = await service.followup(row, answer);
                    reply('');
                    try { await queue.enqueue([{row:added, photos}]); }
                    catch (e) { show('补充已保存。' + (e as Error).message); }
                    return added;
                  })
                }
              >
                保存补充并分析
              </button>
            </>
          )}
        </fieldset>
      )}
      {r.detail?.followups.map((f, n) => (
        <p key={n}>补充 · {f.answer}</p>
      ))}
      <button
        onClick={async () => {
          try {
            const old =
              (await model.library())?.revisions.filter(
                (v: LibraryRevision) => v.entity === 'record' && v.id === r.id,
              ) ?? [];
            const attempts = (await model.attempts()).filter((v: HistoryResult) => v.record === r.id);
            const archived =
              row.replica?.ops
                .filter((o) => o.record.detail?.analysis && !currentHeads.has(o.id))
                .map((o) => ({
                  at: o.record.detail!.updatedAt,
                  text: o.record.detail!.analysis!.summary,
                })) ?? [];
            const items = [
              ...old.flatMap((v) =>
                'analysis' in v.doc && v.doc.analysis ? [{ at: v.at, text: v.doc.analysis.summary }] : [],
              ),
              ...archived,
              ...attempts.map((v) => ({ at: v.at, text: '较早版本的返回结果 · ' + v.analysis.summary })),
            ];
            setHistory(
              [...new Map(items.map((v) => [v.at + v.text, v])).values()].sort((a, b) =>
                b.at.localeCompare(a.at),
              ),
            );
          } catch (e) {
            show((e as Error).message);
          }
        }}
      >
        查看分析历史
      </button>
      {history &&
        (history.length ? (
          history.map((h) => (
            <p key={h.at + h.text}>
              {new Date(h.at).toLocaleString()} · {h.text}
            </p>
          ))
        ) : (
          <p>尚无更早的分析。</p>
        ))}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
