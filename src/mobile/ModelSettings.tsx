import { useEffect, useState } from 'react';
import { MobileModels } from './models';
import sample from '../../assets/connection-test.png?inline';

export function ModelSettings({ models }: { models: MobileModels }) {
  const [settings, set] = useState(() => models.settings()),
    [connected, connect] = useState({ chatgpt: false, deepseek: false });
  const [key, setKey] = useState(''),
    [busy, working] = useState(false),
    [message, show] = useState('');
  const refresh = async () => {
    set(models.settings());
    connect(await models.status());
  };
  useEffect(() => {
    void refresh().catch((e) => show(e.message));
  }, [models]);
  async function action(task: () => Promise<void>) {
    working(true);
    show('');
    try {
      await task();
    } catch (e) {
      show((e as Error).message);
    } finally {
      set(models.settings());
      void models
        .status()
        .then(connect)
        .catch(() => {});
      working(false);
    }
  }
  const p = settings.provider,
    usage = settings.usage[p];
  return (
    <details className="phone-model">
      <summary>手机分析</summary>
      <fieldset disabled={busy}>
        <label>
          使用的服务
          <select
            value={p}
            onChange={(e) => {
              models.configure({ provider: e.target.value as typeof p });
              set(models.settings());
              show('');
            }}
          >
            <option value="chatgpt">ChatGPT 订阅</option>
            <option value="deepseek">DeepSeek API</option>
          </select>
        </label>
        {p === 'chatgpt' ? (
          <>
            <button className="secondary" onClick={() => action(() => models.login())}>
              {connected.chatgpt ? '重新授权' : '登录 ChatGPT'}
            </button>
            {connected.chatgpt && (
              <>
                <button onClick={() => action(() => models.models())}>刷新模型</button>
                <label>
                  订阅模型
                  <select
                    value={settings.model}
                    onChange={(e) => {
                      models.configure({ model: e.target.value });
                      set(models.settings());
                    }}
                  >
                    {settings.models.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <button onClick={() => action(() => models.disconnect())}>断开本机授权</button>
              </>
            )}
          </>
        ) : (
          <>
            <label>
              本机 API 密钥
              <input
                type="password"
                autoComplete="off"
                value={key}
                placeholder={connected.deepseek ? '已保存，可输入新密钥' : '输入自己的 DeepSeek 密钥'}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <button
              disabled={!key.trim()}
              onClick={() =>
                action(async () => {
                  await models.key(key);
                  setKey('');
                  show('密钥已保存');
                })
              }
            >
              保存密钥
            </button>
            {connected.deepseek && (
              <button
                onClick={() =>
                  action(async () => {
                    await models.key('');
                    setKey('');
                  })
                }
              >
                移除密钥
              </button>
            )}
          </>
        )}
        <button
          disabled={!connected[p]}
          onClick={() =>
            action(async () => {
              const challenge = String(crypto.getRandomValues(new Uint32Array(1))[0]);
              const a = await models.infer('按指令回答', '请只重复这串数字 ' + challenge, []);
              if (a.text.trim() !== challenge) throw Error('文字测试未通过。');
              const b = await models.infer('请用中文回答。', '请描述图片的主色以及图案。', [sample]);
              if (!b.text.trim()) throw Error('图片未返回描述。');
              models.configure({ tests: { ...models.settings().tests, [p]: new Date().toISOString() } });
              show('文字通过。测试图的回答：' + b.text);
            })
          }
        >
          测试文字和图片
        </button>
        <p>
          本机不限额 · {usage?.calls ?? 0} 次已完成 · 输入 {usage?.input ?? 0} / 输出 {usage?.output ?? 0}{' '}
          token
        </p>
        {settings.tests[p] && <small>上次图文测试 {new Date(settings.tests[p]!).toLocaleString()}</small>}
        {busy && <p role="status">正在连接…</p>}
        {message && <p role="status">{message}</p>}
      </fieldset>
    </details>
  );
}
