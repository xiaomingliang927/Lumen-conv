/**
 * 开发态启动器：等渲染进程 dev server 就绪后再拉起 Electron。
 *
 * 为什么需要它：vite dev server 启动需要 1-2 秒，如果 Electron 立刻去 loadURL
 * 会看到 ERR_CONNECTION_REFUSED 白屏，很多人以为是自己代码坏了。
 * 这里主动轮询端口，就绪后才启动，并在主进程源码变更时自动重启 Electron。
 */
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_URL = process.env.LUMEN_DEV_SERVER ?? 'http://localhost:5273';
const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 60_000;

function log(msg) {
  console.log(`[dev-electron] ${msg}`);
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch(DEV_URL, { method: 'GET' });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

function resolveElectronBin() {
  // electron 包的入口导出可执行文件路径
  const cli = path.join(root, 'node_modules', 'electron', 'cli.js');
  if (!existsSync(cli)) {
    throw new Error('未找到 electron，请先执行 npm run setup');
  }
  return cli;
}

let child = null;
let restarting = false;

function startElectron() {
  const cli = resolveElectronBin();
  child = spawn(process.execPath, [cli, '.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, LUMEN_DEV: '1', LUMEN_DEV_SERVER: DEV_URL },
  });
  child.on('exit', (code) => {
    log(`Electron 退出（code=${code}）`);
    if (!restarting) process.exit(code ?? 0);
  });
}

function restartElectron(reason) {
  if (!child) return;
  restarting = true;
  log(`检测到${reason}，重启 Electron …`);
  const c = child;
  child = null;
  c.once('exit', () => {
    restarting = false;
    startElectron();
  });
  c.kill();
}

async function main() {
  log(`等待渲染进程 dev server：${DEV_URL}`);
  const ready = await waitForServer();
  if (!ready) {
    console.error(`[dev-electron] 等待超时，请确认 vite 已启动（npm run dev:renderer）`);
    process.exit(1);
  }
  log('dev server 就绪');

  // 先编译一次主进程
  await new Promise((resolve, reject) => {
    const b = spawn(process.execPath, [path.join(root, 'scripts', 'build-electron.mjs')], {
      cwd: root,
      stdio: 'inherit',
    });
    b.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`主进程编译失败 code=${code}`))));
  });

  startElectron();

  // 监听主进程源码，变更后重编译并重启（渲染进程由 vite HMR 负责，无需重启）
  const watchDirs = [path.join(root, 'electron'), path.join(root, 'shared')];
  let timer = null;
  for (const dir of watchDirs) {
    watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.ts')) return;
      if (timer) clearTimeout(timer);
      // 防抖：编辑器保存会触发多次事件
      timer = setTimeout(async () => {
        timer = null;
        log(`主进程源码变更：${filename}`);
        await new Promise((resolve) => {
          const b = spawn(process.execPath, [path.join(root, 'scripts', 'build-electron.mjs')], {
            cwd: root,
            stdio: 'inherit',
          });
          b.on('exit', resolve);
        });
        restartElectron('主进程源码变更');
      }, 300);
    });
  }
  log('已监听 electron/ 与 shared/ 目录');
}

main().catch((err) => {
  console.error('[dev-electron]', err.message);
  process.exit(1);
});
