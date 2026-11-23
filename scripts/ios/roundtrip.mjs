// Production React UIs and Electron IPC, with system pickers replaced by synthetic input.
// The phone bridge below uses the same on-disk Swift SQLite and file transport as the iOS target.
import { _electron, chromium, expect } from '@playwright/test';
import electron from 'electron';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const dir = mkdtempSync(path.join(tmpdir(), 'bodyjournal-ui-exchange-')),
  shared = path.join(dir, 'cloud'),
  local = path.join(dir, 'phone'),
  vault = path.join(dir, 'mac');
const fixture = JSON.parse(readFileSync('tests/fixtures/device-sync.json', 'utf8'));
const png = Buffer.from(fixture.png, 'base64'),
  photo = { hash: createHash('sha256').update(png).digest('hex'), bytes: png.length, mime: 'image/png' };
const native = path.join(dir, 'phone-test'),
  errors = [];
let app, browser;
try {
  mkdirSync(shared);
  mkdirSync(path.join(local, 'photos'), { recursive: true });
  writeFileSync(path.join(local, 'photos', photo.hash + '.png'), png);
  execFileSync('xcrun', [
    'swiftc',
    '-module-cache-path',
    path.join(tmpdir(), 'bodyjournal-swift-modules'),
    'native/SyncDirectory.swift',
    'native/PhoneDatabase.swift',
    'tests/native/main.swift',
    '-o',
    native,
  ]);
  app = await _electron.launch({
    executablePath: process.env.BODYJOURNAL_APP ?? electron,
    args: process.env.BODYJOURNAL_APP ? [] : [process.cwd()],
    env: { ...process.env, HEALTH_TEST_VAULT: vault },
    timeout: 45000,
  });
  const mac = await app.firstWindow();
  mac.on('pageerror', (e) => errors.push(e.message));
  await mac.getByRole('navigation', { name: '主导航' }).waitFor();
  await app.evaluate(({ dialog, safeStorage }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    // The isolated test profile has no keychain and never contains a user's key.
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    safeStorage.encryptStringAsync = async (value) => Buffer.from(value);
    safeStorage.decryptStringAsync = async (bytes) => ({ result: bytes.toString(), shouldReEncrypt: false });
  }, shared);
  await mac.getByRole('button', { name: '连接与数据' }).click();
  await mac.getByRole('button', { name: '选择空目录并创建档案' }).click();
  await mac.getByRole('button', { name: '显示配对码 / 恢复码' }).click();
  const recovery = await mac.locator('.pairing-code code').innerText();
  const archive = recovery.split('.')[1],
    device = randomUUID();
  await mac.getByRole('button', { name: '收起配对码' }).click();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 1,
  });
  const iphone = await context.newPage();
  iphone.on('pageerror', (e) => errors.push(e.message));
  let connected = false;
  await iphone.exposeFunction('syntheticJournal', (opts) => {
    if (opts.method === 'identity') return { device, archive, enabled: true, folder: '测试目录' };
    if (opts.method === 'folder' && !connected) throw Error('测试设备处于离线状态');
    if (opts.method === 'pick') return { photos: [photo] };
    if (opts.method === 'preview') return { url: 'data:image/png;base64,' + fixture.png };
    return JSON.parse(
      execFileSync(native, [], {
        input: JSON.stringify({ folder: shared, code: recovery, local, ...opts }),
        encoding: 'utf8',
      }),
    );
  });
  await iphone.addInitScript(() => {
    window.webkit = { messageHandlers: { bridge: {} } };
    window.Capacitor = {
      PluginHeaders: [{ name: 'Journal', methods: [{ name: 'request', rtype: 'promise' }] }],
      nativePromise: (_, __, opts) => window.syntheticJournal(opts),
    };
  });
  await iphone.route('https://journal.test/**', (route) => {
    const url = new URL(route.request().url()),
      file = path.join('dist-mobile', url.pathname === '/' ? 'index.html' : url.pathname);
    return route.fulfill({
      body: readFileSync(file),
      contentType: file.endsWith('.js')
        ? 'application/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    });
  });
  await iphone.goto('https://journal.test/');
  await iphone.getByRole('button', { name: '记一餐', exact: true }).click();
  await iphone.getByLabel('原文').fill(fixture.text);
  await iphone.getByRole('button', { name: /添加照片/ }).click();
  await iphone.getByLabel('选入照片 1').check();
  await iphone.getByRole('button', { name: '保存到本机' }).click();
  await expect(iphone.locator('.entry-text')).toHaveText(fixture.text);
  await iphone.reload();
  await iphone.locator('.entry').click();
  await expect(iphone.locator('.entry-text')).toHaveText(fixture.text);
  await expect(iphone.getByRole('button', { name: '查看照片 1' })).toBeVisible();
  connected = true;
  await iphone.getByRole('button', { name: '返回', exact: true }).click();
  await iphone.getByRole('button', { name: /^同步/ }).click();
  await iphone.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(iphone.getByText('最近一次检查')).toBeVisible();
  await expect.poll(() => readdirSync(shared).filter((f) => f.startsWith('op-')).length).toBe(1);
  await mac.getByRole('button', { name: '立即同步', exact: true }).click();
  await expect
    .poll(
      async () =>
        await mac.evaluate(
          async () => (await window.health.invoke('records:list', { limit: 20 })).items.length,
        ),
    )
    .toBe(1);
  await mac.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /记录/ }).click();
  await mac.locator('.record-row').filter({ hasText: fixture.text }).click();
  const detail = mac.getByRole('dialog');
  await detail.getByRole('button', { name: '补充 / 修正食材和分量' }).click();
  await detail.getByRole('button', { name: '添加食材' }).click();
  await detail.getByPlaceholder('搜索食材中英文名称或 FDC 编号').fill('米饭');
  await detail.locator('.food-results button').filter({ hasText: '米饭' }).first().click();
  await detail.getByLabel('实际吃下的比例').selectOption('0.5');
  await detail.getByRole('button', { name: '保存并重新计算' }).click();
  await expect(detail.getByRole('button', { name: '保存并重新计算' })).toHaveCount(0);
  await mac.evaluate(() => window.health.invoke('device:sync'));
  await iphone.getByRole('button', { name: '立即同步' }).click();
  await expect(iphone.getByRole('button', { name: '立即同步' })).toBeEnabled();
  await iphone.getByRole('button', { name: '手记', exact: true }).click();
  await expect(iphone.locator('.entry')).toHaveCount(1);
  await iphone.locator('.entry').click();
  await expect(iphone.getByText(/米饭.*吃了一半/)).toBeVisible();
  await expect(iphone.getByRole('button', { name: '查看照片 1' })).toBeVisible();
  if (process.env.BODYJOURNAL_SCREENSHOT)
    await iphone.screenshot({ path: process.env.BODYJOURNAL_SCREENSHOT });
  await iphone.getByRole('button', { name: '返回', exact: true }).click();
  await iphone.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(iphone.locator('.entry')).toHaveCount(1);
  await iphone.getByRole('button', { name: '能量', exact: true }).click();
  await expect(iphone.getByRole('heading', { name: '已记录摄入' })).toBeVisible();
  await expect(iphone.getByText(/1 餐记录，1 餐已估算/)).toBeVisible();
  if (process.env.BODYJOURNAL_SCREENSHOT)
    await iphone.screenshot({ path: process.env.BODYJOURNAL_SCREENSHOT.replace('.png', '-energy.png') });
  await iphone.getByRole('button', { name: '趋势', exact: true }).click();
  await iphone.getByLabel('趋势指标').selectOption('intake');
  await expect(iphone.getByRole('img', { name: /摄入趋势/ })).toBeVisible();
  if (process.env.BODYJOURNAL_SCREENSHOT)
    await iphone.screenshot({ path: process.env.BODYJOURNAL_SCREENSHOT.replace('.png', '-trends.png') });
  const overflow = await iphone.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow || errors.length) throw Error('布局或脚本错误 ' + errors.join(' / '));
  console.log('五个录入入口已加载。手机离线选图保存、重开、Mac 食材编辑器修正、手机同条记录回读及照片通过。');
} finally {
  await browser?.close();
  await app?.close();
  rmSync(dir, { force: true, recursive: true });
}
