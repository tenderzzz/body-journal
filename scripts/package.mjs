import packager from '@electron/packager';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
const staging=mkdtempSync(path.join(tmpdir(),'bodyjournal-package-'));
const paths = await packager({ dir: '.', out: staging, name: '身体手记', executableName: 'BodyJournal', appBundleId: 'local.bodyjournal.personal', platform: 'darwin', arch: 'arm64', overwrite: true, asar: true, icon: 'assets/icon.icns', ignore: [/^\/tests/, /^\/scripts/, /^\/src/, /^\/electron/, /^\/node_modules\/(?:@playwright|playwright|tsx)/, /^\/release/, /^\/evidence/, /\.md$/], prune: true, extraResource: ['shortcuts', 'docs', 'data', 'assets'], osxSign: false });
mkdirSync('release',{recursive:true});
for(const output of paths){const bundle=path.join(output,'身体手记.app');execFileSync('codesign',['--force','--deep','--sign','-',bundle],{stdio:'inherit'});execFileSync('codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});execFileSync('ditto',['-c','-k','--keepParent',bundle,'release/身体手记-mac-arm64.zip'],{stdio:'inherit'});writeFileSync('release/build.json',JSON.stringify({bundle,at:new Date().toISOString(),version:JSON.parse(readFileSync('package.json','utf8')).version},null,2));}
console.log(paths.join('\n'));
