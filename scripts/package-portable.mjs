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
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outRoot = path.join(root, 'release');
/*
 * 精简版输出到**另一个目录**，不要覆盖完整版 —— 两者体积差 3 倍，
 * 混在一起会让人以为"打包瘦身成功了，但怎么还是 600 MB"。
 */
const outDir = path.join(outRoot, process.argv.includes('--slim') ? 'Lumen-conv-精简版' : 'Lumen-conv-便携版');
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

/**
 * `--slim`：不内置 ffmpeg / ffprobe（2026-09 新增，见 DECISIONS.md D-025）。
 *
 * 为什么要做精简版：完整便携版 602 MB，其中 278 MB 是两个 ffmpeg 二进制。
 * 对"只想先看看这个软件长什么样"的人来说，为了试一下下载 600 MB 太重；
 * 而应用本身**已经**有"找不到 ffmpeg 时的引导"（顶部横幅 + 设置页诊断区 + 可手动指定路径），
 * 所以精简版不是砍功能，而是把"自带"换成"你自己那份也能用"。
 * 代价：首次运行必须指定 ffmpeg/ffprobe 路径，否则转换不可用。
 */
const slim = process.argv.includes('--slim');

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!existsSync(path.join(electronDist, 'electron.exe'))) {
  fail('未找到 Electron 运行时。请先执行：node scripts/fetch-binaries.mjs --electron');
}
// 精简版不内置二进制，所以也不要求它们先下载好（它的卖点之一就是"不用下 278 MB"）
if (!slim) {
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    if (!existsSync(path.join(root, 'resources', 'bin', name))) {
      fail(`未找到 resources/bin/${name}。请先执行：node scripts/fetch-binaries.mjs`);
    }
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

/*
 * 瘦身：只保留用得到的语言包。
 *
 * Electron 自带 55 个 .pak 语言包，合计 **43.7 MB**（未压缩），而本应用是全中文界面，
 * 只有 zh-CN / en-US / en-GB 有意义。注意**不能全删**：Chromium 缺了 locale 资源会
 * 直接回退失败，连界面都起不来 —— 所以保留这三个，其余删掉（省 42 MB）。
 *
 * 这段是"下载太慢"逼出来的：当时 zip 237 MB，其中两个 ffmpeg 二进制 107 MB、
 * Electron 主程序 87 MB，语言包虽然单个不大，但 55 个加起来是第三大项。
 */
const localesDir = path.join(staging, 'locales');
if (existsSync(localesDir)) {
  const keep = new Set(['zh-CN.pak', 'en-US.pak', 'en-GB.pak']);
  let removed = 0;
  let freed = 0;
  for (const name of readdirSync(localesDir)) {
    if (keep.has(name)) continue;
    const full = path.join(localesDir, name);
    try {
      freed += statSync(full).size;
      rmSync(full, { force: true });
      removed++;
    } catch {
      /* 删不掉就留下，不影响功能 */
    }
  }
  log(`语言包瘦身：保留 3 个（zh-CN / en-US / en-GB），删除 ${removed} 个，省 ${(freed / 1048576).toFixed(1)} MB`);
}

/*
 * 清掉自检写在便携版目录里的截图。
 *
 * `npm run smoke:ui:*` 在打包态运行时会把截图写到 **exe 所在目录**（这是设计：打包态基准目录
 * 就是 exe 旁边，见 D-017），如果上一轮在便携版目录里跑过自检，`docs/screenshots/` 就会被
 * 一起打包进去 —— 那是测试产物，不该进分发包。
 */
const strayDocs = path.join(staging, 'docs');
if (existsSync(strayDocs)) {
  rmSync(strayDocs, { recursive: true, force: true });
  log('已移除便携版目录里的自检截图（docs/），它属于测试产物');
}

const exePath = path.join(staging, 'electron.exe');
if (!existsSync(exePath)) fail('运行时里没有 electron.exe');

/* ---- 写图标与版本信息（可选，失败不影响功能） ----
 *
 * 尝试过两条路，都不通，记录在此避免后来者重复踩：
 *   1) 直接对 exe 调 rcedit → `Fatal error: Unable to load file`
 *   2) 怀疑是项目路径含中文，于是把 exe 复制到纯 ASCII 临时目录再调 → 同样失败
 *   3) 进一步对照：对 node_modules 里的 electron.exe、对 rcedit 自己的副本、
 *      对系统 C:\Windows\System32\notepad.exe 调用 → **全部**报同一个错
 * 结论：electron-winstaller 附带的 rcedit 0.2.0（2019 年）在本环境下不可用，
 * 与路径无关，也不是 exe 大小问题。要嵌图标得换更新的 rcedit 或改用
 * electron-builder 的完整工具链（需要网络下载）。
 *
 * 影响与补偿：便携版的 exe 用的是 Electron 默认图标，但**桌面快捷方式会显示我们的图标**
 * —— .lnk 的 IconLocation 可以独立指定图标文件，与目标 exe 内嵌图标无关。
 * 所以用户从桌面看到的仍然是正确图标，只有直接去看 exe 文件本身才是默认图标。
 */
const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const icon = path.join(root, 'build', 'icon.ico');
const renamedExe = path.join(staging, `${APP_NAME}.exe`);

if (existsSync(rcedit) && existsSync(icon)) {
  const asciiDir = path.join(os.tmpdir(), 'lumen-rcedit');
  rmSync(asciiDir, { recursive: true, force: true });
  mkdirSync(asciiDir, { recursive: true });
  const asciiExe = path.join(asciiDir, 'app.exe');
  const asciiIcon = path.join(asciiDir, 'icon.ico');
  cpSync(exePath, asciiExe);
  cpSync(icon, asciiIcon);

  const res = spawnSync(
    rcedit,
    [
      asciiExe,
      '--set-icon', asciiIcon,
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

  if (res.status === 0) {
    cpSync(asciiExe, renamedExe, { force: true });
    rmSync(exePath, { force: true });
    log('✔ 图标与版本信息已写入 exe');
  } else {
    renameSync(exePath, renamedExe);
    log('ℹ 跳过 exe 内嵌图标（该 rcedit 版本在本环境不可用，详见脚本注释）');
  }
  rmSync(asciiDir, { recursive: true, force: true });
} else {
  renameSync(exePath, renamedExe);
  log('ℹ 未找到 rcedit 或 build/icon.ico，跳过 exe 内嵌图标');
}

/* ---- ffmpeg / ffprobe：放在 resources/bin，与开发态的查找路径一致 ---- *
 * `--slim` 时不内置（见文件前面的说明与 DECISIONS.md D-025）。
 */
const resDir = path.join(staging, 'resources');
mkdirSync(path.join(resDir, 'bin'), { recursive: true });
if (slim) {
  log('ℹ 精简版：不内置 ffmpeg / ffprobe（首次运行需在设置里指定路径，省下约 278 MB）');
} else {
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    cpSync(path.join(root, 'resources', 'bin', name), path.join(resDir, 'bin', name));
  }
  log(`已放入 ffmpeg / ffprobe（${(
    (statSync(path.join(resDir, 'bin', 'ffmpeg.exe')).size +
      statSync(path.join(resDir, 'bin', 'ffprobe.exe')).size) / 1048576
  ).toFixed(1)} MB）`);
}

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
let totalBytes = 0;
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else totalBytes += statSync(p).size;
  }
};
walk(outDir);

/* ------------------------------ 桌面快捷方式 ------------------------------ */

/**
 * 在桌面创建快捷方式（`--shortcut` 时启用）。
 *
 * 用 PowerShell 的 WScript.Shell COM 创建 .lnk —— Windows 上不需要任何额外依赖。
 * 之所以做成可选：有人的机器上桌面路径被重定向/受管控，写桌面可能失败；
 * 失败只提示、不让打包整体失败。
 */
function createDesktopShortcut() {
  const desktop = path.join(os.homedir(), 'Desktop');
  const lnk = path.join(desktop, `${APP_NAME} 视频格式转换器.lnk`);
  // 用我们自己的 ico 作为快捷方式图标：即使 exe 内嵌图标换不掉（rcedit 不可用），
  // 桌面上显示给用户的仍然是正确图标。
  const iconForShortcut = existsSync(icon) ? icon : `${exeFinal},0`;

  // 注意：路径要按 PowerShell 单引号字面量转义（' → ''），不能用 JSON.stringify ——
  // 它会把反斜杠写成 \\，Windows 虽能容忍，但存进 .lnk 的 WorkingDirectory/IconLocation
  // 会是双反斜杠，后续用别的工具读取时容易出问题。
  const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut(${psQuote(lnk)})`,
    `$sc.TargetPath = ${psQuote(exeFinal)}`,
    `$sc.WorkingDirectory = ${psQuote(outDir)}`,
    `$sc.IconLocation = ${psQuote(iconForShortcut)}`,
    `$sc.Description = ${psQuote(`${APP_NAME} 视频格式转换器 —— 视频格式转换`)}`,
    '$sc.Save()',
    `if (Test-Path ${psQuote(lnk)}) { 'OK' } else { 'MISS' }`,
  ].join('; ');

  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true },
  );
  if (res.status === 0 && (res.stdout || '').includes('OK')) {
    log(`✔ 桌面快捷方式已创建：${lnk}`);
    return true;
  }
  log(
    `⚠ 桌面快捷方式创建失败（可手动右键 ${APP_NAME}.exe → 发送到 → 桌面快捷方式）：` +
      `${(res.stderr || res.stdout || '').trim().split('\n')[0] || `exit=${res.status}`}`,
  );
  return false;
}

log('');
log(slim ? '✔ 精简版已生成（未内置 ffmpeg）' : '✔ 便携版已生成');
log(`  可执行文件：${path.relative(root, exeFinal)}`);
log(`  目录总大小：${(totalBytes / 1048576).toFixed(1)} MB`);
if (slim) {
  log('  双击即可运行，但**首次需要指定 ffmpeg / ffprobe 路径**：');
  log('    打开应用 → 顶部会有醒目提示 → 「设置 → 运行环境」→ 选择你已有的 ffmpeg.exe / ffprobe.exe');
  log('  想省这一步就用完整版：npm run dist:portable（自带 ffmpeg，约 602 MB）');
} else {
  log(`  双击 ${APP_NAME}.exe 即可运行（无需安装、无需另装 ffmpeg）`);
}

if (process.argv.includes('--shortcut')) {
  createDesktopShortcut();
} else {
  log(`  提示：加 --shortcut 可同时在桌面创建快捷方式`);
}
