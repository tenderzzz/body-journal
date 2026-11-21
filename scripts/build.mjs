import { build } from 'esbuild';
await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: 'dist-electron/main.cjs', external: ['electron'], sourcemap: false });
await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: 'dist-electron/preload.cjs', external: ['electron'], sourcemap: false });

if(process.platform==='darwin'){
  const {execFileSync}=await import('node:child_process');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  execFileSync('xcrun',['swiftc','-O','-module-cache-path',join(tmpdir(),'bodyjournal-swift-modules'),'native/SyncDirectory.swift','native/main.swift','-o','dist-electron/journal-folder'],{stdio:'inherit'});
}
