// A device ID in the private SQLite is created only when the bundled React UI calls the Swift bridge.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';

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
  sim('install', udid, path.join(work, 'Build/Products/Debug-iphonesimulator/App.app'));
  const device = await open();
  sim('terminate', udid, appId);
  if (device !== (await open())) throw Error('重启后本机档案标识发生变化');
  await setTimeout(1500);
  mkdirSync('release', { recursive: true });
  sim('io', udid, 'screenshot', 'release/iphone-simulator.png');
  console.log(simulator.name + ' 首次启动和重启均通过真实 WKWebView → Capacitor → Swift → SQLite 路径');
} finally {
  rmSync(work, { recursive: true, force: true });
}
