/**
 * esbuild 打包脚本（npm run build）：单页产物 → dist/
 * - .hack 文件按文本导入（demo 程序内嵌，无运行时请求）
 * - 零运行时依赖：产物仅 dist/index.html + dist/app.js，任何静态托管可部署
 */

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/web/main.ts'],
  bundle: true,
  outfile: 'dist/app.js',
  format: 'iife',
  target: 'es2022',
  loader: { '.hack': 'text' },
  sourcemap: false,
  logLevel: 'info',
});

copyFileSync('index.html', 'dist/index.html');
console.log('build 完成：dist/index.html + dist/app.js');
