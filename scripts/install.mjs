/**
 * 依赖安装脚本（替代裸 npm install）。
 *
 * 为什么需要它：
 * 1) 本机 / 部分 CI 环境不允许写入默认 npm 缓存目录（C:\Users\<user>\AppData\Local\npm-cache），
 *    直接 npm install 会以 EPERM 失败。这里把缓存固定到项目内 .npm-cache/。
 * 2) Electron 与 ffmpeg-static 的二进制默认从 github.com 下载，国内经常超时。
 *    npm 11 已不支持 .npmrc 里的 electron_mirror 自定义键，必须用环境变量注入。
 *
 * 用法：node scripts/install.mjs [--extra npm参数...]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.npm-cache');
mkdirSync(cacheDir, { recursive: true });

const MIRROR = 'https://registry.npmmirror.com';

const env = {
  ...process.env,
  npm_config_registry: MIRROR,
  // Electron 预编译二进制
  ELECTRON_MIRROR: `${MIRROR}/-/binary/electron/`,
  // electron-builder 需要的 nsis / winCodeSign 等
  ELECTRON_BUILDER_BINARIES_MIRROR: `${MIRROR}/-/binary/electron-builder-binaries/`,
  // ffmpeg-static / ffprobe-static 的下载基址
  FFMPEG_BINARIES_MIRROR: `${MIRROR}/-/binary/ffmpeg-static/`,
  // 允许各包执行安装脚本（npm 11 默认策略更严格）
  npm_config_foreground_scripts: 'true',
};

const extra = process.argv.slice(2);
const args = ['install', '--no-fund', '--no-audit', `--cache=${cacheDir}`, ...extra];

console.log('[install] cwd   =', root);
console.log('[install] cache =', cacheDir);
console.log('[install] args  =', args.join(' '));
if (existsSync(path.join(root, 'node_modules'))) {
  console.log('[install] 检测到已有 node_modules，将执行增量安装');
}

const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (err) => {
  console.error('[install] 启动 npm 失败：', err.message);
  process.exit(1);
});

child.on('exit', async (code) => {
  if (code !== 0) {
    console.error(`[install] npm install 失败（code=${code}）`);
    process.exit(code ?? 1);
  }

  // 第二步：确保 ffmpeg / ffprobe 二进制就位，并补装 electron 运行时
  // （electron 的 postinstall 在网络不畅时会静默失败，这里统一兜底）
  console.log('\n[install] 依赖安装完成，开始准备 ffmpeg 二进制 …\n');
  const fetch = spawn(process.execPath, [path.join(root, 'scripts', 'fetch-binaries.mjs'), '--electron'], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  fetch.on('error', (err) => {
    console.error('[install] 启动 fetch-binaries 失败：', err.message);
    process.exit(1);
  });
  fetch.on('exit', (fetchCode) => {
    if (fetchCode !== 0) {
      console.warn(
        '\n[install] 二进制准备未完全成功。应用仍可启动，' +
          '可在应用内「设置 → 运行环境」手动指定 ffmpeg 路径。\n',
      );
    } else {
      console.log('\n[install] 全部就绪，执行 npm run dev 即可启动开发模式。\n');
    }
    // 二进制失败不阻塞安装流程的整体成功判定
    process.exit(0);
  });
});
