import { newDeviceUUID } from '../shared/device-sync';
import { readOpenAI, readDeepSeek, providerError } from '../../electron/ai/transport';
import type { Provider } from '../shared/types';
import type { PhoneJournalModel } from './journal';

const resource = 'https://api.openai.com/v1';
const direct = 'chatgpt.tokens.use.direct';
type Registration = {
  client: string;
  sub: string;
  access: string;
  refresh?: string;
  expires: number;
  scope: string;
};
type Token = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
};
const url64 = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const salt = () => url64(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
function decode(s: string) {
  const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
}
type Preference = {
  provider: Provider;
  model: string;
  models: string[];
  usage: Partial<Record<Provider, { calls: number; input: number; output: number }>>;
  tests: Partial<Record<Provider, string>>;
};
const settingsKey = 'bodyjournal.model.preferences.v1';
export class MobileModels {
  constructor(private phone: Pick<PhoneJournalModel, 'call'>) {}
  settings(): Preference {
    return {
      provider: 'chatgpt',
      model: '',
      models: [],
      usage: {},
      tests: {},
      ...JSON.parse(localStorage.getItem(settingsKey) || '{}'),
    };
  }
  configure(update: Partial<Preference>) {
    localStorage.setItem(settingsKey, JSON.stringify({ ...this.settings(), ...update }));
  }
  private async read(name: string) {
    return (await this.phone.call<{ value: string | null }>('modelRead', { name })).value;
  }
  private write(name: string, value: string) {
    return this.phone.call('modelWrite', { name, value });
  }
  private async registration(): Promise<Registration | undefined> {
    const raw = await this.read('registration');
    return raw ? JSON.parse(raw) : undefined;
  }
  async status() {
    const reg = await this.registration();
    return {
      chatgpt: !!reg?.access && reg.scope.split(' ').includes(direct),
      deepseek: !!(await this.read('deepseek')),
    };
  }
  async key(value: string) {
    await this.write('deepseek', value.trim());
  }
  async disconnect() {
    await this.write('registration', '');
    this.configure({ models: [], model: '', tests: { ...this.settings().tests, chatgpt: undefined } });
  }
  private async request(route: string, body?: string, bearer?: string) {
    const reply = await this.phone.call<{ status: number; body: string }>('modelFetch', {
      route,
      body,
      bearer,
    });
    return new Response(reply.body, { status: reply.status });
  }
  private async token(params: Record<string, string>): Promise<Token> {
    const r = await this.request('token', new URLSearchParams({ ...params, resource }).toString());
    if (!r.ok) throw Error('ChatGPT 授权或续期失败（' + r.status + '），请重新登录。');
    const t = await r.json();
    if (typeof t.access_token !== 'string' || !t.access_token) throw Error('账号没有返回使用凭据。');
    return t;
  }
  async login() {
    const old = await this.registration();
    let host = await this.read('host');
    if (!host) {
      host = 'urn:uuid:' + newDeviceUUID();
      await this.write('host', host);
    }
    const state = salt(),
      nonce = salt(),
      verifier = salt();
    const digest = await this.phone.call<{ base64: string }>('modelDigest', { text: verifier });
    const params = {
      client_id: old?.client || 'dynamic_agent_client',
      ext_agent_host_id: host,
      response_type: 'code',
      scope: 'openid profile email offline_access resource.invoke ' + direct,
      resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: url64(digest.base64),
      ...(!old ? { agent_name_hint: 'Body Journal' } : {}),
    };
    const { callback, redirect } = await this.phone.call<{ callback: string; redirect: string }>(
      'modelAuthorize',
      { params },
    );
    const url = new URL(callback, redirect),
      target = new URL(redirect);
    if (
      target.protocol !== 'http:' ||
      target.hostname !== '127.0.0.1' ||
      url.origin !== target.origin ||
      url.pathname !== '/auth/callback' ||
      url.searchParams.get('state') !== state
    )
      throw Error('登录回调校验失败。');
    const client = url.searchParams.get('client_id') || old?.client,
      code = url.searchParams.get('code');
    if (
      url.searchParams.has('error') ||
      !code ||
      !client ||
      client === 'dynamic_agent_client' ||
      (old && old.client !== client)
    )
      throw Error('登录未完成，请检查账号授权后重试。');
    const t = await this.token({
      grant_type: 'authorization_code',
      client_id: client,
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
    });
    const parts = t.id_token?.split('.');
    if (parts?.length !== 3) throw Error('登录未返回身份签名。');
    const header = decode(parts[0]);
    const response = await this.request('keys');
    if (!response.ok) throw Error('暂时无法验证身份签名。');
    const keys = (await response.json()).keys as {
      kid: string;
      kty: string;
      alg?: string;
      use?: string;
      n: string;
      e: string;
    }[];
    const key = keys.find(
      (k) =>
        k.kid === header.kid &&
        k.kty === 'RSA' &&
        (!k.use || k.use === 'sig') &&
        (!k.alg || k.alg === 'RS256'),
    );
    if (header.alg !== 'RS256' || !key || header.crit) throw Error('身份签名密钥不受支持。');
    await this.phone.call('modelVerify', {
      n: key.n,
      e: key.e,
      signed: parts.slice(0, 2).join('.'),
      signature: parts[2],
    });
    const p = decode(parts[1]),
      now = Date.now() / 1000,
      aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (
      p.iss !== 'https://auth.openai.com' ||
      !aud.includes(client) ||
      (aud.length > 1 && p.azp !== client) ||
      p.nonce !== nonce ||
      typeof p.exp !== 'number' ||
      p.exp < now - 5 ||
      typeof p.iat !== 'number' ||
      p.iat > now + 5 ||
      (p.nbf !== undefined && p.nbf > now + 5) ||
      typeof p.sub !== 'string' ||
      !p.sub ||
      (old && p.sub !== old.sub)
    )
      throw Error('登录身份或有效期校验失败。');
    if (!t.scope?.split(' ').includes(direct))
      throw Error('账号没有授权订阅额度，请在 ChatGPT 授权页检查权限。');
    await this.write(
      'registration',
      JSON.stringify({
        client,
        sub: p.sub,
        access: t.access_token,
        refresh: t.refresh_token,
        expires: Date.now() + 1000 * (t.expires_in ?? 3600),
        scope: t.scope,
      } satisfies Registration),
    );
    await this.models();
  }
  private refreshing?: Promise<string>;
  private async access(): Promise<string> {
    const r = await this.registration();
    if (!r?.scope.split(' ').includes(direct))
      throw Error('请在「同步 → 手机分析」登录 ChatGPT 并允许使用订阅额度。');
    if (r.expires > Date.now() + 60000) return r.access;
    if (!r.refresh) throw Error('请重新登录 ChatGPT。');
    if (!this.refreshing)
      this.refreshing = (async () => {
        const t = await this.token({
          grant_type: 'refresh_token',
          client_id: r.client,
          refresh_token: r.refresh!,
        });
        const scope = t.scope ?? r.scope;
        await this.write(
          'registration',
          JSON.stringify({
            ...r,
            scope,
            refresh: t.refresh_token ?? r.refresh,
            access: t.access_token,
            expires: Date.now() + 1000 * (t.expires_in ?? 3600),
          }),
        );
        if (!scope.split(' ').includes(direct)) throw Error('订阅额度授权已失效，请重新登录。');
        return t.access_token;
      })().finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  async models() {
    const r = await this.request('models', undefined, await this.access());
    if (!r.ok) throw providerError(String(r.status));
    const models = (await r.json()).models
      ?.filter(
        (m: { visibility: string; slug: string }) => m.visibility === 'list' && typeof m.slug === 'string',
      )
      .map((m: { slug: string }) => m.slug) as string[] | undefined;
    if (!models?.length) throw Error('此账号暂时没有可用模型。');
    const prior = this.settings().model;
    this.configure({ models, model: models.includes(prior) ? prior : models[0] });
  }
  async infer(instructions: string, text: string, images: string[]) {
    const { provider, model: selected } = this.settings(),
      open = provider === 'chatgpt';
    const model = open ? selected : 'deepseek-flash';
    if (!model) throw Error('请先在「同步 → 手机分析」选择账号可用的模型。');
    const bearer = open ? await this.access() : await this.read('deepseek');
    if (!bearer) throw Error('请先在手机分析设置填写自己的 DeepSeek 密钥。');
    const body = open
      ? {
          model,
          instructions,
          store: false,
          stream: true,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text },
                ...images.map((image_url) => ({ type: 'input_image', image_url })),
              ],
            },
          ],
        }
      : {
          model,
          messages: [
            { role: 'system', content: instructions },
            {
              role: 'user',
              content: [
                { type: 'text', text },
                ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
              ],
            },
          ],
          thinking: { type: 'disabled' },
          max_tokens: 6144,
          stream: true,
          stream_options: { include_usage: true },
        };
    const r = await this.request(open ? 'responses' : 'deepseek', JSON.stringify(body), bearer);
    const result = await (open ? readOpenAI : readDeepSeek)(r, () => {});
    const usage = this.settings().usage,
      prior = usage[provider] ?? { calls: 0, input: 0, output: 0 };
    this.configure({
      usage: {
        ...usage,
        [provider]: {
          calls: prior.calls + 1,
          input: prior.input + result.input,
          output: prior.output + result.output,
        },
      },
    });
    return { ...result, provider, model };
  }
}
