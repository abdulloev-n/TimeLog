import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, cpSync } from 'node:fs';
await viteBuild();
mkdirSync('build/electron',{recursive:true});
for(const name of ['main','preload']) await build({entryPoints:[`src/main/${name}.ts`],outfile:`build/electron/${name}.cjs`,bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','sql.js']});
copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm','build/electron/sql-wasm.wasm');
cpSync('src/database/migrations','build/electron/migrations',{recursive:true});
cpSync('assets','build/electron/assets',{recursive:true});
