/**
 * 主进程 / preload 构建脚本。
 *
 * 用 esbuild 而不是再引一套 vite 插件：
 * - 主进程代码量小，esbuild 一次打包 <100ms
 * - 不需要 tsc 产物里的模块解析开销，直接 bundle 成单文件最省事
 *
 * `electron` 必须 external：它是运行时注入的，不能打进 bundle。
 * 本项目的 ffmpeg / ffprobe 不由 npm 包提供（见 scripts/fetch-binaries.mjs），
 * 所以不需要为二进制包配置 external。
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const external = ['electron'];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  external,
  define: {
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
  },
};

const targets = [
  {
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(root, 'dist-electron/main.js'),
    ...common,
  },
  {
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(root, 'dist-electron/preload.js'),
    ...common,
  },
];

if (watch) {
  // 开发态：主进程改动自动重编译（Electron 侧由 dev-electron.mjs 负责重启）
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  console.log('[build-electron] 监听中 …');
} else {
  await Promise.all(targets.map((t) => build(t)));
  console.log('[build-electron] 构建完成 → dist-electron/');
}
