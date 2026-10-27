import { build } from 'esbuild';
await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: 'dist-electron/main.cjs', external: ['electron'], sourcemap: false });
await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: 'dist-electron/preload.cjs', external: ['electron'], sourcemap: false });
