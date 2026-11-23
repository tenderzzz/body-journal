import { useState } from 'react';
import { Activity, ChevronLeft, ChevronRight, TrendingUp } from 'lucide-react';
import { addCalendarDays } from '../shared/dates';
import type { PhoneInsights, InsightDay } from '../shared/phone-insights';
import type { Range } from '../shared/types';

const numeric = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
function amount(r: Range | null | undefined, unit: string) {
  if (!r) return '暂无估算';
  const low = Math.round(r.low),
    high = Math.round(r.high);
  return (low === high ? numeric.format(low) : numeric.format(low) + '–' + numeric.format(high)) + ' ' + unit;
}
const short = (date: string) => Number(date.slice(5, 7)) + '/' + Number(date.slice(8));
const midpoint = (r: Range | null | undefined) => (r ? (r.low + r.high) / 2 : null);
const byDate = (days: InsightDay[]) => new Map(days.map((d) => [d.date, d]));
function Energy({ view, openDay }: { view: PhoneInsights; openDay: (date: string) => void }) {
  const [selected, select] = useState('');
  const { today, civilToday } = view.manifest,
    date = selected || today,
    index = byDate(view.days),
    d = index.get(date);
  const week = Array.from({ length: 7 }, (_, i) => addCalendarDays(date, i - 6));
  const max = Math.max(
    1,
    ...week.flatMap((key) => [
      midpoint(index.get(key)?.intake) ?? 0,
      midpoint(index.get(key)?.expenditure) ?? 0,
    ]),
  );
  const stepDate = date === today ? civilToday : date,
    stepDay = index.get(stepDate);
  return (
    <>
      <div className="day-nav">
        <button aria-label="能量上一天" onClick={() => select(addCalendarDays(date, -1))}>
          <ChevronLeft />
        </button>
        <input
          type="date"
          aria-label="能量日期"
          value={date}
          max={today}
          onChange={(e) => {
            if (e.target.value && e.target.value <= today) select(e.target.value);
          }}
        />
        <button
          aria-label="能量下一天"
          disabled={date >= today}
          onClick={() => select(addCalendarDays(date, 1))}
        >
          <ChevronRight />
        </button>
      </div>
      <section className="energy-reading" aria-label="当日能量">
        <h2>已记录摄入</h2>
        <strong>{amount(d?.intake, 'kcal')}</strong>
        <p>
          {d?.meals ? `${d.meals} 餐记录，${d.estimatedMeals} 餐已估算` : '当天还没有餐食记录'}
          {d?.mealComplete ? ' · 餐食已记齐' : ''}
        </p>
        <dl>
          <div>
            <dt>估算消耗</dt>
            <dd>{amount(d?.expenditure, 'kcal')}</dd>
          </div>
          <div>
            <dt>能量差额</dt>
            <dd>{d?.balance ? amount(d.balance, 'kcal') : '待补齐记录'}</dd>
          </div>
          <div>
            <dt>饮食目标</dt>
            <dd>{d?.targetKcal == null ? '尚未设置' : numeric.format(d.targetKcal) + ' kcal'}</dd>
          </div>
        </dl>
      </section>
      <section className="insight-section">
        <h2>近 7 天能量</h2>
        <p className="chart-key">
          <span>摄入</span>
          <span>消耗</span>
          <small>柱高取估算区间中点</small>
        </p>
        <div className="week-bars">
          {week.map((key) => {
            const row = index.get(key);
            return (
              <button
                key={key}
                aria-label={
                  key + '，摄入 ' + amount(row?.intake, 'kcal') + '，消耗 ' + amount(row?.expenditure, 'kcal')
                }
                aria-pressed={key === date}
                onClick={() => select(key)}
              >
                <span>
                  {[row?.intake, row?.expenditure].map(
                    (v, i) =>
                      v && (
                        <i
                          key={i}
                          data-series={i}
                          style={{ height: Math.max(1, ((midpoint(v) ?? 0) / max) * 100) + '%' }}
                        />
                      ),
                  )}
                </span>
                <small>{short(key)}</small>
              </button>
            );
          })}
        </div>
      </section>
      <section className="insight-section">
        <h2>营养与活动</h2>
        <dl className="reading-list">
          <div>
            <dt>蛋白质</dt>
            <dd>
              {amount(d?.protein, 'g')}
              {d?.targetProtein != null && <small>目标 {d.targetProtein} g</small>}
            </dd>
          </div>
          <div>
            <dt>碳水化合物</dt>
            <dd>{amount(d?.carbs, 'g')}</dd>
          </div>
          <div>
            <dt>脂肪</dt>
            <dd>{amount(d?.fat, 'g')}</dd>
          </div>
          <div>
            <dt>
              {stepDay?.stepScope === 'nonTraining' ? '非训练步数' : '步数'} <small>{short(stepDate)}</small>
            </dt>
            <dd>
              {stepDay?.steps == null
                ? stepDay?.stepConflict
                  ? '来源待核对'
                  : '未记录'
                : numeric.format(stepDay.steps) + ' 步'}
              {stepDay?.steps != null && (
                <small>{stepDay.stepCoverage === 'partial' ? '截至记录时' : '全天'}</small>
              )}
            </dd>
          </div>
        </dl>
        <button className="line-button insight-link" onClick={() => openDay(date)}>
          查看当天手记
          <ChevronRight size={16} />
        </button>
      </section>
    </>
  );
}
const metrics = {
  weight: ['体重', 'kg'],
  waist: ['腰围', 'cm'],
  bodyFat: ['体脂率', '%'],
  intake: ['摄入', 'kcal'],
  expenditure: ['消耗', 'kcal'],
  protein: ['蛋白质', 'g'],
  steps: ['步数', '步'],
} as const;
type Metric = keyof typeof metrics;
function Trends({ view, openDay }: { view: PhoneInsights; openDay: (date: string) => void }) {
  const [range, setRange] = useState(30),
    [metric, setMetric] = useState<Metric>('weight');
  const last = metric === 'steps' ? view.manifest.civilToday : view.manifest.today;
  const from = range
    ? addCalendarDays(last, 1 - range)
    : (view.days.find((d) => {
        const v = d[metric];
        return v != null || d.strength || d.cardio;
      })?.date ?? last);
  const days = view.days.filter((d) => d.date >= from && d.date <= last);
  const points = days.flatMap((d) => {
    const v = d[metric],
      value = typeof v === 'object' ? midpoint(v) : v;
    return value == null ? [] : [{ date: d.date, value }];
  });
  const [label, unit] = metrics[metric],
    latest = points.at(-1);
  const values = points.map((p) => p.value);
  const low = values.length ? Math.min(...values) : 0,
    high = values.length ? Math.max(...values) : 0;
  const duration = Math.max(86400000, Date.parse(last) - Date.parse(from));
  const x = (date: string) => 8 + (284 * (Date.parse(date) - Date.parse(from))) / duration;
  const y = (v: number) => (low === high ? 47 : 84 - (71 * (v - low)) / (high - low));
  const summary = days.reduce(
    (s, d) => ({
      strength: s.strength + d.strength,
      sets: s.sets + d.workSets,
      cardio: s.cardio + d.cardio,
      km: s.km + d.cardioKm,
    }),
    { strength: 0, sets: 0, cardio: 0, km: 0 },
  );
  return (
    <>
      <div className="period-control" aria-label="趋势时间范围">
        {[7, 30, 90, 0].map((n) => (
          <button key={n} aria-pressed={range === n} onClick={() => setRange(n)}>
            {n ? n + ' 天' : '全部'}
          </button>
        ))}
      </div>
      <section className="trend-reading">
        <label>
          查看指标
          <select aria-label="趋势指标" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {Object.entries(metrics).map(([key, [name]]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {latest ? (
          <>
            <p className="trend-value">
              <strong>{numeric.format(latest.value)}</strong> {unit}
            </p>
            <p className="muted">
              {short(latest.date)} 最近一次
              {['intake', 'protein', 'expenditure'].includes(metric) ? '估算 · 区间中点' : '记录'}
            </p>
            <svg
              className="trend-plot"
              viewBox="0 0 300 94"
              role="img"
              aria-label={
                label +
                '趋势，' +
                points.length +
                ' 个有数据的日期，范围 ' +
                numeric.format(low) +
                ' 至 ' +
                numeric.format(high) +
                ' ' +
                unit
              }
            >
              {[13, 48, 84].map((v) => (
                <line key={v} x1="4" x2="296" y1={v} y2={v} />
              ))}
              {points.length > 1 && (
                <polyline points={points.map((p) => x(p.date) + ',' + y(p.value)).join(' ')} />
              )}
              {points.map((p) => (
                <circle key={p.date} cx={x(p.date)} cy={y(p.value)} r="2.7" />
              ))}
            </svg>
            <div className="plot-dates">
              <span>{short(from)}</span>
              <span>{points.length} 天有数据</span>
              <span>{short(last)}</span>
            </div>
            <details className="trend-details">
              <summary>查看每日数值</summary>
              {[...points].reverse().map((p) => (
                <button className="line-button insight-link" key={p.date} onClick={() => openDay(p.date)}>
                  {p.date}
                  <strong>
                    {numeric.format(p.value)} {unit}
                  </strong>
                </button>
              ))}
            </details>
          </>
        ) : (
          <p className="empty">这段时间还没有{label}数据。</p>
        )}
      </section>
      <section className="insight-section">
        <h2>已完成训练</h2>
        <dl className="reading-list">
          <div>
            <dt>力量训练</dt>
            <dd>
              {summary.strength} 次 · {summary.sets} 个工作组
            </dd>
          </div>
          <div>
            <dt>有氧运动</dt>
            <dd>
              {summary.cardio} 次{summary.km > 0 ? ' · ' + numeric.format(summary.km) + ' km' : ''}
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
export function InsightPage({
  page,
  view,
  paired,
  openDay,
  connect,
}: {
  page: 'energy' | 'trends';
  view: PhoneInsights | null;
  paired: boolean;
  openDay: (date: string) => void;
  connect: () => void;
}) {
  return (
    <main className="phone-content insights">
      <header className="book-heading">
        {page === 'energy' ? <Activity /> : <TrendingUp />}
        <h1>{page === 'energy' ? '每天的能量' : '看见变化'}</h1>
      </header>
      {view ? (
        <>
          <p className="insight-time">
            Mac 更新于{' '}
            {new Date(view.manifest.updated).toLocaleString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
          {page === 'energy' ? (
            <Energy view={view} openDay={openDay} />
          ) : (
            <Trends view={view} openDay={openDay} />
          )}
        </>
      ) : (
        <section className="insight-section">
          <h2>{paired ? '等待 Mac 的统计' : '连接你的 Mac'}</h2>
          <p>
            {paired
              ? '打开更新后的 Mac 版「身体手记」，首次统计会通过已配对的文件夹自动送达。'
              : '在「同步」连接 Mac 的档案后，即可查看历史能量与趋势。'}
          </p>
          <button className="secondary" onClick={connect}>
            查看同步状态
          </button>
        </section>
      )}
    </main>
  );
}
