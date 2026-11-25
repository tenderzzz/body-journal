import { useMemo, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  NotebookPen,
  RefreshCw,
  Footprints,
  Utensils,
  Dumbbell,
  Scale,
  StickyNote,
  ImagePlus,
  FolderSync,
  Activity,
  TrendingUp,
  BookOpen,
  Trash2,
} from 'lucide-react';
import { addCalendarDays, atTime, calendarDay, dateParts, journalDay } from '../shared/dates';
import {
  newDeviceUUID,
  deliveryLabel,
  heads,
  portionLabel,
  recoveryParts,
  type PhoneRecord,
  type PhotoRef,
  type SyncReport,
} from '../shared/device-sync';
import { SyncConflict } from '../ui/SyncConflict';
import { PhoneJournalModel, stamp, stepsForDay, type PhoneIdentity, type Row } from './journal';
import { InsightPage } from './PhoneInsights';
import type { PhoneInsights } from '../shared/phone-insights';
import { PhoneAnalysis, healthRecord } from './analysis';
import { detailOf } from '../shared/record-detail';
import { RecordAnalysis } from './RecordAnalysis';
import { localInsights } from './local-insights';
import type { PersonalLibrary } from '../shared/personal-library';
import { LibraryPanel } from './LibraryPanel';
import { MobileModels } from './models';
import { ModelSettings } from './ModelSettings';
import './phone.css';

const model = new PhoneJournalModel();
const models = new MobileModels(model);
const analysis = new PhoneAnalysis(model, models);
const labels = { meal: '记一餐', training: '记训练', body: '记身体', note: '随手记', steps: '记步数' };
const kinds = { meal: '餐食', training: '训练', body: '身体', note: '手记', steps: '步数' };
const icons = { meal: Utensils, training: Dumbbell, body: Scale, note: StickyNote, steps: Footprints };
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const dayOf = (r: PhoneRecord) => (r.kind === 'steps' ? calendarDay : journalDay)(r.occurredAt, r.timezone);
function fieldTime(r: PhoneRecord) {
  const p = dateParts(r.occurredAt, r.timezone);
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
}
function blankRecord(kind: PhoneRecord['kind'], occurredAt: string, timezone: string): PhoneRecord {
  return {
    id: newDeviceUUID(),
    kind,
    text: '',
    occurredAt,
    timezone,
    deleted: false,
    photos: [],
    portions: [],
  };
}
function localValue(r: PhoneRecord) {
  return r.kind === 'steps'
    ? (r.steps ?? 0).toLocaleString() + ' 步'
    : r.text ||
        [
          r.body?.weightKg && r.body.weightKg + ' kg',
          r.body?.waistCm && r.body.waistCm + ' cm',
          r.body?.bodyFatPercent && r.body.bodyFatPercent + '%',
        ]
          .filter(Boolean)
          .join(' / ') ||
        (r.photos.length ? r.photos.length + ' 张照片' : '无文字记录');
}
function photoKey(p: PhotoRef, i: number) {
  return p.hash + '-' + i;
}
function PhonePhoto({
  photo,
  index,
  refresh,
}: {
  photo: PhotoRef;
  index: number;
  refresh?: string | number;
}) {
  const [url, setUrl] = useState(''),
    [full, setFull] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    model
      .call<{ url?: string }>('preview', { photo })
      .then((v) => {
        if (live) setUrl(v.url ?? '');
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [photo.hash, refresh]);
  return (
    <>
      {url ? (
        <button
          type="button"
          className="phone-photo"
          aria-label={'查看照片 ' + (index + 1)}
          onClick={async () => {
            try {
              setFull((await model.call<{ url: string }>('preview', { photo, full: true })).url);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <img src={url} alt={'照片 ' + (index + 1)} />
        </button>
      ) : (
        <span className="photo-wait">{error || '照片 ' + (index + 1) + ' 下载中'}</span>
      )}
      {full && (
        <div role="dialog" aria-label="照片" className="photo-view">
          <button type="button" onClick={() => setFull('')}>
            关闭照片
          </button>
          <img src={full} alt={'照片 ' + (index + 1)} />
        </div>
      )}
    </>
  );
}
function PhotoConsent({
  r,
  selected,
  shared,
  set,
}: {
  r: PhoneRecord;
  selected: number[];
  shared: PhotoRef[];
  set: (v: number[]) => void;
}) {
  if (!['meal', 'training', 'note'].includes(r.kind) || !r.photos.length) return null;
  return (
    <div className="consent-photos">
      {r.photos.map((p, i) => (
        <label key={photoKey(p, i)}>
          <input
            type="checkbox"
            disabled={shared.some((old) => old.hash === p.hash)}
            checked={selected.includes(i) || shared.some((old) => old.hash === p.hash)}
            onChange={(e) => set(e.target.checked ? [...selected, i] : selected.filter((n) => n !== i))}
          />
          选入照片 {i + 1}
        </label>
      ))}
    </div>
  );
}
function Editor({
  original,
  base,
  id,
  back,
  saved,
  openStepDay,
}: {
  original: PhoneRecord;
  base: Row | null;
  id: PhoneIdentity;
  back: () => void;
  saved: (r: Row) => void;
  openStepDay?: (day: string, draft?: PhoneRecord) => void;
}) {
  const [r, set] = useState<PhoneRecord>(() => structuredClone(original)),
    [time, setTime] = useState(fieldTime(original));
  const [sharingLibrary, setSharingLibrary] = useState(false);
  useEffect(() => {
    void model
      .migrationOn()
      .then((v) => setSharingLibrary(!!v))
      .catch(() => {});
  }, []);
  const [photos, select] = useState<number[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const update = (v: Partial<PhoneRecord>) => set((current) => ({ ...current, ...v }));
  const today = calendarDay(new Date().toISOString(), r.timezone);
  const yesterday = addCalendarDays(today, -1);
  const stepDate = time.slice(0, 10);
  const fullDay = r.kind === 'steps' && r.stepCoverage === 'full';
  const changeStepDate = (day: string) => {
    if (day === stepDate) return;
    if (day && day <= today && openStepDay) {
      openStepDay(day, base ? undefined : r);
    } else {
      setTime(day ? day + 'T' + (time.slice(11) || fieldTime(original).slice(11)) : '');
    }
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const instant =
        time === fieldTime(original) || (fullDay && stepDate === dayOf(original))
          ? original.occurredAt
          : atTime(
              time.slice(0, 10),
              fullDay ? 12 : Number(time.slice(11, 13)),
              fullDay ? 0 : Number(time.slice(14, 16)),
              r.timezone,
            );
      if (!instant) throw Error('请核对发生时间。');
      const fresh = { ...r, occurredAt: instant };
      if (!base)
        fresh.detail = detailOf({
          ...healthRecord(fresh),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      saved(await model.save(fresh, base ? stamp(base) : null, photos));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="phone-content">
      <button className="back" onClick={back}>
        <ArrowLeft />
        返回
      </button>
      <h1>{base ? '修改' + kinds[r.kind] : labels[r.kind]}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy}>
          {r.kind === 'steps' ? (
            <>
              <label>
                步数日期
                <span className="record-date-field">
                  <input
                    type="date"
                    required
                    max={today}
                    value={stepDate}
                    onChange={(e) => changeStepDate(e.target.value)}
                  />
                </span>
              </label>
              <div className="step-dates">
                <button
                  type="button"
                  aria-pressed={stepDate === yesterday}
                  onClick={() => changeStepDate(yesterday)}
                >
                  昨天
                </button>
                <button
                  type="button"
                  aria-pressed={stepDate === today}
                  onClick={() => changeStepDate(today)}
                >
                  今天
                </button>
              </div>
              <label>
                {fullDay ? '全天总步数' : '累计步数'}
                <input
                  required
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="100000"
                  step="1"
                  value={r.steps ?? ''}
                  onChange={(e) =>
                    update({ steps: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                />
              </label>
              <label>
                步数覆盖范围
                <select
                  className="coverage-select"
                  value={r.stepCoverage ?? 'partial'}
                  onChange={(e) => update({ stepCoverage: e.target.value as 'partial' | 'full' })}
                >
                  <option value="full">全天总数</option>
                  <option value="partial">截至记录时</option>
                </select>
              </label>
              {!fullDay && (
                <label>
                  截至时间
                  <span className="record-date-field">
                    <input
                      type="time"
                      required
                      value={time.slice(11)}
                      onChange={(e) => setTime(stepDate + 'T' + e.target.value)}
                    />
                  </span>
                </label>
              )}
            </>
          ) : (
            <label>
              发生时间
              <span className="record-date-field">
                <input
                  type="datetime-local"
                  required
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </span>
            </label>
          )}
          {r.kind === 'body' && (
            <div className="measure-fields">
              {(
                [
                  ['weightKg', '体重 kg', 10, 500],
                  ['waistCm', '腰围 cm', 20, 300],
                  ['bodyFatPercent', '体脂率 %', 0.01, 99.99],
                ] as const
              ).map(([key, label, min, max]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min={min}
                    max={max}
                    value={r.body?.[key] ?? ''}
                    onChange={(e) => {
                      const body = { ...r.body };
                      if (e.target.value === '') delete body[key];
                      else body[key] = Number(e.target.value);
                      update({ body });
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          <label>
            {r.kind === 'steps' || r.kind === 'body' ? '备注' : '原文'}
            <textarea
              rows={4}
              maxLength={100000}
              value={r.text}
              placeholder={r.kind === 'meal' ? '吃了什么，大约多少？' : '写下这条记录…'}
              onChange={(e) => update({ text: e.target.value })}
            />
          </label>
          {!!r.photos.length && (
            <div className="phone-photos">
              {r.photos.map((p, i) => (
                <div key={photoKey(p, i)}>
                  <PhonePhoto photo={p} index={i} />
                  {!base && (
                    <button
                      type="button"
                      onClick={() => {
                        update({ photos: r.photos.filter((_, n) => n !== i) });
                        select([]);
                      }}
                    >
                      移除
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!base && ['meal', 'training', 'note'].includes(r.kind) && r.photos.length < 8 && (
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await model.call<{ photos?: PhotoRef[] }>('camera');
                  if (result.photos) {
                    update({ photos: [...r.photos, ...result.photos] });
                    if (id.archive) select([...photos, r.photos.length]);
                  }
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              拍照
            </button>
          )}
          {!base && ['meal', 'training', 'note'].includes(r.kind) && r.photos.length < 8 && (
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                setBusy(true);
                try {
                  const v = await model.call<{ photos?: PhotoRef[] }>('pick', {
                    limit: 8 - r.photos.length,
                  });
                  if (v.photos) {
                    update({ photos: [...r.photos, ...v.photos] });
                    if (id.archive) select([...photos, ...v.photos.map((_, i) => r.photos.length + i)]);
                  }
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ImagePlus />
              添加照片（{r.photos.length}/8）
            </button>
          )}
          {id.archive && (
            <div className="share-choice">
              <small>{id.enabled ? '保存后自动同步。' : '同步已暂停，恢复后会自动发送。'}</small>
              {sharingLibrary && r.photos.length > 0 ? (
                <small>完整档案会同步原照片。分析时可以另选发给模型的照片。</small>
              ) : (
                <PhotoConsent
                  r={r}
                  selected={photos}
                  set={select}
                  shared={base?.replica ? heads(base.replica)[0].record.photos : []}
                />
              )}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '正在保存…' : '保存到本机'}
          </button>
        </fieldset>
      </form>
    </main>
  );
}
function Pairing({
  id,
  report,
  refresh,
  sync,
  rows,
  open,
}: {
  id: PhoneIdentity;
  report?: SyncReport;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  rows: Row[];
  open: (id: string) => void;
}) {
  const [code, setCode] = useState(''),
    [shown, setShown] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choose = async (input?: string) => {
    if (input) recoveryParts(input);
    const result = await model.call<{ cancelled?: boolean }>('choose', input ? { code: input.trim() } : {});
    if (result.cancelled) return;
    setCode('');
    await refresh();
    await sync();
  };
  const conflicts = rows.filter((r) => r.replica && heads(r.replica).length > 1);
  return (
    <main className="phone-content">
      <h1>设备同步</h1>
      <ModelSettings models={models} />
      <LibraryPanel model={model} sync={sync} at={report?.at} />
      <p>
        {id.archive
          ? id.enabled
            ? '已连接 · ' + id.folder
            : '同步已暂停'
          : '先在 Mac 的「连接与数据」创建共享档案，再选取同一个 iCloud Drive 文件夹。'}
      </p>
      <fieldset disabled={busy}>
        {id.archive && (
          <div className="actions">
            <button className="primary" disabled={!id.enabled} onClick={() => action(sync)}>
              <RefreshCw />
              立即同步
            </button>
            <button className="secondary" onClick={() => action(() => choose())}>
              重选原目录
            </button>
          </div>
        )}
        <details open={!id.archive || undefined}>
          <summary>{id.archive ? '用恢复码重新配对' : '配对这部 iPhone'}</summary>
          <button
            className="secondary"
            onClick={() =>
              action(async () => {
                const v = await model.call<{ code?: string }>('scan');
                if (v.code) await choose(v.code);
              })
            }
          >
            扫描 Mac 配对码
          </button>
          <label>
            或填写恢复码
            <input
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button className="secondary" disabled={!code.trim()} onClick={() => action(() => choose(code))}>
            选择共享文件夹
          </button>
        </details>
        {id.archive && (
          <>
            <button
              className="text"
              onClick={() =>
                action(async () => setShown(shown ? '' : (await model.call<{ code: string }>('code')).code))
              }
            >
              {shown ? '收起恢复码' : '查看恢复码'}
            </button>
            {shown && <p className="recovery">{shown}</p>}
            {id.enabled && (
              <button
                className="text"
                onClick={() =>
                  action(async () => {
                    await model.call('pause');
                    await refresh();
                  })
                }
              >
                暂停同步
              </button>
            )}
          </>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {report && (
        <section>
          <h2>最近一次检查</h2>
          <p>
            {new Date(report.at).toLocaleTimeString()} · {report.waiting} 项等待补齐
          </p>
          {report.issues.map((e) => (
            <p key={e} role="status">
              {e}
            </p>
          ))}
        </section>
      )}
      {conflicts.length > 0 && (
        <section>
          <h2>需要核对</h2>
          {conflicts.map((r) => (
            <button className="line-button" key={r.record.id} onClick={() => open(r.record.id)}>
              {localValue(r.record).slice(0, 60)}
            </button>
          ))}
        </section>
      )}
      <p className="muted">
        配对后自动补齐历史，并同步新增、修改和删除的记录。餐食照片可逐张共享，其他照片保存在原设备。
      </p>
    </main>
  );
}
export function PhoneJournal() {
  const [identity, setId] = useState<PhoneIdentity>(),
    [rows, setRows] = useState<Row[]>([]),
    [report, setReport] = useState<SyncReport>(),
    [error, setError] = useState('');
  const [page, setPage] = useState<'journal' | 'energy' | 'trends' | 'sync'>('journal'),
    [view, setView] = useState<PhoneInsights | null>(null),
    [allDates, showAll] = useState(false),
    [limit, setLimit] = useState(50),
    [selected, setSelected] = useState<string>(),
    [editor, setEditor] = useState<{ r: PhoneRecord; base: Row | null; dailySteps?: boolean }>();
  const [timelineDay, setTimelineDay] = useState<{ date: string; chosen: boolean }>(),
    [trash, setTrash] = useState(false),
    [notice, setNotice] = useState('');
  const date = timelineDay?.date ?? journalDay(new Date().toISOString(), zone());
  const setDate = (day: string) => setTimelineDay({ date: day, chosen: true });
  const [library, setLibrary] = useState<PersonalLibrary | null>(null);
  const computed = useMemo(
    () => (identity ? localInsights(rows, library, view, identity) : view),
    [rows, library, view, identity],
  );
  const reload = async () => {
    const [id, list, insights, history] = await Promise.all([
      model.identity(),
      model.rows(),
      model.insights(),
      model.library(),
    ]);
    setLibrary(history);
    setView(insights?.manifest.archive === id.archive ? insights : null);
    setId(id);
    setRows(list);
  };
  const sync = async () => {
    setReport(await model.sync());
    await reload();
  };
  useEffect(() => {
    const run = () => {
      void sync().catch((e) => setError(e.message));
    };
    void reload()
      .then(run)
      .catch((e) => setError(e.message));
    const foreground = () => {
      if (!document.hidden) run();
    };
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('online', run);
    const timer = window.setInterval(foreground, 60000);
    return () => {
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('online', run);
      clearInterval(timer);
    };
  }, []);
  const changed = (row: Row) => {
    setRows((v) => [...v.filter((r) => r.record.id !== row.record.id), row]);
    setSelected(row.record.id);
    const savedDay = dayOf(row.record);
    if (!editor?.dailySteps && savedDay !== date) setTimelineDay({ date: savedDay, chosen: false });
    setEditor(undefined);
    setNotice('已存本机');
    void sync().catch((e) => setError(e.message));
  };
  const row = rows.find((r) => r.record.id === selected),
    r = row?.record;

  const openStepDay = (day: string, draft?: PhoneRecord) => {
    setNotice('');
    const existing = stepsForDay(rows, day);
    if (existing) {
      setEditor({ r: existing.record, base: existing, dailySteps: true });
      return;
    }
    const now = new Date().toISOString(),
      tz = draft?.timezone ?? zone();
    const isToday = day === calendarDay(now, tz);
    const occurredAt = isToday ? now : atTime(day, 12, 0, tz);
    if (!occurredAt) {
      setError('请核对步数日期。');
      return;
    }
    setEditor({
      r: {
        ...blankRecord('steps', occurredAt, tz),
        text: draft?.text ?? '',
        steps: draft?.steps,
        stepCoverage: isToday ? 'partial' : 'full',
      },
      base: null,
      dailySteps: true,
    });
  };
  const create = (kind: PhoneRecord['kind']) => {
    const now = new Date().toISOString(),
      tz = zone();
    if (kind === 'steps') {
      const today = calendarDay(now, tz);
      openStepDay(
        !allDates && !trash && timelineDay?.chosen && date < today ? date : addCalendarDays(today, -1),
      );
      return;
    }
    const occurredAt = date === journalDay(now, tz) ? now : atTime(date, 12, 0, tz);
    if (!occurredAt) {
      setError('请核对发生日期。');
      return;
    }
    setEditor({ r: blankRecord(kind, occurredAt, tz), base: null });
    setNotice('');
  };
  if (!identity)
    return (
      <div className="phone">
        <main className="phone-content">
          <h1>身体手记</h1>
          <p role="status">{error || '正在打开本机档案…'}</p>
        </main>
      </div>
    );
  const visible = rows
    .filter((v) => v.record.deleted === trash && (trash || allDates || dayOf(v.record) === date))
    .sort((a, b) => Date.parse(b.record.occurredAt) - Date.parse(a.record.occurredAt));
  const detail = !!row && !!r;
  return (
    <div className="phone">
      {editor ? (
        <Editor
          key={editor.r.id}
          original={editor.r}
          base={editor.base}
          id={identity}
          back={() => setEditor(undefined)}
          saved={changed}
          openStepDay={editor.dailySteps ? openStepDay : undefined}
        />
      ) : detail ? (
        <main className="phone-content">
          <button
            className="back"
            onClick={() => {
              setSelected(undefined);
              setNotice('');
            }}
          >
            <ArrowLeft />
            返回
          </button>
          <h1>{kinds[r.kind]}记录</h1>
          <p className="date-sub">
            {r.kind === 'steps' && r.stepCoverage === 'full'
              ? dayOf(r) + ' · 全天总数'
              : fieldTime(r).replace('T', ' ')}{' '}
            · {r.timezone}
          </p>
          <div className="entry-text">{r.text || localValue(r)}</div>
          {r.text && (r.body || r.steps !== undefined) && (
            <p>
              {[
                r.steps !== undefined ? r.steps + ' 步' : '',
                r.body?.weightKg ? r.body.weightKg + ' kg' : '',
                r.body?.waistCm ? r.body.waistCm + ' cm' : '',
                r.body?.bodyFatPercent ? r.body.bodyFatPercent + '%' : '',
              ]
                .filter(Boolean)
                .join(' / ')}
            </p>
          )}
          {r.portions.length > 0 && (
            <section>
              <h2>已核对的分量</h2>
              {r.portions.map((p, i) => (
                <p key={i}>{portionLabel(p)}</p>
              ))}
            </section>
          )}
          <div className="phone-photos">
            {r.photos.map((p, i) => (
              <PhonePhoto key={photoKey(p, i)} photo={p} index={i} refresh={report?.at} />
            ))}
          </div>
          {['meal', 'training'].includes(r.kind) && (
            <RecordAnalysis key={r.id} row={row} service={analysis} model={model} changed={changed} />
          )}
          <p className="delivery">{deliveryLabel(row.replica, identity.device)}</p>
          {row.replica && (
            <SyncConflict
              replica={row.replica}
              device={identity.device}
              resolve={async (parents, choice, text) =>
                changed(await model.resolve(r.id, parents, choice, text))
              }
            />
          )}
          <div className="actions">
            <button className="secondary" onClick={() => setEditor({ r, base: row })}>
              修改记录
            </button>
            <button
              className="text"
              onClick={async () => {
                try {
                  changed(await model.save({ ...r, deleted: !r.deleted }, stamp(row)));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {r.deleted ? '恢复记录' : '移至最近删除'}
            </button>
          </div>
        </main>
      ) : page === 'energy' || page === 'trends' ? (
        <InsightPage
          page={page}
          view={computed}
          paired={!!identity.archive}
          connect={() => setPage('sync')}
          openDay={(d) => {
            setDate(d);
            showAll(false);
            setTrash(false);
            setPage('journal');
          }}
        />
      ) : page === 'sync' ? (
        <Pairing
          id={identity}
          report={report}
          refresh={reload}
          sync={sync}
          rows={rows}
          open={setSelected}
        />
      ) : (
        <main className="phone-content">
          <header className="book-heading">
            <NotebookPen aria-hidden="true" />
            <h1>身体手记</h1>
          </header>
          <div className="capture">
            {(Object.keys(labels) as PhoneRecord['kind'][]).map((kind) => {
              const Icon = icons[kind];
              return (
                <button key={kind} onClick={() => create(kind)}>
                  <Icon />
                  <span>{labels[kind]}</span>
                </button>
              );
            })}
          </div>
          <section className="timeline">
            <div className="day-heading">
              <h2>{trash ? '最近删除' : '时间线'}</h2>
              <button className="text" onClick={() => setTrash(!trash)}>
                {trash ? (
                  '回到时间线'
                ) : (
                  <>
                    <Trash2 size={16} />
                    最近删除
                  </>
                )}
              </button>
            </div>
            {!trash && (
              <div className="period-control" aria-label="记录时间范围">
                <button aria-pressed={!allDates} onClick={() => showAll(false)}>
                  按日期
                </button>
                <button
                  aria-pressed={allDates}
                  onClick={() => {
                    showAll(true);
                    setLimit(50);
                  }}
                >
                  全部记录
                </button>
              </div>
            )}
            {!trash && !allDates && (
              <div className="day-nav">
                <button aria-label="上一天" onClick={() => setDate(addCalendarDays(date, -1))}>
                  <ChevronLeft />
                </button>
                <input
                  aria-label="查看日期"
                  type="date"
                  value={date}
                  onChange={(e) => {
                    if (e.target.value) setDate(e.target.value);
                  }}
                />
                <button aria-label="下一天" onClick={() => setDate(addCalendarDays(date, 1))}>
                  <ChevronRight />
                </button>
              </div>
            )}
            {visible.slice(0, allDates && !trash ? limit : undefined).map((v) => {
              const entry = v.record;
              return (
                <button
                  className="entry"
                  key={entry.id}
                  onClick={() => {
                    setSelected(entry.id);
                    setNotice('');
                  }}
                >
                  <time>
                    {trash || allDates
                      ? dayOf(entry)
                      : entry.kind === 'steps' && entry.stepCoverage === 'full'
                        ? '全天'
                        : fieldTime(entry).slice(-5)}
                  </time>
                  <span>
                    <small>
                      {kinds[entry.kind]} · {deliveryLabel(v.replica, identity.device)}
                    </small>
                    <strong>{localValue(entry).slice(0, 85)}</strong>
                  </span>
                  <ChevronRight size={16} />
                </button>
              );
            })}
            {allDates && !trash && visible.length > limit && (
              <button className="line-button" onClick={() => setLimit((n) => n + 50)}>
                显示更早的记录
              </button>
            )}
            {!visible.length && (
              <p className="empty">
                {trash
                  ? '还没有删除的记录。'
                  : allDates
                    ? '还没有收到记录。配对后历史记录会自动出现。'
                    : '这一天还没有记录。选「全部记录」可以查看其他日期。'}
              </p>
            )}
          </section>
        </main>
      )}
      {error && (
        <p className="phone-error" role="alert">
          {error}
          <button onClick={() => setError('')}>关闭</button>
        </p>
      )}
      {notice && detail && !editor && (
        <small className="saved-notice" role="status">
          {notice}
        </small>
      )}
      {!editor && !detail && (
        <nav className="phone-tabs" aria-label="主导航">
          <button aria-current={page === 'journal' ? 'page' : undefined} onClick={() => setPage('journal')}>
            <BookOpen />
            手记
          </button>
          <button aria-current={page === 'energy' ? 'page' : undefined} onClick={() => setPage('energy')}>
            <Activity />
            能量
          </button>
          <button aria-current={page === 'trends' ? 'page' : undefined} onClick={() => setPage('trends')}>
            <TrendingUp />
            趋势
          </button>
          <button aria-current={page === 'sync' ? 'page' : undefined} onClick={() => setPage('sync')}>
            <FolderSync />
            同步{report?.issues.length ? ' · 待处理' : ''}
          </button>
        </nav>
      )}
    </div>
  );
}
