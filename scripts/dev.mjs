import { context } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, cpSync } from 'node:fs';
import electron from 'electron';
mkdirSync('build/electron',{recursive:true});
for(const name of ['main','preload']) {const c=await context({entryPoints:[`src/main/${name}.ts`],outfile:`build/electron/${name}.cjs`,bundle:true,platform:'node',format:'cjs',external:['electron','sql.js']});await c.watch();await c.rebuild();}
copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm','build/electron/sql-wasm.wasm');
cpSync('src/database/migrations','build/electron/migrations',{recursive:true});
cpSync('assets','build/electron/assets',{recursive:true});
const server=await createServer();await server.listen();
const child=spawn(electron,['.'],{stdio:'inherit',env:{...process.env,TIMELOG_DEV_URL:'http://127.0.0.1:5173'},windowsHide:true});
child.on('exit',()=>process.exit());
