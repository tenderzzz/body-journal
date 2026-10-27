import { spawn } from 'node:child_process';
import { build } from 'esbuild';
await import('./build.mjs');
const vite = spawn('node', ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
for (let n = 0; n < 50; n++) { try { if ((await fetch('http://127.0.0.1:5179')).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
const electron = spawn('node', ['node_modules/electron/cli.js', '.'], { stdio: 'inherit', env: { ...process.env, HEALTH_DEV: '1' } });
electron.on('exit', code => { vite.kill(); process.exit(code ?? 0); });
process.on('SIGINT', () => { vite.kill(); electron.kill(); });
