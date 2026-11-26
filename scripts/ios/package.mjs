import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, cpSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']);
const work = mkdtempSync(path.join(tmpdir(), 'bodyjournal-iphone-'));
try {
  run('xcodebuild', [
    '-project',
    'ios/App/App.xcodeproj',
    '-scheme',
    'App',
    '-configuration',
    'Release',
    '-destination',
    'generic/platform=iOS',
    '-derivedDataPath',
    work,
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'build',
  ]);
  const app = path.join(work, 'Build/Products/Release-iphoneos/App.app');
  const identifier = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print CFBundleIdentifier', path.join(app, 'Info.plist')],
    { encoding: 'utf8' },
  ).trim();
  if (identifier !== 'local.bodyjournal.personal.ios' || !existsSync(path.join(app, 'public/index.html')))
    throw Error('IPA 标识或离线界面缺失');
  if (existsSync(path.join(app, 'embedded.mobileprovision')) || existsSync(path.join(app, '_CodeSignature'))) {
    throw Error('公开 IPA 必须由未签名的构建生成。');
  }
  const binary = execFileSync('xcrun', ['vtool', '-show-build', path.join(app, 'App')], { encoding: 'utf8' });
  if (!/platform IOS\b/.test(binary)) throw Error('构建产物的目标必须是 iPhone 真机。');
  const payload = path.join(work, 'Payload');
  mkdirSync(payload);
  cpSync(app, path.join(payload, 'App.app'), { recursive: true });
  mkdirSync('release', { recursive: true });
  const ipa = path.resolve('release/BodyJournal-iPhone.ipa');
  run('ditto', ['-c', '-k', '--keepParent', payload, ipa]);
  run('unzip', ['-tq', ipa]);
  writeFileSync(
    'release/iphone-SHA256SUMS.txt',
    createHash('sha256').update(readFileSync(ipa)).digest('hex') + '  BodyJournal-iPhone.ipa\n',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
