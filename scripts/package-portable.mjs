/**
 * Windows 便携版打包（不依赖网络下载）。
 *
 * 为什么不用 `electron-builder --win nsis`：
 *   electron-builder 打包 NSIS 时需要额外的工具链（app-builder-bin、nsis、winCodeSign），
 *   这些在受限网络环境下会以 "Timeout awaiting 'request' for 600000ms" 失败，
 *   且它指向的 Electron 二进制缓存与 @electron/get 的缓存不通用。
 *   本项目在离线/弱网环境下的目标是：产出一个双击即可运行、自带 ffmpeg 的完整程序。
 *   因此这里手工组装 —— 逻辑很短，且完全可复现。
 *
 * 产物结构（与 electron-builder 的 extraResources 布局一致）：
 *   release/Lumen-conv-便携版/
 *     Lumen-conv.exe            主程序（当前为 Electron 默认图标，见下方"已知限制"）
 *     *.dll / *.pak / locales/  Electron 运行时
 *     resources/
 *       app.asar                主进程 + preload + 渲染层产物
 *       bin/ffmpeg.exe          与 extraResources 语义等价，放这里而不是打进 asar
 *       bin/ffprobe.exe
 *
 * 用法：
 *   node scripts/package-portable.mjs           # 复用已构建的 dist / dist-electron
 *   node scripts/package-portable.mjs --build   # 先构建渲染层与主进程再打包
 */
import { createPackage } from '@electron/asar';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outRoot = path.join(root, 'release');
const outDir = path.join(outRoot, 'Lumen-conv-便携版');
const staging = path.join(outRoot, '.staging');

const APP_NAME = 'Lumen-conv';

function log(msg) {
  console.log(`[package] ${msg}`);
}

function fail(msg) {
  console.error(`[package] ✘ ${msg}`);
  process.exit(1);
}

function run(cmd, args, label) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true });
  if (res.status !== 0) fail(`${label} 失败（exit=${res.status}）`);
}

/* ------------------------------ 前置检查 ------------------------------ */

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!existsSync(path.join(electronDist, 'electron.exe'))) {
  fail('未找到 Electron 运行时。请先执行：node scripts/fetch-binaries.mjs --electron');
}
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
  if (!existsSync(path.join(root, 'resources', 'bin', name))) {
    fail(`未找到 resources/bin/${name}。请先执行：node scripts/fetch-binaries.mjs`);
  }
}

/* ------------------------------ 构建产物 ------------------------------ */

if (process.argv.includes('--build')) {
  log('构建渲染层 …');
  run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], '渲染层构建');
  log('构建主进程 …');
  run(process.execPath, [path.join(root, 'scripts', 'build-electron.mjs')], '主进程构建');
}

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  fail('未找到 dist/index.html，请加 --build 或先执行 npm run build');
}
if (!existsSync(path.join(root, 'dist-electron', 'main.js'))) {
  fail('未找到 dist-electron/main.js，请加 --build 或先执行 npm run build');
}

/* ------------------------------ 组装 ------------------------------ */

log('清理旧产物 …');
rmSync(outDir, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

log('复制 Electron 运行时 …');
// 排除默认的 resources/default_app.asar：我们用不到它，能省一点体积
cpSync(electronDist, staging, {
  recursive: true,
  filter: (src) => !src.endsWith('default_app.asar'),
});

const exePath = path.join(staging, 'electron.exe');
if (!existsSync(exePath)) fail('运行时里没有 electron.exe');

/* ---- 写图标与版本信息（纯离线，用 electron-winstaller 附带的 rcedit） ----
 * 已知限制：该 rcedit 版本在资源管理器路径含非 ASCII 字符（本项目路径里有中文）
 * 时会报 "Fatal error: Unable to load file"（实测即如此，版本信息保持 Electron 原值）。
 * 这里不去做各种环境相关的绕行（例如把 exe 复制到临时 ASCII 路径再改回来）——
 * 那会让构建脚本依赖具体环境，反而更难维护。图标缺失不影响功能。
 * 需要带图标的正式安装包时，请在有网络的环境执行 `npm run dist:nsis`，
 * electron-builder 会正确处理图标。 */
const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const icon = path.join(root, 'build', 'icon.ico');
if (existsSync(rcedit) && existsSync(icon)) {
  log('尝试写入图标与版本信息 …');
  const res = spawnSync(
    rcedit,
    [
      exePath,
      '--set-icon', icon,
      '--set-file-version', pkg.version,
      '--set-product-version', pkg.version,
      '--set-version-string', 'ProductName', `${APP_NAME} 视频格式转换器`,
      '--set-version-string', 'FileDescription', `${APP_NAME} 视频格式转换器`,
      '--set-version-string', 'CompanyName', 'xiaomingliang',
      '--set-version-string', 'LegalCopyright', 'Copyright © 2025 xiaomingliang',
      '--set-version-string', 'OriginalFilename', `${APP_NAME}.exe`,
    ],
    { stdio: 'pipe', windowsHide: true },
  );
  if (res.status !== 0) {
    log(
      `⚠ 跳过图标写入（不影响运行）：${
        (res.stderr || '').toString().trim().split('\n')[0] || `exit=${res.status}`
      }`,
    );
  } else {
    log('图标与版本信息已写入');
  }
} else {
  log('⚠ 缺少 rcedit.exe 或 build/icon.ico，跳过图标写入');
}

renameSync(exePath, path.join(staging, `${APP_NAME}.exe`));

/* ---- ffmpeg / ffprobe：放在 resources/bin，与开发态的查找路径一致 ---- */
const resDir = path.join(staging, 'resources');
mkdirSync(path.join(resDir, 'bin'), { recursive: true });
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
  cpSync(path.join(root, 'resources', 'bin', name), path.join(resDir, 'bin', name));
}
log(`已放入 ffmpeg / ffprobe（${(
  (statSync(path.join(resDir, 'bin', 'ffmpeg.exe')).size +
    statSync(path.join(resDir, 'bin', 'ffprobe.exe')).size) / 1048576
).toFixed(1)} MB）`);

/* ---- 应用代码打进 app.asar ---- */
log('打包 app.asar …');
const asarStaging = path.join(staging, '__app');
mkdirSync(asarStaging, { recursive: true });
cpSync(path.join(root, 'dist'), path.join(asarStaging, 'dist'), { recursive: true });
cpSync(path.join(root, 'dist-electron'), path.join(asarStaging, 'dist-electron'), { recursive: true });
// package.json 必须进去：Electron 靠 main 字段找入口
writeFileSync(
  path.join(asarStaging, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName,
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
      main: 'dist-electron/main.js',
    },
    null,
    2,
  ),
  'utf8',
);

await createPackage(asarStaging, path.join(resDir, 'app.asar'));
rmSync(asarStaging, { recursive: true, force: true });

/* ------------------------------ 收尾 ------------------------------ */

// 用复制而不是 rename：在 Windows 上把包含大量文件的目录改名，
// 偶尔会因为杀毒软件/索引器短暂持有句柄而报 EPERM（实测遇到过一次）。
// 先复制再删 staging 更稳，失败时也保留了现场便于排查。
log('移动到最终目录 …');
rmSync(outDir, { recursive: true, force: true });
try {
  renameSync(staging, outDir);
} catch {
  log('rename 被占用，回退为复制 …');
  cpSync(staging, outDir, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
}

const exeFinal = path.join(outDir, `${APP_NAME}.exe`);
const { readdirSync } = await import('node:fs');
let totalBytes = 0;
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else totalBytes += statSync(p).size;
  }
};
walk(outDir);

log('');
log('✔ 便携版已生成');
log(`  可执行文件：${path.relative(root, exeFinal)}`);
log(`  目录总大小：${(totalBytes / 1048576).toFixed(1)} MB`);
log(`  双击 ${APP_NAME}.exe 即可运行（无需安装、无需另装 ffmpeg）`);
