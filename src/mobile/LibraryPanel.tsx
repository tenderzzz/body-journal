import { useEffect, useState } from 'react';
import type { PhoneJournalModel } from './journal';
import type { Message } from '../shared/types';
export function LibraryPanel({
  model,
  sync,
  at,
}: {
  model: PhoneJournalModel;
  sync: () => Promise<void>;
  at?: string;
}) {
  const [inventory, set] = useState<Awaited<ReturnType<PhoneJournalModel['migrationPreview']>>>(),
    [messages, view] = useState<Message[] | null>(null);
  const [progress, progressTo] = useState<Awaited<ReturnType<PhoneJournalModel['progress']>>>();
  useEffect(() => {
    void model
      .progress()
      .then(progressTo)
      .catch(() => {});
  }, [model, at]);
  const [error, show] = useState(''),
    [busy, work] = useState(false);
  const action = async (fn: () => Promise<void>) => {
    work(true);
    show('');
    try {
      await fn();
    } catch (e) {
      show((e as Error).message);
    } finally {
      work(false);
    }
  };
  return (
    <details className="phone-model">
      <summary>历史档案</summary>
      <fieldset disabled={busy}>
        {progress?.phase && (
          <p>
            {progress.phase.phase} · {new Date(progress.phase.at).toLocaleTimeString()}
            {progress.revisions > 0 &&
              ' · ' + progress.revisions + ' 个历史版本 · 原照片 ' + progress.photos + '/' + progress.total}
          </p>
        )}
        <button onClick={() => action(async () => set(await model.migrationPreview()))}>
          备份并查看手机清单
        </button>
        {inventory && (
          <>
            <p>
              本机备份已保存。{inventory.records} 条记录 · {inventory.photos} 张原照片 · {inventory.pending}{' '}
              条待发送记录。
            </p>
            {!inventory.confirmed && (
              <button
                onClick={() =>
                  action(async () => {
                    await model.confirmMigration();
                    set(await model.migrationPreview());
                    await sync();
                  })
                }
              >
                确认与 Mac 合并历史和原照片
              </button>
            )}
            {inventory.confirmed && <p>手机已确认历史迁移。</p>}
          </>
        )}
        <button onClick={() => action(async () => view((await model.library())?.messages ?? []))}>
          查阅旧对话
        </button>
        {messages &&
          (messages.length ? (
            messages.map((m) => (
              <details key={m.id}>
                <summary>
                  {new Date(m.createdAt).toLocaleDateString()} · {m.role === 'user' ? '我' : '助理'} ·{' '}
                  {m.text.slice(0, 32)}
                </summary>
                <p className="entry-text">{m.text}</p>
              </details>
            ))
          ) : (
            <p>本机还没有旧对话，完成历史迁移后可在这里查阅。</p>
          ))}
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </details>
  );
}
