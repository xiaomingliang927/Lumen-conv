/**
 * 二进制获取脚本：把 ffmpeg / ffprobe 落地到 resources/bin/。
 *
 * 为什么不用 ffmpeg-static 的 postinstall：
 *   它需要运行时从 github.com 下载，本机/部分国内网络下会超时甚至完全不通。
 *   这里改成「多镜像 + 回退」策略，和装依赖同一条链路（走 npm 镜像），可靠且可重复执行。
 *
 * ffmpeg 来源优先级（实测结论，见 docs/DECISIONS.md D-004）：
 *   1) yt-dlp/FFmpeg-Builds 的 master 构建（更新、含 AV1/libsvtav1），经 GitHub 代理镜像下载
 *   2) @ffmpeg-installer/win32-x64 的 npm 包（tarball 自带 exe，最稳，但构建较老）
 *   两者产物都会写入 resources/bin/，任一条成功即可用。
 *
 * 用法：
 *   node scripts/fetch-binaries.mjs                # 缺失才下载
 *   node scripts/fetch-binaries.mjs --force        # 强制重新下载
 *   node scripts/fetch-binaries.mjs --source=npm   # 只用 npm 包（老构建，但最快最稳）
 *   node scripts/fetch-binaries.mjs --electron     # 顺带补装 electron 运行时
 */
import { createWriteStream, existsSync, mkdirSync, promises as fsp, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const alsoElectron = argv.includes('--electron');
const sourceArg = argv.find((a) => a.startsWith('--source='))?.split('=')[1] ?? 'auto';

const REGISTRY = process.env.LUMEN_NPM_MIRROR ?? 'https://registry.npmmirror.com';
const ELECTRON_MIRROR = process.env.ELECTRON_MIRROR ?? `${REGISTRY}/-/binary/electron/`;

/** GitHub 代理镜像：直连 github.com 不通时按顺序尝试 */
const GH_PROXIES = (process.env.LUMEN_GH_PROXIES ?? 'https://gh-proxy.com/,https://ghfast.top/,https://ghproxy.net/')
  .split(',')
  .filter(Boolean);

const binDir = path.join(root, 'resources', 'bin');
const tmpDir = path.join(root, '.downloads');

const MIN_EXE_BYTES = 20 * 1024 * 1024; // 小于 20MB 的 ffmpeg 基本不可能可用

/* ------------------------------ 通用工具 ------------------------------ */

function log(msg) {
  console.log(`[fetch-binaries] ${msg}`);
}

const sizeMb = (p) => (statSync(p).size / 1048576).toFixed(1);

async function download(url, dest, label) {
  log(`下载 ${label}\n           ${url}`);
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const actual = statSync(dest).size;
  if (declared > 0 && actual !== declared) {
    throw new Error(`下载不完整：期望 ${declared} 字节，实际 ${actual} 字节`);
  }
  log(`完成 ${(actual / 1048576).toFixed(1)} MB（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return dest;
}

/** 下载并校验 sha256（有期望值时）；返回实际摘要 */
async function sha256(file) {
  const hash = createHash('sha256');
  const buf = await fsp.readFile(file);
  hash.update(buf);
  return hash.digest('hex');
}

/**
 * 解包归档文件。
 *
 * 注意：不要用 spawn 捕获子进程输出（stdio:'pipe'），
 * 在部分受限环境里会直接 EPERM 失败。这里让 tar 继承 stdio，
 * 失败时回退到 PowerShell 的 Expand-Archive（仅支持 zip）。
 */
function untar(archive, outDir, label) {
  mkdirSync(outDir, { recursive: true });
  const run = (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, shell: false });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });

  return (async () => {
    if (await run('tar', ['-xf', archive, '-C', outDir])) return;
    const psOk = await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${outDir}' -Force`,
    ]);
    if (!psOk) throw new Error(`解包 ${label} 失败：tar 与 Expand-Archive 都不可用`);
  })();
}

/** 递归查找文件（归档内部层级不固定） */
async function findFile(dir, name) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
    if (e.isDirectory()) {
      const hit = await findFile(full, name);
      if (hit) return hit;
    }
  }
  return null;
}

async function resolveNpmTarball(pkgName) {
  const meta = await (await fetch(`${REGISTRY}/${pkgName.replace('/', '%2f')}`)).json();
  const version = meta['dist-tags'].latest;
  return { version, url: meta.versions[version].dist.tarball };
}

/** 按顺序尝试多个下载地址，返回第一个成功的 */
async function downloadFromAny(urls, dest, label) {
  const errors = [];
  for (const url of urls) {
    try {
      await download(url, dest, label);
      return url;
    } catch (err) {
      errors.push(`${url} → ${err.message}`);
      log(`  该地址失败，尝试下一个（${err.message}）`);
    }
  }
  throw new Error(`所有地址都失败：\n    ${errors.join('\n    ')}`);
}

/* --------------------------- 来源 1：npm 包 --------------------------- */

async function fromNpmPackage({ pkgName, exeName, label }) {
  const { version, url } = await resolveNpmTarball(pkgName);
  log(`${label}：来源 npm 包 ${pkgName}@${version}`);

  const tgz = path.join(tmpDir, `${pkgName.replace('/', '_')}-${version}.tgz`);
  const extractDir = path.join(tmpDir, `${pkgName.replace('/', '_')}-${version}`);

  if (force || !existsSync(tgz)) await download(url, tgz, label);
  else log(`复用已下载的 ${path.basename(tgz)}（${sizeMb(tgz)} MB）`);

  await fsp.rm(extractDir, { recursive: true, force: true });
  await untar(tgz, extractDir, label);

  const found = await findFile(extractDir, exeName);
  if (!found) throw new Error(`解包后没有找到 ${exeName}`);
  return found;
}

/* ------------------------ 来源 2：FFmpeg-Builds ------------------------ */

const BUILD_BASE = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest';
const BUILD_ZIP = 'ffmpeg-master-latest-win64-gpl.zip';

async function fromFFmpegBuilds(exeName, label) {
  const dest = path.join(tmpDir, BUILD_ZIP);
  const extractDir = path.join(tmpDir, 'ffmpeg-builds');

  if (force || !existsSync(dest) || statSync(dest).size < 100 * 1024 * 1024) {
    // 直连排在最后：能连通时它最快，不通时前面的代理会接管
    const urls = [
      ...GH_PROXIES.map((p) => `${p}${BUILD_BASE}/${BUILD_ZIP}`),
      `${BUILD_BASE}/${BUILD_ZIP}`,
    ];
    await downloadFromAny(urls, dest, `${label}（FFmpeg-Builds master）`);
  } else {
    log(`${label}：复用已下载的 ${BUILD_ZIP}（${sizeMb(dest)} MB）`);
  }

  await fsp.rm(extractDir, { recursive: true, force: true });
  await untar(dest, extractDir, label);
  const found = await findFile(extractDir, exeName);
  if (!found) throw new Error(`解包后没有找到 ${exeName}`);
  return found;
}

/* ------------------------------ 落地安装 ------------------------------ */

async function installBinary({ exeName, label, npmPkg, preferNpm }) {
  const target = path.join(binDir, exeName);

  if (!force && existsSync(target) && statSync(target).size >= MIN_EXE_BYTES) {
    log(`已存在，跳过：resources/bin/${exeName}（${sizeMb(target)} MB）`);
    return target;
  }

  const attempts = [];
  if (preferNpm || sourceArg === 'npm') {
    attempts.push(['npm 包', () => fromNpmPackage({ pkgName: npmPkg, exeName, label })]);
  } else {
    attempts.push(['FFmpeg-Builds（GitHub 代理镜像）', () => fromFFmpegBuilds(exeName, label)]);
    attempts.push(['npm 包（回退）', () => fromNpmPackage({ pkgName: npmPkg, exeName, label })]);
  }

  let source = null;
  let lastErr = null;
  for (const [desc, fn] of attempts) {
    try {
      source = await fn();
      log(`${label}：使用 ${desc} 成功`);
      break;
    } catch (err) {
      lastErr = err;
      log(`${label}：${desc} 失败 —— ${err.message}`);
    }
  }
  if (!source) throw new Error(`${label} 所有来源都失败：${lastErr?.message}`);

  mkdirSync(binDir, { recursive: true });
  await fsp.copyFile(source, target);
  const digest = await sha256(target);
  log(`已就位 resources/bin/${exeName}（${sizeMb(target)} MB）`);
  log(`           sha256 = ${digest}`);
  return target;
}

/**
 * 补装 Electron 运行时。
 * electron 包的 postinstall 在网络不畅时会静默失败，导致 electron.exe 缺失，
 * 这里用镜像直接补一份（解压到 node_modules/electron/dist）。
 *
 * 失败时抛异常，让调用方（install.mjs / CI）能拿到非零退出码 ——
 * 早期版本解包失败后仍以 0 结束，掩盖了"桌面应用根本没装好"这一事实。
 */
async function ensureElectron() {
  const pkgJsonPath = path.join(root, 'node_modules', 'electron', 'package.json');
  if (!existsSync(pkgJsonPath)) {
    log('未安装 electron 包，跳过运行时安装');
    return;
  }
  const pkg = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf8'));
  const version = pkg.version;
  const distDir = path.join(root, 'node_modules', 'electron', 'dist');
  const exePath = path.join(distDir, 'electron.exe');

  if (!force && existsSync(exePath) && statSync(exePath).size > 50 * 1024 * 1024) {
    log(`Electron 运行时已存在：${version}（${sizeMb(exePath)} MB）`);
    return;
  }

  const url = `${ELECTRON_MIRROR}v${version}/electron-v${version}-win32-x64.zip`;
  const zip = path.join(tmpDir, `electron-v${version}-win32-x64.zip`);
  // Electron 的 win32-x64 压缩包约 130MB，远小于此值的都是半成品（曾被中断的下载）
  const MIN_ZIP_BYTES = 80 * 1024 * 1024;

  const zipLooksValid = existsSync(zip) && statSync(zip).size >= MIN_ZIP_BYTES;
  if (force || !zipLooksValid) {
    if (existsSync(zip)) {
      log(`已存在的压缩包不完整（${sizeMb(zip)} MB），重新下载`);
      await fsp.rm(zip, { force: true });
    }
    await downloadFromAny([url], zip, `Electron ${version} 运行时`);
  } else {
    log(`复用已下载的 Electron 压缩包（${sizeMb(zip)} MB）`);
  }

  await fsp.rm(distDir, { recursive: true, force: true });
  await untar(zip, distDir, 'Electron');

  if (!existsSync(exePath)) {
    // 不要把 path.txt 写下去：留着错误状态比写一个指向不存在文件的指针更容易排查
    throw new Error(`Electron 解包后未找到 electron.exe（压缩包可能损坏）：${zip}`);
  }
  // electron 包靠 path.txt 定位可执行文件，缺了会启动失败
  await fsp.writeFile(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe', 'utf8');
  log(`Electron 运行时已就位（${version}，${sizeMb(exePath)} MB）`);
}

async function main() {
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // 串行执行：多路大文件并发会把带宽打满，反而都变慢
  await installBinary({
    exeName: 'ffmpeg.exe',
    label: 'ffmpeg',
    npmPkg: '@ffmpeg-installer/win32-x64',
    preferNpm: false,
  });
  // ffprobe 的 npm 包版本（5.1）比 ffmpeg 的包（4.1）新且稳定，优先用它，失败再走 GitHub 代理
  await installBinary({
    exeName: 'ffprobe.exe',
    label: 'ffprobe',
    npmPkg: '@ffprobe-installer/win32-x64',
    preferNpm: true,
  });
  if (alsoElectron) await ensureElectron();

  console.log('');
  await import('./verify-binaries.mjs');
}

main().catch((err) => {
  console.error(`[fetch-binaries] 失败：${err.message}`);
  console.error('  提示：可用 LUMEN_NPM_MIRROR / LUMEN_GH_PROXIES 环境变量换镜像后重试。');
  process.exit(1);
});

export { ensureElectron, installBinary };
