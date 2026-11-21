import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  deliveryLabel,
  heads,
  portionLabel,
  type RecordSyncInfo,
  type SyncSettings,
} from '../shared/device-sync';
import type { HealthRecord } from '../shared/types';
import { SyncConflict } from './SyncConflict';
type Run = <T = unknown>(action: string, payload?: unknown) => Promise<T>;
export function DeviceSettings({ run, onSource }: { run: Run; onSource: (id: string) => void }) {
  const [status, set] = useState<SyncSettings>(),
    [key, setKey] = useState(''),
    [qr, setQr] = useState(''),
    [join, setJoin] = useState(false),
    [input, setInput] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      window.health
        .invoke<SyncSettings>('device:status')
        .then((s) => {
          if (live) set(s);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    void load();
    const off = window.health.onEvent((e) => {
      if (e.type === 'device-sync') void load();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const act = async (action: string, payload?: unknown) => {
    setBusy(true);
    setError('');
    try {
      set(await run<SyncSettings>(action, payload));
      setJoin(false);
      setInput('');
      setKey('');
      setQr('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section">
      <h2>iPhone 双向同步</h2>
      <p>
        在 iCloud Drive
        选择专用目录。配对后，可在每条记录的详情预览并选入原文、时间、人工分量和指定餐食照片。身体测量、步数和运动截图留在本机。
      </p>
      {status?.archive && (
        <p>
          {status.enabled ? '已启用' : '已暂停'} · {status.folder?.split('/').at(-1)} · {status.pending}{' '}
          个待发修改
        </p>
      )}
      <div className="button-row wrap">
        {!status?.archive && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => act('device:configure', { mode: 'create' })}
          >
            选择空目录并创建档案
          </button>
        )}
        {status?.archive && (
          <>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => act('device:configure', { mode: 'reconnect' })}
            >
              重选原目录
            </button>
            <button
              className="button secondary"
              disabled={busy || !status.enabled}
              onClick={() => act('device:sync')}
            >
              立即同步
            </button>
            <button
              className="text-button"
              onClick={async () => {
                if (key) {
                  setKey('');
                  setQr('');
                  return;
                }
                try {
                  const k = await run<string>('device:code');
                  setQr(await QRCode.toDataURL(k, { width: 220, margin: 2 }));
                  setKey(k);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {key ? '收起配对码' : '显示配对码 / 恢复码'}
            </button>
            {status.enabled && (
              <button className="text-button" disabled={busy} onClick={() => act('device:pause')}>
                暂停同步
              </button>
            )}
          </>
        )}
        <button className="text-button" onClick={() => setJoin(!join)}>
          用恢复码连接
        </button>
      </div>
      {join && (
        <label className="field">
          原档案恢复码
          <input
            autoComplete="off"
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            className="button secondary"
            disabled={!input || busy}
            onClick={() => act('device:configure', { mode: 'join', code: input })}
          >
            选择对应目录
          </button>
        </label>
      )}
      {key && (
        <div className="pairing-code">
          <img alt="档案配对二维码" src={qr} />
          <div>
            <p>在 iPhone 的「同步」页面扫码。恢复码可解密整个共享档案，请单独保管。</p>
            <code>{key}</code>
          </div>
        </div>
      )}
      {status?.report && (
        <div aria-live="polite">
          <p>
            上次检查 {new Date(status.report.at).toLocaleTimeString()}，{status.report.waiting} 项等待补齐。
          </p>
          {status.report.issues.map((s) => (
            <p key={s}>{s}</p>
          ))}
        </div>
      )}
      {status?.conflicts.map((id) => (
        <button key={id} onClick={() => onSource(id)}>
          处理记录冲突 · {id.slice(-8)}
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function DeviceRecord({ r, run, photos }: { r: HealthRecord; run: Run; photos: string[] }) {
  const [info, set] = useState<RecordSyncInfo>(),
    [checked, select] = useState<number[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const load = () =>
      window.health
        .invoke<RecordSyncInfo>('device:info', { id: r.id })
        .then((v) => {
          if (live) set(v);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    void load();
    const off = window.health.onEvent((e) => {
      if (e.type === 'device-sync') void load();
    });
    return () => {
      live = false;
      off();
    };
  }, [r.id, r.revision]);
  if (!info?.archive || !info.eligible) return null;
  const rep = info.replica,
    tip = rep && heads(rep)[0];
  return (
    <details className="device-record" open={(rep && heads(rep).length > 1) || undefined}>
      <summary>iPhone 同步 · {deliveryLabel(rep, info.device)}</summary>
      {rep ? (
        <>
          {tip?.record.portions.map((p, i) => (
            <p key={i}>{portionLabel(p)}</p>
          ))}
          {info.missing.map((i) => (
            <p key={i}>第 {i} 张照片下载中</p>
          ))}
          <SyncConflict
            replica={rep}
            device={info.device}
            resolve={async (parents, choice, text) =>
              set(await run('device:resolve', { id: r.id, parents, choice, text }))
            }
          />
        </>
      ) : (
        <>
          <p>
            选入当前原文、类别、发生时间、时区和人工确认的餐食分量。之后在任一端修改、删除或恢复，另一端也会收到。
          </p>
          <blockquote>{r.text}</blockquote>
          {info.photos.map((p, i) => (
            <label key={i} className="sync-photo">
              <input
                type="checkbox"
                checked={checked.includes(i)}
                onChange={(e) => select(e.target.checked ? [...checked, i] : checked.filter((n) => n !== i))}
              />
              {photos[i] && <img src={photos[i]} alt="" />}照片 {i + 1}（{Math.ceil(p.bytes / 1024)} KB）
            </label>
          ))}
          <button
            className="button secondary"
            onClick={async () => {
              try {
                set(await run('device:enroll', { id: r.id, revision: r.revision, photos: checked }));
                setError('');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            选入这条记录
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
