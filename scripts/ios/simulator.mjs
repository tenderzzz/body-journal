// A device ID in the private SQLite is created only when the bundled React UI calls the Swift bridge.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { checkRecordForms } from './check-record-forms.mjs';

const output = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const devices = JSON.parse(output('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices;
const simulator = Object.entries(devices)
  .filter(([runtime]) => runtime.includes('iOS-'))
  .reverse()
  .flatMap(([, list]) => list)
  .find((d) => d.name.startsWith('iPhone') && d.isAvailable);
if (!simulator) throw Error('Xcode runner 缺少已安装的 iPhone 模拟器运行时');
const work = mkdtempSync(path.join(tmpdir(), 'bodyjournal-simulator-'));
const appId = 'local.bodyjournal.personal.ios',
  udid = simulator.udid;
const sim = (...args) => output('xcrun', ['simctl', ...args]);
async function open() {
  sim('launch', udid, appId);
  const root = sim('get_app_container', udid, appId, 'data');
  const file = path.join(root, 'Library/Application Support/BodyJournal/journal.sqlite');
  for (let i = 0; i < 60; i++) {
    if (existsSync(file)) {
      const value = output('sqlite3', ['-readonly', file, "SELECT value FROM settings WHERE id='device'"]);
      if (/^[0-9a-f-]{36}$/.test(value)) return value;
    }
    await setTimeout(1000);
  }
  throw Error('App 启动后，React 未能通过原生插件建立 SQLite 档案');
}
// Instrument only the temporary simulator bundle, after verifying startup of the original build.
async function verifyFormLayout(bundle) {
  const assets = path.join(bundle, 'public'),
    id = randomUUID();
  const index = path.join(assets, 'index.html');
  writeFileSync(
    path.join(assets, 'layout-check.js'),
    `
    let text = 'ok';
    try { await (${checkRecordForms.toString()})(); } catch (error) { text = String(error); }
    const id = ${JSON.stringify(id)};
    const record = {id,kind:'note',text,occurredAt:new Date().toISOString(),timezone:'UTC',deleted:false,photos:[],portions:[]};
    await window.Capacitor.nativePromise('Journal','request',{method:'save',id,previous:0,doc:JSON.stringify({record,revision:1,replica:null})});
  `,
  );
  writeFileSync(
    index,
    readFileSync(index, 'utf8').replace(
      '</body>',
      '<script type="module" src="./layout-check.js"></script></body>',
    ),
  );
  run('codesign', ['--force', '--sign', '-', bundle]);
  sim('terminate', udid, appId);
  sim('install', udid, bundle);
  await open();
  const root = sim('get_app_container', udid, appId, 'data');
  const db = path.join(root, 'Library/Application Support/BodyJournal/journal.sqlite');
  for (let i = 0; i < 50; i++) {
    const status = output('sqlite3', [
      '-readonly',
      db,
      `SELECT json_extract(doc,'$.record.text') FROM journal WHERE id='${id}'`,
    ]);
    if (status === 'ok') return;
    if (status) throw Error(status);
    await setTimeout(1000);
  }
  throw Error('未收到 iOS 日期控件布局检查结果');
}
try {
  run('xcodebuild', [
    '-project',
    'ios/App/App.xcodeproj',
    '-scheme',
    'App',
    '-configuration',
    'Debug',
    '-destination',
    'id=' + udid,
    '-derivedDataPath',
    work,
    'build',
  ]);
  if (simulator.state !== 'Booted') sim('boot', udid);
  run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
  const bundle = path.join(work, 'Build/Products/Debug-iphonesimulator/App.app');
  sim('install', udid, bundle);
  const device = await open();
  sim('terminate', udid, appId);
  if (device !== (await open())) throw Error('重启后本机档案标识发生变化');
  await setTimeout(1500);
  mkdirSync('release', { recursive: true });
  sim('io', udid, 'screenshot', 'release/iphone-simulator.png');
  await verifyFormLayout(bundle);
  console.log(
    simulator.name +
      ' 五种录入界面的日期控件对齐，首次启动和重启均通过真实 WKWebView → Capacitor → Swift → SQLite 路径',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
