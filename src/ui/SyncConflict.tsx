import { useState } from 'react';
import { heads, portionLabel, type Replica } from '../shared/device-sync';
export function SyncConflict({
  replica,
  device,
  resolve,
}: {
  replica: Replica;
  device: string;
  resolve: (parents: string[], choice: string, text?: string) => Promise<void>;
}) {
  const tips = heads(replica);
  const [choice, setChoice] = useState(''),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  if (tips.length < 2) return null;
  const selected = tips.find((o) => o.id === choice);
  return (
    <section className="sync-conflict">
      <h3>两端都改过这条记录</h3>
      <p>选定要保留的版本，也可以合并文字。</p>
      {tips.map((op) => (
        <label key={op.id}>
          <input
            type="radio"
            name={'conflict-' + op.record.id}
            checked={op.id === choice}
            onChange={() => {
              setChoice(op.id);
              setText(op.record.text);
            }}
          />
          <span>
            <strong>
              {op.device === device ? '这台设备' : '另一台设备'} · {op.record.deleted ? '已删除' : '保留记录'}
            </strong>
            <br />
            {new Date(op.record.occurredAt).toLocaleString('zh-CN', { timeZone: op.record.timezone })}
            <br />
            {op.record.text}
            {op.record.steps !== undefined && (
              <small>
                {op.record.steps} 步 · {op.record.stepCoverage === 'full' ? '全天' : '截至记录时'}
              </small>
            )}
            {op.record.body && (
              <small>
                {[
                  op.record.body.weightKg && op.record.body.weightKg + ' kg',
                  op.record.body.waistCm && op.record.body.waistCm + ' cm',
                  op.record.body.bodyFatPercent && op.record.body.bodyFatPercent + '%',
                ]
                  .filter(Boolean)
                  .join(' / ')}
              </small>
            )}
            {op.record.portions.map((p, i) => (
              <small key={i}>{portionLabel(p)}</small>
            ))}
          </span>
        </label>
      ))}
      {selected && (
        <label>
          合并后的文字
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      <button
        className="button secondary"
        disabled={!selected || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await resolve(
              tips.map((t) => t.id),
              choice,
              text,
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        保存合并版本
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
