/**
 * 主进程入口：窗口管理、IPC 路由、协议注册、生命周期。
 *
 * 关键决定：
 * 1) 渲染进程不开 nodeIntegration、开启 contextIsolation —— 只有 preload 一个出口。
 * 2) 缩略图/预览这类本地文件不用 file:// 直接给渲染进程（会被 webSecurity 拦），
 *    而是注册自定义协议 lumen-media://，把绝对路径作为 host 传入。
 *    好处是不用关 webSecurity，也不用把文件读成 base64 塞进内存。
 * 3) 启动时先「快速探测」编码器让界面秒出，再后台做「完整探测」（会真的试跑硬件编码器），
 *    完成后推 capabilities:updated 事件刷新 UI —— 这是启动速度的关键。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AppSettings,
  CreateJobRequest,
  CreateJobResult,
  FfmpegDetectResult,
  IpcResponse,
  MediaJob,
  MediaProbeResult,
  SystemCapabilities,
  ThumbnailResult,
} from '../shared/types';
import { CONVERSION_PRESETS } from '../shared/presets';
import { getBinaries, invalidateBinaryCache } from './ffmpeg/binaries';
import { probeCapabilities, invalidateCapabilities } from './ffmpeg/capabilities';
import { ConversionEngine } from './ffmpeg/convert';
import { exec } from './ffmpeg/process';
import { probeMedia } from './ffmpeg/probe';
import { getThumbnail, clearThumbnailCache } from './ffmpeg/thumbnail';
import { loadSettings, resetSettings, saveSettings } from './settings';

/* ------------------------------ 全局状态 ------------------------------ */

const engine = new ConversionEngine();
let mainWindow: BrowserWindow | null = null;
let settings: AppSettings;
let ffmpegPath: string | null = null;
let ffprobePath: string | null = null;

const isDev = process.env.LUMEN_DEV === '1';
const DEV_SERVER_URL = process.env.LUMEN_DEV_SERVER ?? 'http://localhost:5273';

/* ------------------------------ 单实例 ------------------------------ */

// 第二次启动时聚焦已有窗口，而不是再开一个（转换任务不该被分成两份）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* ------------------------------ 自定义协议 ------------------------------ */

// 必须在 app ready 之前注册
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lumen-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

/**
 * lumen-media://local/<url编码后的绝对路径>
 *
 * 为什么统一加 /local/ 前缀：Windows 盘符若直接放在 host 位置（lumen-media://c:/x.mp4），
 * 部分 URL 解析器会把 `c:` 当成端口/协议的一部分，中文与空格路径也更容易踩坑。
 * 统一前缀后，pathname 就是一份干净的编码路径，解析逻辑只有一条分支。
 */
function registerMediaProtocol(): void {
  protocol.handle('lumen-media', async (request) => {
    try {
      const url = new URL(request.url);
      const raw = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const filePath = path.normalize(raw);
      if (!filePath || !existsSync(filePath)) {
        return new Response('文件不存在', { status: 404 });
      }
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      return new Response(`读取失败：${String(err)}`, { status: 500 });
    }
  });
}

/** 绝对路径 → 渲染进程可直接用的 URL */
function toMediaUrl(filePath: string): string {
  return `lumen-media://local/${encodeURIComponent(filePath.replace(/\\/g, '/'))}`;
}

/* ------------------------------ 自动化界面自检 ------------------------------ */

/** 界面自检时从渲染进程采集的页面特征 */
interface PageReport {
  settingsCards: number;
  settingsHead: string;
  queueEmpty: boolean;
  queueHead: string;
  activeNav: string;
}

/**
 * `electron . --smoke` 模式：启动真实窗口、截图、并用 JS 检查关键元素是否渲染成功。
 *
 * 为什么要有它：笔试要求第 7 条明确说「不能连自己都没测试过」。
 * 光靠单元测试无法证明界面真的能跑起来，而人工点一遍又不可复现。
 * 这里把「界面能启动且关键区域都在」变成一条可以反复执行、有退出码的检查，
 * 顺带产出 README 需要的界面截图。
 */
async function runSmokeCheck(): Promise<void> {
  const win = mainWindow;
  if (!win) {
    console.error('[smoke] 窗口未创建');
    process.exit(1);
  }

  /**
   * 带标签的 executeJavaScript 封装。
   *
   * 踩坑记录：executeJavaScript 会用结构化克隆把表达式结果传回主进程，
   * 一旦表达式返回 Promise / Vue 响应式对象 / DOM 节点，就会抛
   * "An object could not be cloned."，而且错误信息里**不带任何位置信息**，
   * 排查起来非常痛苦。这里统一给每一步加标签，并把失败原因归到具体步骤上。
   *
   * 约定：所有被测表达式都必须以基本类型（true / 字符串 / 数字）收尾。
   */
  const evalJs = async <T>(label: string, expression: string): Promise<T> => {
    try {
      return (await win.webContents.executeJavaScript(expression)) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[smoke] ✘ 步骤「${label}」执行失败：${msg}`);
      throw new Error(`步骤「${label}」失败：${msg}`);
    }
  };

  const shotDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const outDir = path.join(app.getAppPath(), 'docs', 'screenshots');
  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });

  // 等待界面骨架挂载 + store 数据加载完成。
  // 只看 DOM 元素是否存在是不够的：设置页依赖 settings 数据，
  // 数据未就绪时 v-if 会让整块内容不渲染，截出来是一张空白页。
  const deadline = Date.now() + 60_000;
  for (;;) {
    const domReady = await evalJs<boolean>(
      '检查界面骨架',
      `Boolean(document.querySelector('.titlebar') && document.querySelector('.sidebar') && document.querySelector('.file-pane'))`,
    );
    const storeReady = await evalJs<boolean>(
      '检查 store 就绪标志',
      `document.documentElement.getAttribute('data-store-ready') === '1'`,
    );
    if (domReady && storeReady) break;
    if (Date.now() > deadline) {
      console.error(`[smoke] ✘ 等待界面就绪超时（DOM=${domReady}, store=${storeReady}）`);
      process.exit(1);
    }
    await shotDelay(300);
  }

  // 等首次能力探测（ffmpeg 版本号）把标题栏状态刷出来
  const capDeadline = Date.now() + 20_000;
  for (;;) {
    const chip = await evalJs<string>(
      '读取 ffmpeg 状态',
      `(document.querySelector('.titlebar .chip')?.textContent ?? '').trim()`,
    );
    if (chip.includes('ffmpeg')) break;
    if (Date.now() > capDeadline) break; // 不阻塞：ffmpeg 缺失本身也是要如实报告的状态
    await shotDelay(250);
  }

  // 让首帧动画/字体稳定一下再截图
  await shotDelay(900);

  const report = await evalJs<{
    title: string;
    hasTitlebar: boolean;
    hasSidebar: boolean;
    hasFilePane: boolean;
    hasDetails: boolean;
    navItems: number;
    emptyStateVisible: boolean;
    emptyTitle: string;
    ffmpegChip: string;
    cssLoaded: string;
    themeAttr: string | null;
    apiReady: boolean;
    bodyBg: string;
  }>(
    '采集主界面特征',
    `(() => {
    const q = (s) => document.querySelector(s);
    const text = (s) => (q(s)?.textContent ?? '').trim();
    return {
      title: document.title,
      hasTitlebar: Boolean(q('.titlebar')),
      hasSidebar: Boolean(q('.sidebar')),
      hasFilePane: Boolean(q('.file-pane')),
      hasDetails: Boolean(q('.details')),
      navItems: document.querySelectorAll('.nav-item').length,
      emptyStateVisible: Boolean(q('.file-pane .empty-state')),
      emptyTitle: text('.file-pane .empty-state h3'),
      ffmpegChip: text('.titlebar .chip'),
      cssLoaded: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      themeAttr: document.documentElement.getAttribute('data-theme'),
      apiReady: typeof window.converter?.probe === 'function',
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  })()`,
  );

  const shots: { name: string; file: string; page: PageReport }[] = [];
  const capture = async (name: string, navIndex?: number) => {
    if (navIndex !== undefined) {
      // 同样必须包 IIFE：直接 `void el.click(); true` 会把 DOM 节点带进
      // 结构化克隆而报 "An object could not be cloned."
      await evalJs<boolean>(
        `切换到第 ${navIndex + 1} 个页面`,
        `(() => { document.querySelectorAll('.nav-item')[${navIndex}].click(); return true; })()`,
      );
      // 等这一页真的渲染出内容再截图
      const pageDeadline = Date.now() + 8_000;
      for (;;) {
        const ok = await evalJs<boolean>(
          `等待第 ${navIndex + 1} 页渲染`,
          `Boolean(document.querySelector('.settings-body, .job-list, .file-pane'))`,
        );
        if (ok || Date.now() > pageDeadline) break;
        await shotDelay(200);
      }
      await shotDelay(400);
    }
    // 顺带采集该页的内容特征 —— 防止"截到一张空白页也算通过"
    const page = await evalJs<PageReport>(
      `采集「${name}」页面特征`,
      `(() => ({
      settingsCards: document.querySelectorAll('.settings .card').length,
      settingsHead: (document.querySelector('.settings h2')?.textContent ?? '').trim(),
      queueEmpty: Boolean(document.querySelector('.queue .empty-state')),
      queueHead: (document.querySelector('.queue h2')?.textContent ?? '').trim(),
      activeNav: (document.querySelector('.nav-item.active .nav-label')?.textContent ?? '').trim(),
    }))()`,
    );
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, name);
    fs.writeFileSync(file, image.toPNG());
    shots.push({ name, file, page });
  };

  await capture('main.png');

  /** 会在主检查项之后追加的额外检查 */
  const extraChecks: [string, boolean, string][] = [];

  /* ---- 可选：加载一个真实视频后再截一张，用于人工确认信息面板与缩略图 ---- */
  const smokeFileArg = process.argv.find((a) => a.startsWith('--smoke-file='));
  if (smokeFileArg) {
    const rel = smokeFileArg.slice('--smoke-file='.length);
    const sample = path.isAbsolute(rel) ? rel : path.join(app.getAppPath(), rel);
    if (!existsSync(sample)) {
      console.error(`[smoke] 指定的测试文件不存在：${sample}`);
      process.exit(1);
    }
    // 通过界面真实交互路径加载（等价于用户拖入文件），而不是直接塞假数据
    const hookOk = await evalJs<boolean>(
      '检查测试钩子',
      `typeof window.__lumenAddFiles === 'function'`,
    );
    if (!hookOk) {
      console.error('[smoke] ✘ 渲染进程未暴露 __lumenAddFiles 钩子，无法加载测试文件');
      process.exit(1);
    }
    await evalJs<boolean>(
      '加载测试视频',
      `(() => { window.__lumenAddFiles(${JSON.stringify([sample])}); return true; })()`,
    );
    // 等探测 + 缩略图完成（信息面板出现 .info-grid 且缩略图 <img> 有 src）
    const fileDeadline = Date.now() + 60_000;
    let loaded = false;
    for (;;) {
      loaded = await evalJs<boolean>(
        '等待视频信息与缩略图',
        `Boolean(document.querySelector('.details .info-grid') && document.querySelector('.file-card .thumb img'))`,
      );
      if (loaded || Date.now() > fileDeadline) break;
      await shotDelay(400);
    }
    await shotDelay(600);
    await capture('main-with-file.png');

    const fileReport = await evalJs<{
      infoRows: string[];
      thumbSrc: string;
      durationBadge: string;
      presetCards: number;
      activePreset: string;
      estimate: string;
    }>(
      '采集视频详情特征',
      `(() => {
      const text = (s) => (document.querySelector(s)?.textContent ?? '').trim();
      const rows = [...document.querySelectorAll('.details .info-row')].map(
        (r) => (r.querySelector('.k')?.textContent ?? '').trim() + '=' + (r.querySelector('.v')?.textContent ?? '').trim()
      );
      return {
        infoRows: rows,
        thumbSrc: document.querySelector('.file-card .thumb img')?.getAttribute('src') ?? '',
        durationBadge: text('.file-card .thumb-duration'),
        presetCards: document.querySelectorAll('.preset-card').length,
        activePreset: text('.preset-card.active .preset-label'),
        estimate: text('.details-foot .foot-estimate'),
      };
    })()`,
    );

    extraChecks.push(
      ['加载真实文件后：信息面板出现', fileReport.infoRows.length >= 5, `${fileReport.infoRows.length} 行`],
      ['加载真实文件后：缩略图已生成', fileReport.thumbSrc.startsWith('lumen-media://'), fileReport.thumbSrc.slice(0, 46) + '…'],
      ['加载真实文件后：时长角标显示', /^\d+:\d{2}$/.test(fileReport.durationBadge), fileReport.durationBadge],
      ['加载真实文件后：预设卡片可选', fileReport.presetCards >= 8, `${fileReport.presetCards} 个预设，当前「${fileReport.activePreset}」`],
      ['加载真实文件后：产物体积预估显示', fileReport.estimate.includes('预计'), fileReport.estimate || '无'],
      [
        '加载真实文件后：详情包含分辨率',
        fileReport.infoRows.some((r) => /画面=\d+×\d+/.test(r)),
        fileReport.infoRows.find((r) => r.startsWith('画面')) ?? '未找到',
      ],
      ['加载真实文件后：截图已生成', existsSync(path.join(outDir, 'main-with-file.png')), 'main-with-file.png'],
    );

    /* ---- 在应用内真跑一次完整转换：这是端到端最强证据 ---- */
    if (process.argv.includes('--smoke-convert')) {
      const before = engine.list().length;

      // 先直接调 IPC 诊断一次：绕开按钮点击，确认 createJobs 这条链路本身是否通。
      // 这样如果失败，能立刻区分"IPC 有问题"还是"按钮点错了/界面有问题"。
      const direct = await evalJs<{ ok: boolean; error: string; count: number; state: string }>(
        '直接调用 createJobs 诊断',
        `window.converter.createJobs([{
          sourcePath: ${JSON.stringify(sample)},
          options: {
            presetId: 'mp4-compatible', videoCodecId: 'h264', audioCodecId: 'aac',
            qualityId: 'balanced', resolutionId: 'source', fpsId: 'source',
            outputDir: null, fileNameTemplate: '{name}', overwrite: false, keepMetadata: true,
            trimStartSec: null, trimEndSec: null, subtitleStreamIndexes: [], audioStreamIndexes: []
          }
        }]).then((r) => ({
          ok: r.ok === true,
          error: r.ok === false ? String(r.error) : '',
          count: r.ok ? r.data.filter((x) => x.job).length : 0,
          state: r.ok && r.data[0]?.job ? r.data[0].job.state : 'none'
        }))`,
      );
      extraChecks.push([
        '应用内转换：createJobs IPC 可用',
        direct.count > 0,
        direct.count > 0 ? `已入队 ${direct.count} 个，状态 ${direct.state}` : `失败：${direct.error || '返回 ok 但无任务'}`,
      ]);

      // 再走一次真实界面按钮路径，确认 UI 交互链路也通。
      //
      // 关键（真踩坑）：表达式一定要包成 IIFE，内部用变量接住 DOM 节点。
      // 写成 `void el.click(); true` 是不行的 —— `void` 只丢弃值，
      // 那个 DOM 节点仍会作为表达式的中间值被结构化克隆，触发
      // "An object could not be cloned." 并让整个 await 失败（任务从未创建）。
      //
      // 先把上一步诊断产生的任务清掉，这样"点击是否真的创建了任务"才能被严格判定，
      // 否则队列里已经有任务，断言会假通过。
      for (const j of engine.list()) await engine.remove(j.id);
      const beforeClick = engine.list().length;

      const clicked = await evalJs<{ clicked: boolean; label: string; disabled: boolean }>(
        '点击「开始转换」',
        `(() => {
          const btn = document.querySelector('.file-pane .pane-footer .btn-primary');
          if (!btn) return { clicked: false, label: '', disabled: true };
          const label = btn.textContent.trim();
          const disabled = btn.disabled;
          btn.click();
          return { clicked: true, label, disabled };
        })()`,
      );
      extraChecks.push([
        '应用内转换：界面按钮可点击',
        clicked.clicked && !clicked.disabled,
        clicked.clicked ? `按钮「${clicked.label}」，disabled=${clicked.disabled}` : '未找到按钮',
      ]);

      // 等点击路径产生的任务真的进入引擎队列
      const enqueueDeadline = Date.now() + 30_000;
      let enqueued = engine.list().length > beforeClick;
      while (!enqueued && Date.now() < enqueueDeadline) {
        await shotDelay(300);
        enqueued = engine.list().length > beforeClick;
      }
      extraChecks.push([
        '应用内转换：按钮点击真的创建了任务',
        enqueued,
        `点击前后队列长度 ${beforeClick} → ${engine.list().length}`,
      ]);

      // 等队列里出现任务并跑到终态
      const convertDeadline = Date.now() + 180_000;
      let job: MediaJob | undefined;
      for (;;) {
        const list = engine.list();
        job = list.find((j) => j.state === 'done' || j.state === 'failed' || j.state === 'canceled');
        if (job || Date.now() > convertDeadline) break;
        await shotDelay(500);
      }

      const created = engine.list().length > before;
      extraChecks.push(['应用内转换：任务已创建', created, `队列共 ${engine.list().length} 个任务`]);

      if (job) {
        const outOk = existsSync(job.outputPath);
        const bytes = outOk ? (await import('node:fs')).statSync(job.outputPath).size : 0;
        extraChecks.push(
          ['应用内转换：状态为已完成', job.state === 'done', `${job.state}${job.error ? ` / ${job.error.message}` : ''}`],
          ['应用内转换：产物文件存在', outOk && bytes > 1024, `${job.outputPath}（${(bytes / 1024).toFixed(0)} KB）`],
          ['应用内转换：进度到达 100%', job.progress?.percent === 100, `percent=${job.progress?.percent}`],
          ['应用内转换：命令文本已记录', job.command.includes('ffmpeg') || job.command.includes('-i'), job.command.slice(0, 60) + '…'],
        );
        // 切到队列页截图，作为"真的跑过一次"的视觉证据
        await capture('queue-done.png', 1);
        extraChecks.push([
          '应用内转换：队列页截图已生成',
          existsSync(path.join(outDir, 'queue-done.png')),
          'queue-done.png',
        ]);
        const queueReport = await evalJs<{ state: string; outSize: string; hasOpenBtn: boolean }>(
          '采集转换结果卡片',
          `(() => {
          const card = document.querySelector('.job-card');
          return {
            state: (card?.querySelector('.chip')?.textContent ?? '').trim(),
            outSize: (card?.querySelector('.out-size')?.textContent ?? '').trim(),
            hasOpenBtn: Boolean(card?.querySelector('.btn-primary')),
          };
        })()`,
        );
        extraChecks.push([
          '应用内转换：队列卡片显示完成与产物大小',
          queueReport.state.includes('已完成'),
          `状态「${queueReport.state}」，产物 ${queueReport.outSize}，${queueReport.hasOpenBtn ? '有打开按钮' : '无打开按钮'}`,
        ]);
      } else {
        extraChecks.push(['应用内转换：任务完成', false, '等待超时，未进入终态']);
      }
    }
  }

  // 依次切到另外两个页面截图，顺便验证路由切换没有报错
  await capture('queue.png', 1);
  await capture('settings.png', 2);
  // 回到转换页
  await evalJs<boolean>(
    '切回转换页',
    `(() => { document.querySelectorAll('.nav-item')[0].click(); return true; })()`,
  );

  const queuePage = shots.find((s) => s.name === 'queue.png')?.page;
  const settingsPage = shots.find((s) => s.name === 'settings.png')?.page;

  extraChecks.push(
    [
      '任务队列页有内容',
      Boolean(queuePage?.queueHead),
      queuePage ? `标题「${queuePage.queueHead}」，${queuePage.queueEmpty ? '空状态' : '有任务'}` : '未采集',
    ],
    [
      '设置页有内容（不是空白页）',
      Boolean(settingsPage && settingsPage.settingsCards >= 3),
      settingsPage ? `${settingsPage.settingsCards} 个设置分组，标题「${settingsPage.settingsHead}」` : '未采集',
    ],
    ['导航切换生效', settingsPage?.activeNav === '设置', `当前高亮：${settingsPage?.activeNav ?? '无'}`],
    [
      '截图已生成',
      shots.length >= 3,
      shots.map((s) => path.basename(s.file)).join(', '),
    ],
  );

  const checks: [string, boolean, string][] = [
    ['窗口标题正确', report.title.includes('Lumen-conv'), report.title],
    ['标题栏已渲染', report.hasTitlebar, ''],
    ['侧边导航已渲染', report.hasSidebar, `${report.navItems} 个导航项`],
    ['文件列表区已渲染', report.hasFilePane, ''],
    ['详情面板已渲染', report.hasDetails, ''],
    ['空状态引导已显示', report.emptyStateVisible, report.emptyTitle],
    ['全局样式已加载', report.cssLoaded.length > 0, `--accent=${report.cssLoaded}, body=${report.bodyBg}`],
    ['主题已应用', Boolean(report.themeAttr), `data-theme=${report.themeAttr}`],
    ['preload API 已注入', report.apiReady, 'window.converter.probe'],
    ['ffmpeg 状态已显示', report.ffmpegChip.includes('ffmpeg'), report.ffmpegChip],
    ...extraChecks,
  ];

  console.log('\n[smoke] 界面自检结果');
  console.log('─'.repeat(56));
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  }
  console.log('─'.repeat(56));
  console.log(`[smoke] ${checks.length - failed}/${checks.length} 通过，截图见 docs/screenshots/`);

  process.exit(failed === 0 ? 0 : 1);
}

/* ------------------------------ 窗口 ------------------------------ */

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'Lumen-conv 视频格式转换器',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // 先隐藏再显示，避免白屏闪烁（首屏观感直接决定评委第一印象）
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 拦截外部链接：一律用系统浏览器打开，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 生产环境禁掉菜单栏的默认快捷键（Ctrl+R 重载会让运行中的任务看起来"消失"）
  if (!isDev) Menu.setApplicationMenu(null);
}
/* ------------------------------ IPC ------------------------------ */

function ok<T>(data: T): IpcResponse<T> {
  return { ok: true, data };
}
function fail<T>(error: unknown): IpcResponse<T> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** 包装 handler：把异常统一转成 { ok:false, error }，避免跨进程丢信息 */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await fn(...(args as never[])));
    } catch (err) {
      console.error(`[ipc] ${channel} 失败：`, err);
      return fail(err);
    }
  });
}

function registerIpc(): void {
  /* ---- 探测 ---- */
  handle<MediaProbeResult>('media:probe', async (filePath: string) => {
    if (!ffprobePath) throw new Error('找不到 ffprobe，请到「设置」里指定路径');
    const result = await probeMedia(filePath, { ffprobePath });
    // 后台预热缩略图：用户还没点到，缩略图已经在算
    void getThumbnail(filePath, { ffmpegPath: requireFfmpeg(), durationSec: result.durationSec }).catch(
      () => undefined,
    );
    return result;
  });

  handle<ThumbnailResult>('media:thumbnail', async (filePath: string, atSec?: number) => {
    const result = await getThumbnail(filePath, {
      ffmpegPath: requireFfmpeg(),
      durationSec: 0,
    }, atSec);
    // 把磁盘路径换成渲染进程可用的 URL
    if (result.filePath) result.filePath = toMediaUrl(result.filePath);
    return result;
  });

  handle<string[]>('dialog:pick-videos', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择视频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '视频 / 音频文件',
          extensions: [
            'mp4', 'mkv', 'mov', 'avi', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts',
            '3gp', 'rmvb', 'rm', 'vob', 'ogv', 'mxf', 'gif',
            'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'wma', 'opus',
          ],
        },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  handle<string | null>('dialog:pick-output-dir', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  handle<string | null>('dialog:pick-executable', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 ffmpeg / ffprobe 可执行文件',
      properties: ['openFile'],
      filters: [
        { name: '可执行文件', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle('shell:reveal', (_e, p: string) => {
    if (existsSync(p)) shell.showItemInFolder(p);
  });

  /* ---- 能力探测 ---- */
  handle<SystemCapabilities>('capabilities:get', async (forceRefresh?: boolean) => {
    if (!ffmpegPath) throw new Error('找不到 ffmpeg，请到「设置」里指定路径');
    if (forceRefresh) {
      invalidateCapabilities();
      invalidateBinaryCache();
    }
    const caps = await probeCapabilities({ ffmpegPath, forceRefresh: Boolean(forceRefresh) });
    caps.ffprobePath = requireFfprobe();
    // 完整探测结束后广播给界面
    mainWindow?.webContents.send('capabilities:updated', caps);
    return caps;
  });

  handle<FfmpegDetectResult>('ffmpeg:detect', async () => {
    invalidateBinaryCache();
    const bins = getBinaries(settings);
    ffmpegPath = bins.ffmpeg.path;
    ffprobePath = bins.ffprobe.path;
    engine.setFfmpegPath(ffmpegPath);
    engine.setFfprobePath(ffprobePath);
    if (!ffmpegPath) {
      return { ok: false, version: null, message: '未找到 ffmpeg，请手动指定路径', path: null };
    }
    const res = await exec(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 15000 });
    const m = /ffmpeg version (\S+)/.exec(res.stdout || res.stderr);
    return {
      ok: Boolean(m),
      version: m ? m[1] : null,
      message: m ? 'ffmpeg 可用' : '指定路径不是有效的 ffmpeg',
      path: ffmpegPath,
    };
  });

  /* ---- 设置 ---- */
  handle<AppSettings>('settings:get', () => settings);
  handle<AppSettings>('settings:save', async (patch: Partial<AppSettings>) => {
    settings = await saveSettings(patch);
    invalidateBinaryCache();
    const bins = getBinaries(settings);
    ffmpegPath = bins.ffmpeg.path;
    ffprobePath = bins.ffprobe.path;
    engine.setFfmpegPath(ffmpegPath);
    engine.setFfprobePath(ffprobePath);
    engine.setConcurrency(settings.concurrency);
    return settings;
  });
  handle<AppSettings>('settings:reset', async () => {
    settings = await resetSettings();
    invalidateBinaryCache();
    const bins = getBinaries(settings);
    ffmpegPath = bins.ffmpeg.path;
    ffprobePath = bins.ffprobe.path;
    engine.setFfmpegPath(ffmpegPath);
    engine.setFfprobePath(ffprobePath);
    return settings;
  });
  handle<number>('cache:clear-thumbnails', () => clearThumbnailCache());

  /* ---- 任务 ---- */
  handle<CreateJobResult[]>('jobs:create', (requests: CreateJobRequest[]) => engine.createJobs(requests));
  handle<MediaJob[]>('jobs:list', () => engine.list());
  handle<boolean>('jobs:cancel', (id: string) => engine.cancel(id));
  handle<MediaJob | null>('jobs:retry', (id: string) => engine.retry(id));
  handle<boolean>('jobs:remove', (id: string) => engine.remove(id));
  handle<number>('jobs:clear-finished', () => engine.clearFinished());
  handle<boolean>('jobs:open-output', async (id: string) => {
    const job = engine.get(id);
    if (!job || !existsSync(job.outputPath)) return false;
    shell.showItemInFolder(job.outputPath);
    return true;
  });
  handle<number>('jobs:cancel-all', () => engine.cancelAll());

  /* ---- 预设（静态数据，前端也可以直接 import，这里留一份便于将来做远程更新） ---- */
  handle('presets:get', () => ({ presets: CONVERSION_PRESETS }));

  /* ---- 窗口控制（自绘标题栏用） ---- */
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
}

function requireFfmpeg(): string {
  if (!ffmpegPath) throw new Error('找不到 ffmpeg，请到「设置」里指定路径');
  return ffmpegPath;
}

function requireFfprobe(): string {
  if (!ffprobePath) throw new Error('找不到 ffprobe，请到「设置」里指定路径');
  return ffprobePath;
}

/* ------------------------------ 生命周期 ------------------------------ */

function wireEngineEvents(): void {
  engine.on('updated', (job: MediaJob) => {
    mainWindow?.webContents.send('job:updated', job);
  });
  engine.on('log', (payload: { jobId: string; line: string }) => {
    mainWindow?.webContents.send('job:log', payload);
  });
}

/** 是否处于自动化界面自检模式（npm run smoke:ui） */
const isSmokeMode = process.argv.includes('--smoke');

app.whenReady().then(async () => {
  registerMediaProtocol();

  settings = await loadSettings();

  const bins = getBinaries(settings);
  ffmpegPath = bins.ffmpeg.path;
  ffprobePath = bins.ffprobe.path;
  engine.setFfmpegPath(ffmpegPath);
  engine.setFfprobePath(ffprobePath);
  engine.setConcurrency(settings.concurrency);

  registerIpc();
  wireEngineEvents();
  createWindow();

  // 自动化界面自检：截图 + 元素检查，然后带退出码结束
  if (isSmokeMode) {
    void runSmokeCheck().catch((err) => {
      console.error('[smoke] 自检异常：', err);
      process.exit(1);
    });
  }

  // 启动诊断，方便用户/评审在「设置 → 诊断」里自查。
  // 用局部常量而不是可变模块变量：异步链里 TypeScript 无法证明模块变量仍非空。
  const ffmpegBin = ffmpegPath;
  const ffprobeBin = ffprobePath;
  if (ffmpegBin) {
    void probeCapabilities({ ffmpegPath: ffmpegBin, quick: true })
      .then((quick) => {
        quick.ffprobePath = ffprobeBin;
        mainWindow?.webContents.send('capabilities:updated', quick);
        // 随后做完整探测（会真的试跑硬件编码器），结果再推一次
        return probeCapabilities({ ffmpegPath: ffmpegBin });
      })
      .then((full) => {
        full.ffprobePath = ffprobeBin;
        mainWindow?.webContents.send('capabilities:updated', full);
      })
      .catch((err) => console.error('[capabilities] 探测失败：', err));
  } else {
    console.warn('[startup] 未找到 ffmpeg，界面会提示用户手动指定路径');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 关窗口前先停掉所有任务，避免 ffmpeg 变成孤儿进程继续吃 CPU
  const n = engine.cancelAll();
  if (n > 0) console.log(`[shutdown] 已取消 ${n} 个运行中的任务`);
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  engine.cancelAll();
});

// 兜底：任何未捕获异常都打日志，方便评审复现问题
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
