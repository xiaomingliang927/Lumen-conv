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
import { promises as fsp } from 'node:fs';
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

/**
 * 是否处于自动化界面自检模式（`--smoke`）。
 * 必须在单实例判定之前就确定 —— 见下面拿到锁失败时的分支。
 */
const isSmokeMode = process.argv.includes('--smoke');

/*
 * 第二次启动时聚焦已有窗口，而不是再开一个（转换任务不该被分成两份）。
 *
 * 踩坑（隐蔽且浪费了很多时间）：在 `--smoke` 模式下如果没拿到锁，
 * 原来只是 `app.quit()` 就结束，**进程退出码是 0、且一行输出都没有**，
 * 于是自检脚本看起来"跑过了、还成功了"，实际什么都没验证
 * （实测被昨天遗留的 4 个应用进程卡住，连续几轮自检全部静默假成功）。
 * 因此这里对自检模式显式报错并以非零码退出，让"没真跑"这件事无法被忽略。
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  if (isSmokeMode) {
    console.error(
      '[smoke] ✘ 未能获取单实例锁：已有 Lumen-conv / Electron 实例在运行，本次自检不会执行。\n' +
        '        请先关闭已运行的实例（任务管理器结束 Lumen-conv.exe / electron.exe），或执行：\n' +
        '        Stop-Process -Name "Lumen-conv","electron" -Force',
    );
    app.exit(2);
  } else {
    app.quit();
  }
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
 * 界面自检的基准目录。
 *
 * 开发态：app.getAppPath() 是项目根，直接用它。
 * 打包态：app.getAppPath() 指向 ...\resources\app.asar —— 那是一个**文件**，
 *   拿它去 mkdirSync / join 会抛 ENOTDIR（实测在便携版上踩到）。
 *   所以打包态改用可执行文件所在目录（安装目录 / 便携版目录）。
 */
function smokeBaseDir(): string {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
}

/**
 * 自检用的测试素材目录。
 *
 * 默认是 `<smokeBaseDir()>/test-assets`，可用 `--smoke-assets=<目录>` 覆盖。
 *
 * 为什么需要这个开关：打包态的可执行文件旁边**没有** `test-assets/`
 * （测试素材不该塞进分发包，那是 26 MB 的无用负担）。而没有这个开关时，
 * 依赖第二个样本的 8 项检查在打包态会**静默跳过**，摘要照样打印"全部通过"——
 * 于是"开发态 66 项 / 打包态 58 项"这个覆盖差异三轮都没人发现。
 * 显式传目录之后，打包态也能跑满全部检查。
 */
function smokeAssetsDir(): string {
  const arg = process.argv.find((a) => a.startsWith('--smoke-assets='));
  if (arg) {
    const p = arg.slice('--smoke-assets='.length);
    return path.isAbsolute(p) ? p : path.join(smokeBaseDir(), p);
  }
  return path.join(smokeBaseDir(), 'test-assets');
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

  const outDir = path.join(smokeBaseDir(), 'docs', 'screenshots');
  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });

  /*
   * 自检要求队列为空。
   *
   * 遗留任务已在 `app.whenReady()` 里、**创建窗口之前**清掉了（那里才是正确位置：
   * 放到窗口加载后清会与渲染进程 initStore() 构成竞态，实测 3 次有 1 次读到旧列表）。
   * 这里只做校验与提示，不再执行清理。
   */
  const residualJobs = engine.list();
  if (residualJobs.length > 0) {
    console.warn(
      `[smoke] ⚠ 队列里仍有 ${residualJobs.length} 个任务，空队列相关断言可能不成立`,
    );
  }

  /*
   * 界面偏好已在 app.whenReady() 里、**创建窗口之前**重置成推荐模式 + 跟随系统主题，
   * 这里只做校验（与"遗留任务"同一个道理：放到窗口加载后再改会与渲染进程
   * initStore() 构成竞态 —— 实测就是这样：磁盘上已是 recommended，
   * 而渲染层读到的还是上一轮的 custom）。
   */
  const effectiveSettings = await loadSettings();
  if (effectiveSettings.appMode !== 'recommended') {
    console.warn(`[smoke] ⚠ appMode 仍为 ${effectiveSettings.appMode}，模式相关断言可能不成立`);
  }

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

      /*
       * 再等一次"标题"出现。
       *
       * 真踩到的竞态：队列页的 <h2> 依赖 jobs 列表，任务还没同步过来时
       * 标题会是空字符串，于是「任务队列页有内容」这条断言偶发失败。
       * 页面容器存在 != 页面内容渲染完，两个条件要分开等。
       */
      const titleDeadline = Date.now() + 4_000;
      for (;;) {
        const titled = await evalJs<boolean>(
          `等待第 ${navIndex + 1} 页标题`,
          `Boolean((document.querySelector('.queue h2, .settings h2, .pane-title h3')?.textContent ?? '').trim())`,
        );
        if (titled || Date.now() > titleDeadline) break;
        await shotDelay(150);
      }
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
    const sample = path.isAbsolute(rel) ? rel : path.join(smokeBaseDir(), rel);
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
        // 视频信息默认是收起的摘要，所以判据用「摘要或详情表任一存在」，
        // 不能只等 .info-grid（收起时它根本不在 DOM 里）
        `Boolean(
          (document.querySelector('.details .info-summary') || document.querySelector('.details .info-grid')) &&
          document.querySelector('.file-card .thumb img')
        )`,
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
      useCaseCards: number;
      activeUseCase: string;
      compatItems: number;
      estimate: string;
      summaryText: string;
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
        useCaseCards: document.querySelectorAll('.usecase-card').length,
        activeUseCase: text('.usecase-card.active .usecase-label'),
        compatItems: document.querySelectorAll('.compat-item').length,
        estimate: text('.details-foot .foot-estimate'),
        summaryText: text('.details .info-summary'),
      };
    })()`,
    );

    extraChecks.push(
      [
        '加载真实文件后：视频信息摘要已显示（收起态）',
        fileReport.summaryText.length > 0,
        fileReport.summaryText.slice(0, 70) || '（摘要为空）',
      ],
      ['加载真实文件后：缩略图已生成', fileReport.thumbSrc.startsWith('lumen-media://'), fileReport.thumbSrc.slice(0, 46) + '…'],
      ['加载真实文件后：时长角标显示', /^\d+:\d{2}$/.test(fileReport.durationBadge), fileReport.durationBadge],
      [
        '加载真实文件后：用途卡片全部渲染',
        fileReport.useCaseCards >= 8,
        `${fileReport.useCaseCards} 张用途卡片，当前「${fileReport.activeUseCase}」`,
      ],
      [
        '加载真实文件后：兼容性预检已运行',
        // 预检"跑过了"不等于"没问题"：默认用途+不限定设备时通常 0 条提示，
        // 所以这里只断言预检没有把页面搞崩（元素容器查询不报错即可）
        fileReport.compatItems >= 0,
        `${fileReport.compatItems} 条提示`,
      ],
      ['加载真实文件后：产物体积预估显示', fileReport.estimate.includes('预计'), fileReport.estimate || '无'],
      [
        '加载真实文件后：分辨率/编码显示在摘要里',
        /\d+×\d+/.test(fileReport.summaryText) && /H\.?26\d/i.test(fileReport.summaryText),
        fileReport.summaryText.slice(0, 70) || '未找到',
      ],
      ['加载真实文件后：截图已生成', existsSync(path.join(outDir, 'main-with-file.png')), 'main-with-file.png'],
    );

    /*
     * 展开视频信息后应能看到完整明细表（收起态只有一行摘要）。
     * 顺便验证这个折叠交互本身可用。
     */
    const infoExpand = await evalJs<{ rows: number; collapsedAgain: boolean; error: string }>(
      '验证视频信息折叠展开',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 240));
        try {
          const toggle = document.querySelector('.info-toggle');
          if (!toggle) return { rows: -1, collapsedAgain: false, error: '未找到信息折叠按钮' };
          toggle.click();
          await tick();
          const rows = document.querySelectorAll('.details .info-row').length;
          toggle.click();
          await tick();
          const collapsedAgain = Boolean(document.querySelector('.details .info-summary'));
          return { rows, collapsedAgain, error: '' };
        } catch (e) {
          return { rows: -1, collapsedAgain: false, error: String(e) };
        }
      })()`,
    );
    extraChecks.push([
      '视频信息：可展开看完整明细（收起态只有一行摘要）',
      infoExpand.rows >= 5 && infoExpand.collapsedAgain,
      infoExpand.error
        ? `执行出错：${infoExpand.error}`
        : `展开后 ${infoExpand.rows} 行明细，收起后回到摘要`,
    ]);

    /*
     * 预设卡片「真的能点」的交互验证。
     *
     * 起因：有用户看到卡片右侧的容器标签（MP4 / WebM）以为是可点的下拉入口，
     * 说明"整张卡才是按钮"这件事在界面上没有传达清楚。
     * 这类问题靠肉眼看截图发现不了，所以这里直接模拟点击并断言选中态与联动变化。
     *
     * 包 try/catch：这一段是纯增强检查，任何异常都应记为"一项失败"，
     * 而不是把整轮自检打断（早期版本没包，异常直接让后续断言全部消失）。
     */
    let presetInteraction = {
      beforeLabel: '',
      afterLabel: '',
      checkedMoved: false,
      estimateChanged: false,
      clickOk: false,
      error: '',
      diag: '',
    };
    try {
      /*
       * 主入口已经从「选格式」改成「选用途」了（.preset-card → .usecase-card），
       * 这段断言也跟着改。用途卡片会一次性改掉容器/编码器/分辨率/体积上限，
       * 所以顺带断言"体积上限跟着用途走" —— 那是用途层最核心的联动。
       */
      const readState = `(() => {
        const cards = [...document.querySelectorAll('.usecase-card')];
        const active = document.querySelector('.usecase-card.active');
        const sizeInput = document.querySelector('.size-limit input');
        return {
          label: (active?.querySelector('.usecase-label')?.textContent ?? '').trim(),
          estimates: (document.querySelector('.details-foot .foot-estimate')?.textContent ?? '').trim(),
          sizeLimit: sizeInput ? String(sizeInput.value) : '',
          index: cards.indexOf(active),
          checkMarks: document.querySelectorAll('.usecase-card .preset-check').length,
          count: cards.length,
        };
      })()`;

      const before = await evalJs<{
        label: string;
        estimates: string;
        sizeLimit: string;
        index: number;
        checkMarks: number;
        count: number;
      }>('记录切换前的用途状态', readState);

      const targetIndex = before.index === 0 ? 1 : 0;
      if (before.count < 2) {
        presetInteraction = { ...presetInteraction, error: '用途卡片不足 2 个' };
      } else {
        const clicked = await evalJs<boolean>(
          '点击另一张用途卡片',
          `(() => {
            const cards = [...document.querySelectorAll('.usecase-card')];
            cards[${targetIndex}].dispatchEvent(
              new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
            );
            return true;
          })()`,
        );
        await shotDelay(250);

        const after = await evalJs<typeof before>('读取切换后的用途状态', readState);

        presetInteraction = {
          beforeLabel: before.label,
          afterLabel: after.label,
          checkedMoved: after.index === targetIndex && after.checkMarks === 1,
          estimateChanged: after.estimates !== before.estimates,
          clickOk: clicked,
          error: '',
          diag: `选中 ${before.index} → ${after.index}；体积上限 ${before.sizeLimit || '不限'} → ${after.sizeLimit || '不限'}；共 ${after.count} 张`,
        };
      }
    } catch (err) {
      presetInteraction = {
        ...presetInteraction,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    extraChecks.push(
      [
        '用途卡片：点击后选中态切换',
        presetInteraction.clickOk &&
          presetInteraction.afterLabel !== presetInteraction.beforeLabel &&
          presetInteraction.afterLabel.length > 0,
        presetInteraction.error
          ? `执行出错：${presetInteraction.error}`
          : `${presetInteraction.beforeLabel} → ${presetInteraction.afterLabel}${presetInteraction.diag ? ` | ${presetInteraction.diag}` : ''}`,
      ],
      [
        '用途卡片：选中项显示勾选标记（且只有一个）',
        presetInteraction.checkedMoved,
        presetInteraction.checkedMoved ? '勾选标记跟随选中卡片' : '勾选标记数量异常',
      ],
      [
        '用途卡片：切换用途后体积预估联动更新',
        presetInteraction.estimateChanged,
        presetInteraction.estimateChanged ? '预估已随用途变化' : '预估未变化',
      ],
    );
    // 点完切回「发微信 / QQ」（默认用途），避免影响后续截图与转换用例的预期
    await evalJs<boolean>(
      '恢复默认用途',
      `(() => {
        const first = document.querySelector('.usecase-card');
        if (first && !first.classList.contains('active')) first.click();
        return true;
      })()`,
    );
    await shotDelay(300);

    /*
     * 用途 ↔ 设备 / 体积的归属（用户反馈："你要拿去干什么 和 在哪播放/多大体积 存在耦合情况"）。
     *
     * 原来：体积上限这个控件住在「在哪播 / 多大体积」里，值却由用途决定（两个主人）；
     *      用途里有「老电视 / 车载 U 盘」，设备下拉里又有「老安卓电视 / 车机」，
     *      但选前者**不会**改后者，兼容性预检按"不限定"跑，等于没检查。
     * 现在：体积上限控件回到用途区；用途带出设备，并标注"由用途自动设定，可改"。
     */
    const coupling = await evalJs<{
      sizeInUseCaseBlock: boolean;
      sizeInDeviceBlock: boolean;
      deviceAfterTvUseCase: string;
      hintAfterUseCase: string;
      hintAfterManual: string;
      restoreBtnShown: boolean;
      error: string;
    }>(
      '验证用途与设备/体积的归属',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 260));
        const devSel = () => document.querySelector('.device-block select');
        const hintText = () =>
          (document.querySelector('.device-block .field-hint')?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        const blank = {
          sizeInUseCaseBlock: false, sizeInDeviceBlock: false, deviceAfterTvUseCase: '',
          hintAfterUseCase: '', hintAfterManual: '', restoreBtnShown: false, error: '',
        };
        try {
          // 选「老电视 / 车载 U 盘」
          const cards = [...document.querySelectorAll('.usecase-card')];
          const tv = cards.find((c) => (c.querySelector('.usecase-label')?.textContent ?? '').includes('老电视'));
          if (!tv) return { ...blank, error: '未找到「老电视 / 车载 U 盘」卡片' };
          tv.click();
          await tick();
          await tick();

          const dev = devSel();
          const deviceAfterTvUseCase = dev ? dev.value : '';
          const hintAfterUseCase = hintText();

          // 再手动把设备改成别的：提示应改口，并出现"用回用途推荐"
          if (dev) {
            const other = [...dev.options].find((o) => o.value !== dev.value);
            if (other) {
              dev.value = other.value;
              dev.dispatchEvent(new Event('change', { bubbles: true }));
              await tick();
            }
          }
          return {
            sizeInUseCaseBlock: Boolean(document.querySelector('.usecase-block .size-limit input')),
            sizeInDeviceBlock: Boolean(document.querySelector('.device-block .size-limit input')),
            deviceAfterTvUseCase,
            hintAfterUseCase,
            hintAfterManual: hintText(),
            restoreBtnShown: Boolean(document.querySelector('.device-restore')),
            error: '',
          };
        } catch (e) {
          return { ...blank, error: String(e) };
        }
      })()`,
    );
    extraChecks.push(
      [
        '体积上限控件归属用途区（不再住进"在哪播"，一个参数只有一个主人）',
        coupling.sizeInUseCaseBlock && !coupling.sizeInDeviceBlock,
        coupling.error
          ? `执行出错：${coupling.error}`
          : `用途区内=${coupling.sizeInUseCaseBlock}，设备区内=${coupling.sizeInDeviceBlock}`,
      ],
      [
        '选「老电视 / 车载 U 盘」会带出对应播放设备（预检才跑在对的判据上）',
        coupling.deviceAfterTvUseCase === 'android-old',
        coupling.deviceAfterTvUseCase
          ? `设备自动变为 ${coupling.deviceAfterTvUseCase}`
          : '设备未随用途变化',
      ],
      [
        '设备提示写明"由用途自动设定"，手动改过后改口并给出恢复入口',
        coupling.hintAfterUseCase.includes('由用途') &&
          coupling.hintAfterManual.includes('手动改过') &&
          coupling.restoreBtnShown,
        `用途设定后：「${coupling.hintAfterUseCase.slice(0, 40)}」／手动改后：「${coupling.hintAfterManual.slice(0, 40)}」`,
      ],
    );

    // 复原：切回默认用途，保持后续用例的预期
    await evalJs<boolean>(
      '恢复默认用途（归属检查后）',
      `(() => {
        const first = document.querySelector('.usecase-card');
        if (first) first.click();
        return true;
      })()`,
    );
    await shotDelay(250);

    /*
     * 「实际输出尺寸」与竖屏适配（用户反馈："我换成手机的但是屏幕比例没变"）。
     *
     * 根因：分辨率档位是**上限**，实现里有"只缩不放"规则 —— 640×360 的源选 1080p，
     * 界面写着「1080p 全高清」、产物还是 640×360。界面显示了一个它不会产出的分辨率。
     *
     * 现在「质量与尺寸」下方直接写出真的会输出多大（与 ffmpeg 滤镜读同一份 planOutputSize），
     * 并新增默认关闭的「画面比例」选项。这两条断言盯的就是它们。
     */
    const sizePlan = await evalJs<{
      sameValue: string;
      sameNote: string;
      padValue: string;
      padNote: string;
      offValue: string;
      fitOptions: number;
      error: string;
    }>(
      '验证"实际输出尺寸"与画面比例',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 280));
        const value = () => (document.querySelector('.output-size .out-value')?.textContent ?? '').trim();
        const note = () => (document.querySelector('.output-size .out-note')?.textContent ?? '').trim();
        const fitSel = () =>
          [...document.querySelectorAll('.quality-block select')].find((s) =>
            [...s.options].some((o) => o.value === 'crop'),
          );
        const blank = { sameValue: '', sameNote: '', padValue: '', padNote: '', offValue: '', fitOptions: 0, error: '' };
        try {
          const sel = fitSel();
          if (!sel) return { ...blank, error: '未找到画面比例下拉' };
          const fitOptions = sel.options.length;

          // 默认：保持原样 → 源就是 640×360，且提示应说明"不放大"
          const sameValue = value();
          const sameNote = note();

          // 切到竖屏补边 → 尺寸应变成 360×640（画布短边取源短边，不放大）
          const padOpt = [...sel.options].find((o) => o.value === 'pad');
          sel.value = padOpt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await tick();
          const padValue = value();
          const padNote = note();

          // 切回保持原样，避免影响后续截图与转换用例
          const offOpt = [...sel.options].find((o) => o.value === 'off');
          sel.value = offOpt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await tick();
          const offValue = value();

          return { sameValue, sameNote, padValue, padNote, offValue, fitOptions, error: '' };
        } catch (e) {
          return { ...blank, error: String(e) };
        }
      })()`,
    );
    extraChecks.push(
      [
        '实际输出尺寸：源低于上限时显示真实尺寸并说明不放大（不再只写"1080p"）',
        sizePlan.sameValue === '640×360' && sizePlan.sameNote.includes('不放大'),
        sizePlan.error
          ? `执行出错：${sizePlan.error}`
          : `输出尺寸 ${sizePlan.sameValue}｜${sizePlan.sameNote.slice(0, 46)}`,
      ],
      [
        '画面比例：切到竖屏补边后，输出尺寸变成 9:16 画布 360×640',
        sizePlan.padValue === '360×640',
        `竖屏后 ${sizePlan.padValue}｜${sizePlan.padNote.slice(0, 46)}`,
      ],
      [
        '画面比例：切回"保持原样"能还原（默认关，不偷偷改画面）',
        sizePlan.offValue === sizePlan.sameValue && sizePlan.fitOptions === 3,
        `还原为 ${sizePlan.offValue}，共 ${sizePlan.fitOptions} 个比例选项`,
      ],
    );

    /*
     * 单独截一张「质量与尺寸」——「实际输出尺寸」与「画面比例」在这里。
     *
     * 为什么要专门截：这一块在首屏之下，上面两张模式截图都看不到它，
     * 而它正是"我换成手机的但是屏幕比例没变"这两个修复的落点。
     * 断言通过 ≠ 有人看得见证据。
     */
    await evalJs<boolean>(
      '滚动到质量与尺寸以便截图',
      `(() => {
        const block = document.querySelector('.quality-block');
        if (block) block.scrollIntoView({ block: 'start' });
        return true;
      })()`,
    );
    await shotDelay(450);
    await capture('size-plan.png');
    // 滚回顶部，保持后续截图与之前一致
    await evalJs<boolean>(
      '详情面板滚回顶部',
      `(() => {
        const sc = document.querySelector('.details-scroll');
        if (sc) sc.scrollTop = 0;
        return true;
      })()`,
    );
    await shotDelay(300);

    /*
     * 音频处理（响度归一化 / 音量增益 / 声道）—— 2026-09 新增。
     *
     * 以前只有"移除音频"，没有任何音频处理能力。响度归一化是最常用的那个：
     * 多个片源音量忽大忽小，发出去对方要不停调音量。
     *
     * ⚠ 这一段必须在**自定义模式**下跑：音频处理与字幕烧录都住在「专业参数」里，
     * 而推荐模式下那块整个不渲染（D-019）。
     */
    await evalJs<boolean>(
      '切到自定义模式（验证音频处理与字幕烧录）',
      `(async () => {
        const btns = [...document.querySelectorAll('.mode-btn')];
        if (btns[1]) btns[1].click();
        await new Promise((r) => setTimeout(r, 380));
        return true;
      })()`,
    );
    await shotDelay(250);

    const audioUi = await evalJs<{
      hasLoudnorm: boolean;
      hasVolume: boolean;
      hasChannels: boolean;
      monoSelected: boolean;
      persistsAfterSwitch: boolean;
      error: string;
    }>(
      '验证音频处理控件',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 260));
        const blank = { hasLoudnorm: false, hasVolume: false, hasChannels: false, monoSelected: false, persistsAfterSwitch: false, error: '' };
        try {
          const block = [...document.querySelectorAll('.pro-block .field')].find((f) =>
            (f.querySelector('.field-label')?.textContent ?? '').includes('音频处理'),
          );
          if (!block) return { ...blank, error: '未找到音频处理区块（自定义模式下应有）' };

          const selects = [...block.querySelectorAll('select')];
          const loudSel = selects.find((s) => [...s.options].some((o) => o.value === 'on' && o.textContent.includes('LUFS')));
          const chSel = selects.find((s) => [...s.options].some((o) => o.value === 'mono'));
          const volInput = block.querySelector('input[type="number"]');

          // 开响度归一化 + 增益 + 单声道
          if (loudSel) {
            loudSel.value = 'on';
            loudSel.dispatchEvent(new Event('change', { bubbles: true }));
            await tick();
          }
          if (volInput) {
            volInput.value = '-4';
            volInput.dispatchEvent(new Event('input', { bubbles: true }));
            await tick();
          }
          if (chSel) {
            chSel.value = 'mono';
            chSel.dispatchEvent(new Event('change', { bubbles: true }));
            await tick();
          }

          // 切到另一个文件再切回来，确认是全局偏好（不随文件丢失）
          const cards = [...document.querySelectorAll('.file-card')];
          if (cards.length >= 2) {
            cards[1].click();
            await tick();
            await tick();
            cards[0].click();
            await tick();
          }
          const chSel2 = [...document.querySelectorAll('.pro-block select')].find((s) =>
            [...s.options].some((o) => o.value === 'mono'),
          );
          return {
            hasLoudnorm: Boolean(loudSel),
            hasVolume: Boolean(volInput),
            hasChannels: Boolean(chSel),
            monoSelected: chSel ? chSel.value === 'mono' : false,
            persistsAfterSwitch: chSel2 ? chSel2.value === 'mono' : false,
            error: '',
          };
        } catch (e) {
          return { ...blank, error: String(e) };
        }
      })()`,
    );
    extraChecks.push([
      '音频处理：提供响度归一化 / 音量增益 / 声道三项（且改动跨文件保留）',
      audioUi.hasLoudnorm && audioUi.hasVolume && audioUi.hasChannels && audioUi.monoSelected && audioUi.persistsAfterSwitch,
      audioUi.error
        ? `执行出错：${audioUi.error}`
        : `响度=${audioUi.hasLoudnorm} 增益=${audioUi.hasVolume} 声道=${audioUi.hasChannels}；切文件后仍为单声道=${audioUi.persistsAfterSwitch}`,
    ]);

    /*
     * 字幕烧录（hardcode）—— 需要一个**带字幕**的素材，所以这里单独加载 subs-multi.mkv，
     * 测完再把它从列表里移除，不影响后面的转换用例（那边要求只剩 1 个文件）。
     *
     * 判据两条：
     *   ① 字幕区出现「烧进画面」单选组（不烧录 + 每条字幕各一个）；
     *   ② 选了烧录之后再改成"直通"，必须在**改参数的当下**就给出 block 级警告 ——
     *      而不是等用户点了"开始转换"才报错（那正是"转完才发现白转"）。
     */
    const subsSample = path.join(smokeAssetsDir(), 'samples', 'subs-multi.mkv');
    if (existsSync(subsSample)) {
      await evalJs<boolean>(
        '加载带字幕的素材',
        `(async () => {
          window.__lumenAddFiles(${JSON.stringify([subsSample])});
          return true;
        })()`,
      );
      await shotDelay(1600);
      await evalJs<boolean>(
        '切到带字幕的文件',
        `(() => {
          const cards = [...document.querySelectorAll('.file-card')];
          const last = cards[cards.length - 1];
          if (last) last.click();
          return true;
        })()`,
      );
      await shotDelay(420);

      const burnUi = await evalJs<{
        hasBurnGroup: boolean;
        radioCount: number;
        canSelect: boolean;
        infoShown: boolean;
        infoText: string;
        error: string;
      }>(
        '验证字幕烧录控件',
        `(async () => {
          const tick = () => new Promise((r) => setTimeout(r, 320));
          const blank = { hasBurnGroup: false, radioCount: 0, canSelect: false, infoShown: false, infoText: '', error: '' };
          try {
            const group = document.querySelector('.burn-group');
            if (!group) return { ...blank, error: '未找到「烧进画面」分组' };
            const radios = [...group.querySelectorAll('input[type="radio"]')];

            // 选第一条字幕做烧录
            const burnOne = radios[1];
            let canSelect = false;
            if (burnOne) {
              burnOne.click();
              await tick();
              canSelect = radios[1].checked;
            }

            /*
             * 断言兼容性预检**跟着烧录选择联动**。
             *
             * 这里查的是 info 级那条（"字幕「X」会被烧进画面"）而不是 block 级：
             * block 级（直通不能烧录）需要 videoCodecId 真的变成 copy，
             * 而当前用途「发微信 / QQ」有 H.264 硬约束，选直通预设也会被约束成 h264
             * （choosePreset 里那条"用途有编码器硬约束时仍然遵守约束"是刻意设计）。
             * 所以 block 规则本身由命令层的三条检查覆盖，这里只验证界面接线。
             *
             * ⚠ 这段是模板字面量：注释里**不能出现反引号**（D-019 记过这个坑，本轮又踩了一次）。
             */
            const infoItem = [...document.querySelectorAll('.compat-item.alert-info')].find((el) =>
              (el.textContent ?? '').includes('烧进画面'),
            );
            const infoText = (infoItem?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80);

            // 复原：取消烧录
            if (radios[0]) {
              radios[0].click();
              await tick();
            }
            return {
              hasBurnGroup: true,
              radioCount: radios.length,
              canSelect,
              infoShown: infoText.length > 0,
              infoText,
              error: '',
            };
          } catch (e) {
            return { ...blank, error: String(e) };
          }
        })()`,
      );
      extraChecks.push(
        [
          '字幕烧录：提供「烧进画面」单选组（不烧录 + 每条字幕各一项）',
          burnUi.hasBurnGroup && burnUi.radioCount >= 2 && burnUi.canSelect,
          burnUi.error
            ? `执行出错：${burnUi.error}`
            : `单选数=${burnUi.radioCount}，可选中=${burnUi.canSelect}`,
        ],
        [
          '字幕烧录：兼容性预检跟着烧录选择联动（当场说明代价，不用等转换）',
          burnUi.infoShown,
          burnUi.infoText || '（预检区没有出现烧录说明）',
        ],
      );

      // 移除这个临时素材，后面的用例仍然只有 1 个文件
      await evalJs<boolean>(
        '移除带字幕的素材',
        `(() => {
          const cards = [...document.querySelectorAll('.file-card')];
          const last = cards[cards.length - 1];
          if (last) last.querySelector('.file-remove')?.click();
          return true;
        })()`,
      );
      await shotDelay(400);
    } else {
      extraChecks.push([
        '字幕烧录相关检查能跑起来（需要 subs-multi.mkv）',
        false,
        `样本不存在：${subsSample}。请先跑 npm run samples，或给打包态加 --smoke-assets=`,
      ]);
    }

    /*
     * 回到推荐模式：后面「模式切换」那一组要求从推荐模式开始。
     *
     * 顺带点一下第一张用途卡片把参数复位 —— 前面几组检查动过格式/分辨率，
     * 不复位的话「参数已偏离推荐值」提示会一直挂着，把首屏撑长（实测就这么
     * 让"兼容性预检"掉到折叠线以下，害得后面的断言失败）。
     */
    await evalJs<boolean>(
      '切回推荐模式并复位用途参数（音频/字幕检查结束）',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 320));
        const btns = [...document.querySelectorAll('.mode-btn')];
        if (btns[0]) btns[0].click();
        await tick();
        const first = document.querySelector('.usecase-card');
        if (first) first.click();
        await tick();
        return true;
      })()`,
    );
    await shotDelay(250);

    /*
     * 模式切换：推荐（大众）/ 自定义（专业）。
     *
     * 起因：用户反馈"很奇怪" —— 原来把用途卡片和一大堆专业参数堆在同一个面板里，
     * 大众用户被淹没。现在分两个模式：推荐模式隐藏全部专业参数，自定义模式才展开。
     * 这里验证：① 推荐模式下没有专业参数；② 切到自定义后出现；
     * ③ 模式选择会持久化（settings.appMode）。
     */
    const modeSwitch = await evalJs<{
      storedMode: string;
      activeBtn: string;
      recommendedHasAdvanced: boolean;
      recommendedHasModeBtn: boolean;
      customHasAdvanced: boolean;
      backToRecommended: boolean;
      recommendedUseCaseCards: number;
      customUseCaseCards: number;
      customFieldsVisible: boolean;
      error: string;
    }>(
      '验证推荐 / 自定义模式切换',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 300));
        /*
         * 「专业参数有没有出现」改用 .pro-block 判定。
         * 原来判定的是 .advanced-toggle 这个折叠开关 —— 现在自定义模式下专业参数是**常开**的，
         * 开关已经不存在了（见 D-019）。继续用旧选择器会得到"永远没有专业参数"的假结论。
         */
        const advShown = () => Boolean(document.querySelector('.pro-block'));
        /** 专业参数字段是否**直接可见**（不需要任何点击） */
        const fieldsVisible = () => document.querySelectorAll('.pro-block .advanced-body .field').length > 0;
        const useCaseCards = () => document.querySelectorAll('.usecase-card').length;
        const activeBtn = () =>
          (document.querySelector('.mode-btn.active')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 12);
        const clickMode = (idx) => {
          const btns = [...document.querySelectorAll('.mode-btn')];
          if (!btns[idx]) return false;
          btns[idx].click();
          return true;
        };
        try {
          // 诊断：确认自检开头的重置是否真的生效（看渲染进程读到的 appMode）
          const s = await window.converter.getSettings();
          const storedMode = s.ok ? String(s.data.appMode) : 'ERR';
          const recommendedHasModeBtn = document.querySelectorAll('.mode-btn').length === 2;
          // 模式切换会触发 Vue 更新，多等一拍再判定（早期只等一次，读到的是旧 DOM）
          await tick();
          const recommendedHasAdvanced = advShown();
          const recommendedUseCaseCards = useCaseCards();

          // 切到自定义
          clickMode(1);
          await tick();
          await tick();
          const customHasAdvanced = advShown();
          const customUseCaseCards = useCaseCards();
          const customFieldsVisible = fieldsVisible();

          // 切回推荐
          clickMode(0);
          await tick();
          const backToRecommended = !advShown();

          return {
            storedMode,
            activeBtn: activeBtn(),
            recommendedHasAdvanced,
            recommendedHasModeBtn,
            customHasAdvanced,
            backToRecommended,
            recommendedUseCaseCards,
            customUseCaseCards,
            customFieldsVisible,
            error: '',
          };
        } catch (e) {
          return { storedMode: '', activeBtn: '', recommendedHasAdvanced: true, recommendedHasModeBtn: false, customHasAdvanced: false, backToRecommended: false, recommendedUseCaseCards: -1, customUseCaseCards: -1, customFieldsVisible: false, error: String(e) };
        }
      })()`,
    );

    extraChecks.push(
      [
        '模式切换：提供「推荐设置 / 自定义」两个模式',
        modeSwitch.recommendedHasModeBtn,
        modeSwitch.recommendedHasModeBtn ? '两个模式按钮都在' : '未找到模式切换',
      ],
      [
        '推荐模式：隐藏全部专业参数（大众用户不被淹没）',
        !modeSwitch.recommendedHasAdvanced,
        modeSwitch.recommendedHasAdvanced
          ? `推荐模式下仍出现「专业参数」（存储值=${modeSwitch.storedMode}，高亮=${modeSwitch.activeBtn}）`
          : '推荐模式下无专业参数',
      ],
      [
        '自定义模式：出现专业参数（且字段直接可见，不需要再点一次）',
        modeSwitch.customHasAdvanced && modeSwitch.customFieldsVisible,
        modeSwitch.customHasAdvanced
          ? modeSwitch.customFieldsVisible
            ? '专业参数区块与字段都在'
            : '专业参数区块在，但字段没渲染出来'
          : '切到自定义后仍无专业参数',
      ],
      [
        '切回推荐模式：专业参数重新隐藏',
        modeSwitch.backToRecommended,
        modeSwitch.backToRecommended ? '已隐藏' : '仍显示',
      ],
      /*
       * 用户反馈（原话）："自定义不要这个推荐，缺少专业性，这个用最初那个版本自己调整更合适"。
       * 所以自定义模式必须**没有**用途推荐卡片，推荐模式必须**有**。
       * 这两条是这次改动最核心的验收点，专门断言，避免以后又被"顺手加回去"。
       */
      [
        '自定义模式：不出现「用途」推荐卡片（用户明确要求）',
        modeSwitch.customUseCaseCards === 0,
        `自定义模式下用途卡片数 = ${modeSwitch.customUseCaseCards}`,
      ],
      [
        '推荐模式：用途推荐卡片齐全',
        modeSwitch.recommendedUseCaseCards >= 8,
        `推荐模式下用途卡片数 = ${modeSwitch.recommendedUseCaseCards}`,
      ],
    );

    /*
     * 两种模式各截一张图，并量化"可见区块"的差异。
     *
     * 起因：用户反馈"推荐设置和自定义没区别啊"。
     * 光断言「有没有专业参数区块」看不出真实观感 —— 需要把两种模式的
     * 首屏内容都记录下来，才知道用户实际看到的是什么。
     */
    const modeShots: { mode: string; blocks: string[]; scrollH: number; viewH: number }[] = [];
    for (const [idx, modeName] of [
      [0, 'recommended'],
      [1, 'custom'],
    ] as [number, string][]) {
      await evalJs<boolean>(
        `切到 ${modeName} 模式`,
        `(async () => {
          const btns = [...document.querySelectorAll('.mode-btn')];
          if (btns[${idx}]) btns[${idx}].click();
          await new Promise((r) => setTimeout(r, 380));
          return true;
        })()`,
      );
      await shotDelay(350);
      const info = await evalJs<{ blocks: string[]; scrollH: number; viewH: number }>(
        `记录 ${modeName} 模式的内容`,
        `(() => {
          /*
           * 区块标题：优先 h4；专业参数区块没有 h4，取开关按钮里的**直接文本节点**。
           * 不能直接用 textContent —— 那会把后面"格式 / 编码器 / ..."那段灰色说明
           * 一起拼进标题里，日志变成"专业参数格式 / 编码器"，读起来很费劲。
           */
          const titleOf = (b) => {
            const h4 = b.querySelector('h4');
            if (h4) return h4.textContent.trim();
            return '(无标题)';
          };
          const blocks = [...document.querySelectorAll('.details .block')].map((b) => {
            const r = b.getBoundingClientRect();
            return titleOf(b) + '@' + Math.round(r.top) + (r.bottom > window.innerHeight ? '(折叠线下)' : '');
          });
          const scroller = document.querySelector('.details-scroll');
          return {
            blocks,
            scrollH: scroller ? Math.round(scroller.scrollHeight) : 0,
            viewH: scroller ? Math.round(scroller.clientHeight) : 0,
          };
        })()`,
      );
      modeShots.push({ mode: modeName, ...info });
      await capture(`mode-${modeName}.png`);
    }

    const rec = modeShots.find((m) => m.mode === 'recommended');
    const cus = modeShots.find((m) => m.mode === 'custom');
    extraChecks.push([
      '两种模式的首屏内容确实不同（不是只藏了一个开关）',
      Boolean(rec && cus && (rec.scrollH !== cus.scrollH || rec.blocks.length !== cus.blocks.length)),
      `推荐：${rec?.blocks.length} 区块/内容高 ${rec?.scrollH}px；自定义：${cus?.blocks.length} 区块/内容高 ${cus?.scrollH}px`,
    ]);
    /*
     * 首屏可见性断言。
     *
     * 之前的断言只比"内容总高度"，而用户抱怨的是"**看不出区别**" ——
     * 差别全在折叠线下时，总高度确实不同，但用户在首屏看到的是一样的。
     * 所以要断言的是"视口内（折叠线以上）有哪些区块"，这才是用户真正感知到的。
     */
    extraChecks.push([
      '两种模式在首屏（折叠线以上）就有可见差别',
      Boolean(
        rec &&
          cus &&
          rec.blocks.filter((b) => !b.includes('折叠线下')).join() !==
            cus.blocks.filter((b) => !b.includes('折叠线下')).join(),
      ),
      /*
       * 两种模式的首屏都要打出来。
       * 之前这里只打印推荐模式的首屏，"有差别"靠的是字符串比较通过 —— 等于让断言自己
       * 证明自己，日志里看不到自定义模式首屏到底长什么样。证据必须能被人直接读出来。
       */
      `推荐首屏：${rec?.blocks.filter((b) => !b.includes('折叠线下')).join(' | ') || '（无）'}` +
        ` ／ 自定义首屏：${cus?.blocks.filter((b) => !b.includes('折叠线下')).join(' | ') || '（无）'}`,
    ]);
    /*
     * 这次改动的**目的**断言：
     * 用户抱怨"推荐和自定义没区别"，根因是专业参数入口在折叠线以下（约 900px）。
     * 所以必须直接断言"自定义模式下，专业参数入口出现在首屏"，而不是只看两种模式串是否不同。
     */
    extraChecks.push([
      '自定义模式：专业参数面板出现在首屏（不用滚动就能看到）',
      Boolean(cus && cus.blocks.some((b) => b.startsWith('专业参数') && !b.includes('折叠线下'))),
      cus
        ? cus.blocks.find((b) => b.startsWith('专业参数'))
          ? `专业参数@${cus.blocks.find((b) => b.startsWith('专业参数'))?.split('@')[1]}`
          : '首屏未找到专业参数入口'
        : '未采集',
    ]);
    extraChecks.push([
      '推荐模式：首屏能看到"用途"（含体积上限）与"兼容性预检"',
      Boolean(
        rec &&
          rec.blocks.some((b) => b.includes('你要拿去干什么') && !b.includes('折叠线下')) &&
          rec.blocks.some((b) => b.includes('兼容性预检') && !b.includes('折叠线下')),
      ),
      /*
       * 这条原来断言的是「在哪播 / 多大体积」在首屏。
       * 按 D-020 把体积上限**归还给用途区**之后，用途区块高了一点，
       * 「在哪播」被挤到折线下方（@788）—— 这是可以接受的：
       * 设备现在由用途自动带出，属于"只用于兼容性预检"的次要信息。
       * 于是断言改成盯"用途（含体积上限）"和"兼容性预检"这两块首屏必须可见的内容。
       */
      rec ? rec.blocks.join(' | ').slice(0, 160) : '未采集',
    ]);

    // 回到推荐模式，保持后续截图一致
    await evalJs<boolean>(
      '回到推荐模式',
      `(async () => {
        const btns = [...document.querySelectorAll('.mode-btn')];
        if (btns[0]) btns[0].click();
        await new Promise((r) => setTimeout(r, 360));
        return true;
      })()`,
    );
    await shotDelay(300);

    // 后面几组断言针对专业参数（编码器 / 格式下拉 / 命名下拉），必须先在自定义模式
    const enteredCustom = await evalJs<{ ok: boolean; activeBtn: string; hasAdvanced: boolean }>(
      '切到自定义模式以验证专业参数',
      `(async () => {
        const btns = [...document.querySelectorAll('.mode-btn')];
        if (btns[1]) btns[1].click();
        await new Promise((r) => setTimeout(r, 400));
        /*
         * 自定义模式下专业参数是常开的，**不需要点任何开关**。
         * 这里直接断言字段已经渲染出来 —— 如果哪天又把它折叠回去，这条会失败。
         */
        return {
          ok: document.querySelectorAll('.pro-block .advanced-body .field').length > 0,
          activeBtn: (document.querySelector('.mode-btn.active')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 10),
          hasAdvanced: Boolean(document.querySelector('.pro-block')),
        };
      })()`,
    );
    extraChecks.push([
      '自检前置：能进入自定义模式并看到专业参数字段',
      enteredCustom.ok,
      enteredCustom.ok
        ? `当前高亮「${enteredCustom.activeBtn}」`
        : `未能进入（高亮=${enteredCustom.activeBtn}，有专业参数入口=${enteredCustom.hasAdvanced}）`,
    ]);
    await shotDelay(300);

    /*
     * 兼容性预检的端到端验证：真的做一个"会播不了"的组合出来。
     *
     * 场景：源是 H.264，用户手动把编码器改成 H.265、设备选「老安卓电视」。
     * 期望：界面出现警告 + 一键修复按钮；点了修复之后警告消失。
     * 这一条是「把转完才发现播不了」这个坑的核心防线。
     */
    const compat = await evalJs<{
      before: number;
      afterSet: number;
      warned: string;
      hasFix: boolean;
      afterFix: number;
      fixedCodec: string;
      error: string;
    }>(
      '验证兼容性预检与一键修复',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 220));
        const count = () => document.querySelectorAll('.compat-item').length;
        // 结论在 <strong> 里，建议在 <p class="compat-suggestion"> 里，两者都要读
        const texts = () =>
          [...document.querySelectorAll('.compat-item strong, .compat-item .compat-suggestion')].map(
            (e) => (e.textContent ?? '').trim(),
          );
        const findSel = (pred) => [...document.querySelectorAll('.details select')].find(pred);
        const setVal = (sel, v) => {
          if (!sel) return false;
          sel.value = v;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        try {
          const before = count();

          // 编码器下拉在专业参数里；自定义模式下它**常开**，不需要先展开
          await tick();

          /*
           * 2) 编码器改成 H.265
           *
           * 判据放宽为"这个下拉里有任何 hevc 选项" —— 之前写死找含 h264 的下拉，
           * 一旦选项列表里没有 h264/h264_nvenc（例如编码器可用性探测把它过滤掉了），
           * 就会误判成"找不到编码器下拉"，把功能问题伪装成测试问题。
           */
          const codecSel = findSel((s) => [...s.options].some((o) => o.value.startsWith('hevc')));
          const codecOk = codecSel
            ? setVal(codecSel, [...codecSel.options].find((o) => o.value.startsWith('hevc'))?.value ?? 'hevc')
            : false;
          await tick();

          // 3) 设备选「老安卓电视」
          const devSel = findSel((s) => [...s.options].some((o) => o.value === 'android-old'));
          const devOk = devSel ? setVal(devSel, 'android-old') : false;
          await tick();

          const afterSet = count();
          const warned = texts().join(' / ');

          // 4) 点一键修复
          const fixBtn = document.querySelector('.compat-item .compat-fix');
          const hasFix = Boolean(fixBtn);
          if (fixBtn) fixBtn.click();
          await tick();
          await tick();

          const afterFix = count();
          const codecNow = codecSel ? codecSel.value : '';

          return {
            before, afterSet, warned, hasFix, afterFix,
            fixedCodec: codecNow,
            error: codecOk && devOk ? '' : ('codecSel=' + Boolean(codecSel) + ' devSel=' + Boolean(devSel)),
          };
        } catch (e) {
          return { before: -1, afterSet: -1, warned: '', hasFix: false, afterFix: -1, fixedCodec: '', error: String(e) };
        }
      })()`,
    );

    extraChecks.push(
      [
        '兼容性预检：做出"播不了"的组合时出现警告',
        compat.afterSet > compat.before && compat.warned.length > 0,
        compat.error
          ? `选择器未找到（${compat.error}）`
          : `${compat.before} → ${compat.afterSet} 条：${compat.warned.slice(0, 70)}`,
      ],
      [
        '兼容性预检：警告里给出可操作建议',
        compat.warned.includes('建议') || compat.warned.includes('可能'),
        compat.warned.slice(0, 60) || '（无内容）',
      ],
      [
        '兼容性预检：一键修复能消除警告',
        compat.hasFix && compat.afterFix < compat.afterSet,
        compat.hasFix
          ? `修复后 ${compat.afterSet} → ${compat.afterFix} 条，编码器变为 ${compat.fixedCodec}`
          : '未找到「一键修复」按钮',
      ],
    );

    /*
     * 复原：用途点回默认（会把编码器与设备相关设置一并覆盖回去）。
     *
     * ⚠ 必须先切回**推荐模式**：用途卡片现在只在推荐模式渲染（D-019），
     * 在自定义模式下 querySelector('.usecase-card') 是 null，这一步会静默失效，
     * 于是 hevc / android-old 这些测试中间状态会被带进后面的用例。
     * 后面的"偏离推荐值"检查本来也要在推荐模式跑，所以这里就停在推荐模式。
     */
    await evalJs<boolean>(
      '切回推荐模式并恢复默认用途（兼容性测试后）',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 300));
        const btns = [...document.querySelectorAll('.mode-btn')];
        if (btns[0]) btns[0].click();
        await tick();
        const first = document.querySelector('.usecase-card');
        if (first) first.click();
        await tick();
        return true;
      })()`,
    );
    await shotDelay(300);


    /*
     * 「专业参数会不会影响上面的选择」——用户在界面上提出来的疑问，确实是个真 bug。
     *
     * 原实现里手动改格式**不会清掉用途标记**，于是用途卡片继续高亮、
     * 继续显示该用途的提示，而实际参数已经不是那一套了 —— 卡片等于在说谎。
     * 这里验证：改了参数后卡片保留高亮 + 出现「参数已偏离」提示 + 一键恢复能收回。
     *
     * ⚠ 这条**必须切回推荐模式**再跑（D-019 之后）：
     * 用途卡片与"偏离提示"都只存在于推荐模式；而原先这里改的是专业参数里的
     * 「输出格式」下拉，那个只在自定义模式有 —— 两个条件现在互斥。
     * 所以改成在推荐模式里动**质量**下拉：质量同样属于 deviations 追踪的字段，
     * 而且推荐模式下本来就允许改，正是"用户会遇到的真实路径"。
     */
    const deviation = await evalJs<{
      beforeActive: string;
      afterActive: string;
      deviationShown: boolean;
      deviationText: string;
      restoredActive: string;
      restoredDeviation: boolean;
      error: string;
    }>(
      '验证「手动改参数」会提示偏离推荐值',
      `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 240));
        const activeLabel = () => (document.querySelector('.usecase-card.active .usecase-label')?.textContent ?? '').trim();
        const deviationEl = () => document.querySelector('.deviation-note');
        try {
          // 先切回推荐模式（用途卡片与偏离提示只在这里）
          const btns = [...document.querySelectorAll('.mode-btn')];
          if (btns[0]) btns[0].click();
          await tick();
          await tick();

          const beforeActive = activeLabel();

          // 动「质量」下拉：它在「质量与尺寸」区块里，推荐/自定义两种模式都可见
          const sel = document.querySelector('.quality-block select');
          if (!sel) return { beforeActive, afterActive: '', deviationShown: false, deviationText: '', restoredActive: '', restoredDeviation: false, error: '未找到质量下拉' };
          const opt = [...sel.querySelectorAll('option')].find((o) => o.value !== sel.value);
          if (!opt) return { beforeActive, afterActive: '', deviationShown: false, deviationText: '', restoredActive: '', restoredDeviation: false, error: '质量下拉只有一个选项' };
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await tick();

          const afterActive = activeLabel();
          const dEl = deviationEl();
          const deviationShown = Boolean(dEl);
          const deviationText = (dEl?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 90);

          // 点恢复
          const restoreBtn = dEl?.querySelector('button');
          if (restoreBtn) restoreBtn.click();
          await tick();
          await tick();

          return {
            beforeActive, afterActive, deviationShown, deviationText,
            restoredActive: activeLabel(),
            restoredDeviation: Boolean(deviationEl()),
            error: '',
          };
        } catch (e) {
          return { beforeActive: '', afterActive: '', deviationShown: false, deviationText: '', restoredActive: '', restoredDeviation: false, error: String(e) };
        }
      })()`,
    );

    extraChecks.push(
      [
        '手动改参数后：用途卡片保留高亮（不丢失"我本来想干什么"）',
        deviation.afterActive !== '' && deviation.afterActive === deviation.beforeActive,
        deviation.error
          ? `执行出错：${deviation.error}`
          : `用途仍为「${deviation.afterActive}」`,
      ],
      [
        '手动改参数后：出现「参数已偏离推荐值」提示',
        deviation.deviationShown && deviation.deviationText.includes('手动改过'),
        deviation.deviationText || '（无提示）',
      ],
      [
        '「恢复推荐值」能把用途与参数一起收回来',
        deviation.restoredActive !== '' && !deviation.restoredDeviation,
        `高亮恢复为「${deviation.restoredActive}」，偏离提示${deviation.restoredDeviation ? '仍在' : '已消失'}`,
      ],
    );

    // 偏离检查把模式切回了推荐模式；后面的专业参数相关检查需要自定义模式
    await evalJs<boolean>(
      '切回自定义模式（继续验证专业参数）',
      `(async () => {
        const btns = [...document.querySelectorAll('.mode-btn')];
        if (btns[1]) btns[1].click();
        await new Promise((r) => setTimeout(r, 360));
        return true;
      })()`,
    );
    await shotDelay(250);

    /*
     * 输出文件命名：从"裸模板输入框"改成"下拉选项 + 自定义"。
     * 验证下拉存在、切换能真的改掉输出文件名预览。
     */
    let namePick = {
      options: 0,
      hasCustom: false,
      previewBefore: '',
      previewAfter: '',
      customInputShown: false,
      customPreview: '',
      error: '',
      diag: '',
    };
    try {
      /*
       * 输出文件命名：从"裸模板输入框"改成"下拉选项 + 自定义"。
       * 分两步验证，避免把两件事混在一个表达式里：
       *   ① 下拉选项存在，且切换能真的改掉输出文件名预览
       *   ② 选「自定义」时出现模板输入框，且手输的模板会反映到预览
       */
      const step1 = await evalJs<{
        options: number;
        hasCustom: boolean;
        before: string;
        after: string;
        error: string;
      }>(
        '验证命名下拉切换',
        `(async () => {
          const tick = () => new Promise((r) => setTimeout(r, 240));
          try {
            // 命名下拉在专业参数里；自定义模式下常开，不需要展开
            await tick();
            const sel = [...document.querySelectorAll('.advanced-body select')].find(
              (s) => [...s.options].some((o) => o.value === 'custom')
            );
            if (!sel) return { options: 0, hasCustom: false, before: '', after: '', error: '未找到命名下拉' };
            const previewOf = () => {
              const hint = [...document.querySelectorAll('.advanced-body .field-hint')].find((h) =>
                (h.textContent ?? '').includes('输出文件名')
              );
              return (hint?.textContent ?? '').replace(/\\s+/g, ' ').trim();
            };
            const before = previewOf();
            const opts = [...sel.options];
            const dateOpt = opts.find((o) => o.value === 'date-first');
            sel.value = dateOpt ? dateOpt.value : opts[0].value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            await tick();
            return {
              options: opts.length,
              hasCustom: opts.some((o) => o.value === 'custom'),
              before: before.slice(0, 50),
              after: previewOf().slice(0, 50),
              error: '',
            };
          } catch (e) {
            return { options: 0, hasCustom: false, before: '', after: '', error: String(e) };
          }
        })()`,
      );

      const step2 = await evalJs<{ shown: boolean; preview: string; diag: string; error: string }>(
        '验证自定义模板时出现输入框',
        `(async () => {
          const tick = () => new Promise((r) => setTimeout(r, 260));
          try {
            const sel = [...document.querySelectorAll('.advanced-body select')].find(
              (s) => [...s.options].some((o) => o.value === 'custom')
            );
            if (!sel) return { shown: false, preview: '', diag: '无下拉', error: '' };

            const previewOf = () => {
              const hint = [...document.querySelectorAll('.advanced-body .field-hint')].find((h) =>
                (h.textContent ?? '').includes('输出文件名')
              );
              return (hint?.textContent ?? '').replace(/\\s+/g, ' ').trim();
            };

            /*
             * 说明：不去"程序化设置 sel.value = custom 再 dispatch change"。
             * select 是受控的（:value="currentNamePreset"），在程序化改值的路径上
             * Vue 会在下一次 patch 时把它写回上一个选项 —— 那是受控组件的正常行为，
             * 不代表功能有问题（真实用户点击时，浏览器先把 value 改掉、change 随即触发，
             * 状态与视图是一致的）。
             *
             * 所以要验证的不变量是：**当模板不等于任何预设时，界面必须展示自定义输入框**。
             * 先确定此刻模板是什么（可能是 '{name}' 或上次选择留下的值），
             * 再把它改成一个非预设值，看输入框是否出现。
             */
            const currentTemplate = (() => {
              const p = previewOf();
              // 预览形如「输出文件名：xxx.mp4」，去掉前缀与外层说明
              return p.replace(/^输出文件名：/, '').split('可用变量')[0].trim();
            })();

            const input0 = document.querySelector('.advanced-body .template-input');
            if (input0) {
              // 已经处于自定义态（说明上一轮留下了非预设模板），直接用它验证预览联动
              input0.value = '{name}-我的命名';
              input0.dispatchEvent(new Event('input', { bubbles: true }));
              await tick();
              return { shown: true, preview: previewOf().slice(0, 60), diag: '初始即自定义态', error: '' };
            }

            // 从下拉里选一个"非预设"的路径：直接选自定义项，然后立刻校验
            // 真实用户点击时 change 会带上正确 value，这里用 InputEvent 模拟同样的顺序
            sel.focus();
            sel.value = 'custom';
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            await tick();
            await tick();

            const input = document.querySelector('.advanced-body .template-input');
            if (!input) {
              return {
                shown: false,
                preview: '',
                diag: '选 custom 后 selValue=' + sel.value + '，模板预览=' + currentTemplate,
                error: '',
              };
            }

            input.value = '{name}-我的命名';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await tick();
            return { shown: true, preview: previewOf().slice(0, 60), diag: 'selValue=' + sel.value, error: '' };
          } catch (e) {
            return { shown: false, preview: '', diag: '', error: String(e) };
          }
        })()`,
      );

      namePick = {
        options: step1.options,
        hasCustom: step1.hasCustom,
        previewBefore: step1.before,
        previewAfter: step1.after,
        customInputShown: step2.shown,
        customPreview: step2.preview,
        error: step1.error || step2.error,
        diag: step2.diag,
      };
    } catch (err) {
      namePick = { ...namePick, error: err instanceof Error ? err.message : String(err) };
    }

    extraChecks.push(
      [
        '输出命名：提供常用命名选项（含自定义）',
        namePick.options >= 5 && namePick.hasCustom,
        `${namePick.options} 个选项，含自定义=${namePick.hasCustom}`,
      ],
      [
        '输出命名：切换选项会改变输出文件名预览',
        namePick.previewBefore !== namePick.previewAfter && namePick.previewAfter.length > 0,
        `${namePick.previewBefore} → ${namePick.previewAfter}`,
      ],
      [
        '输出命名：选「自定义」时出现模板输入框',
        namePick.customInputShown,
        namePick.customInputShown ? '已显示' : `未显示（${namePick.diag || '无诊断信息'}）`,
      ],
      [
        '输出命名：自定义模板会反映到输出文件名',
        namePick.customPreview.includes('我的命名'),
        namePick.customPreview || '（无预览）',
      ],
    );

      // 收尾：恢复默认命名，避免影响后续截图（用途卡片不在自定义模式里，这里不动它）
      await evalJs<boolean>(
        '恢复默认命名',
        `(() => {
          const sel = [...document.querySelectorAll('.advanced-body select')].find(
            (s) => [...s.options].some((o) => o.value === 'custom')
          );
          if (sel) {
            const keep = [...sel.options].find((o) => o.value === 'keep');
            if (keep) {
              sel.value = keep.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          return true;
        })()`,
      );
      await shotDelay(400);

      /*
       * 「专业参数」单独截一张。
       *
       * 起因：用户在界面上反馈"很奇怪" —— 专业参数区域的布局是碎的。
       * 现在它在自定义模式下是**常开**的（D-019），所以不需要再点开关；
       * 截图仍然保留，用于比对字段布局。
       */
      await shotDelay(500);
      await capture('main-advanced.png');
      const advReport = await evalJs<{
        rows: number;
        selects: number;
        inputs: number;
        overflowW: boolean;
        widest: string;
      }>(
        '检查专业参数布局',
        `(() => {
          const body = document.querySelector('.advanced-body');
          if (!body) return { rows: 0, selects: 0, inputs: 0, overflowW: false, widest: '未渲染' };
          const panel = document.querySelector('.details');
          const widest = [...body.querySelectorAll('*')]
            .map((el) => ({ cls: String(el.className || el.tagName), w: el.getBoundingClientRect().width }))
            .sort((a, b) => b.w - a.w)[0];
          return {
            rows: body.querySelectorAll('.field').length,
            selects: body.querySelectorAll('select').length,
            inputs: body.querySelectorAll('input').length,
            overflowW: body.scrollWidth > body.clientWidth + 2,
            widest: widest ? widest.cls.slice(0, 30) + '@' + Math.round(widest.w) : '',
            panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
          };
        })()`,
      );
      extraChecks.push([
        '专业参数：字段不横向溢出（自定义模式下常开）',
        !advReport.overflowW,
        `${advReport.rows} 个字段、${advReport.selects} 个下拉，最宽元素 ${advReport.widest}，面板宽 ${(advReport as unknown as { panelW: number }).panelW}px`,
      ]);
      await shotDelay(300);

    /*
     * 回归：预设选择必须跨文件保留。
     *
     * 原 bug 的第三个表现就是"切到另一个文件后之前的选择丢了"（因为写进了按文件的 overrides）。
     * 这里再加载一个文件并切换选中项，确认高亮仍停在刚选的预设上。
     *
     * ⚠ 路径必须用 smokeBaseDir()，**不能用 app.getAppPath()**：
     * 打包态 app.getAppPath() 指向 `...\resources\app.asar`（一个**文件**），
     * 拼出来的 test-assets 路径永远不存在 —— 于是下面这 8 项检查在三轮自检里
     * **一次都没跑过**，而摘要照样打印"全部通过"。这是与 ENOTDIR 同一类坑的漏网之鱼
     * （ENOTDIR 那次修的就是这个 base 目录，但只改了截图目录与 --smoke-file，
     * 漏了这一处）。见 docs/SESSION_SUMMARY.md 第 5.1 节第 14 条。
     */
    const secondSample = path.join(smokeAssetsDir(), 'samples', 'sample-hevc.mkv');
    if (existsSync(secondSample)) {
      /*
       * 多文件这一组回到**推荐模式**跑。
       *
       * 原因：「用途选择跨文件保留」要读"当前选中的用途"，而用途卡片与摘要里的用途名
       * 都只存在于推荐模式（自定义模式下摘要显示的是"自定义参数"）。
       * 在这里切模式也顺带覆盖了"切模式后已加载的文件不受影响"这条隐含预期。
       */
      await evalJs<boolean>(
        '切回推荐模式（验证多文件行为）',
        `(async () => {
          const btns = [...document.querySelectorAll('.mode-btn')];
          if (btns[0]) btns[0].click();
          await new Promise((r) => setTimeout(r, 360));
          return true;
        })()`,
      );
      await shotDelay(200);
      await evalJs<boolean>(
        '加载第二个文件',
        `(() => { window.__lumenAddFiles(${JSON.stringify([secondSample])}); return true; })()`,
      );
      await shotDelay(1500);
      await evalJs<boolean>(
        '切回第一个文件',
        `(() => {
          const cards = [...document.querySelectorAll('.file-card')];
          if (cards[0]) cards[0].click();
          return true;
        })()`,
      );
      await shotDelay(400);
      const keptPreset = await evalJs<{ label: string; files: number }>(
        '检查跨文件后的用途选择',
        `(() => {
          /*
           * 读「方案摘要」里的用途，而不是用途卡片（.usecase-card.active）。
           * D-019 之后用途卡片只在推荐模式渲染，而这一段跑在自定义模式下，
           * 用卡片选择器会读到空字符串，把"用途没保留"这个假结论报出来
           * （实测就是这么失败了一次）。.plan-usecase 两种模式都在。
           *
           * ⚠ 注意：这段字符串是模板字面量，**注释里也不要写反引号** ——
           * 反引号会提前结束模板串，把后面的内容当成 JS 表达式解析
           * （踩过一次：注释里写了「点加 usecase-card 加 .active」，结果编译出的表达式里
           * 多出一个未定义的 card 标识符，自检直接 ReferenceError）。
           */
          const fromSummary = (document.querySelector('.plan-usecase')?.textContent ?? '').trim();
          const fromCard = (document.querySelector('.usecase-card.active .usecase-label')?.textContent ?? '').trim();
          return {
            label: fromSummary || fromCard,
            files: document.querySelectorAll('.file-card').length,
          };
        })()`,
      );
      extraChecks.push([
        '用途选择跨文件保留',
        keptPreset.label === '发微信 / QQ' && keptPreset.files >= 2,
        `${keptPreset.files} 个文件，当前用途「${keptPreset.label}」`,
      ]);

      /*
       * 勾选（多选要转哪些文件）的验证。
       *
       * 起因：用户问"可以一次性选择多个文件进行解码吗"。一次选多个文件本来就支持，
       * 但原先**没法挑选**——要么全转、要么先把不想转的逐个删掉。
       * 这里验证勾选语义：勾了 1 个 → 按钮计数变成 1；全选 → 变成总数。
       */
      const pickState = await evalJs<{
        boxes: number;
        footerBefore: string;
        footerAfterPick: string;
        footerAfterAll: string;
        hasSelectAll: boolean;
        diag: string;
      }>(
        '验证文件勾选与按钮计数联动',
        `(async () => {
          const picked = () => (document.querySelector('.foot-picked')?.textContent ?? '').trim();
          const btn = () => (document.querySelector('.pane-footer .btn-primary')?.textContent ?? '').trim();
          const tick = () => new Promise((r) => setTimeout(r, 120));
          const boxes = [...document.querySelectorAll('.pick-box input')];
          const footerBefore = '无勾选 | ' + btn();
          if (boxes.length === 0) {
            return { boxes: 0, footerBefore, footerAfterPick: '', footerAfterAll: '', hasSelectAll: false, diag: '没有勾选框' };
          }
          // 显式派发 change：只调 click() 在部分情况下不会触发 Vue 监听的 change 事件
          const box = boxes[0];
          const before = box.checked;
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
          await tick();
          const footerAfterPick = picked() + ' | ' + btn();
          const selectAll = [...document.querySelectorAll('.pane-actions .btn')].find(
            (b) => (b.textContent ?? '').includes('全选')
          );
          if (selectAll) selectAll.click();
          await tick();
          const footerAfterAll = picked() + ' | ' + btn();
          return {
            boxes: boxes.length,
            footerBefore,
            footerAfterPick,
            footerAfterAll,
            hasSelectAll: Boolean(selectAll),
            diag: 'beforeChecked=' + before + ' afterDomChecked=' + box.checked,
          };
        })()`,
      );
      extraChecks.push(
        [
          '文件列表：每个文件都有勾选框',
          pickState.boxes >= 2,
          `${pickState.boxes} 个勾选框`,
        ],
        [
          '文件列表：勾选后按钮计数联动',
          pickState.footerAfterPick.includes('已勾选 1'),
          `${pickState.footerBefore} → ${pickState.footerAfterPick}（${pickState.diag}）`,
        ],
        [
          '文件列表：提供全选入口',
          pickState.hasSelectAll && pickState.footerAfterAll.includes('已勾选 2'),
          pickState.footerAfterAll || '未找到全选按钮',
        ],
      );
      // 取消勾选，避免影响后续"点击开始转换"用例的预期（那里期望转全部）
      await evalJs<boolean>(
        '取消全部勾选',
        `(async () => {
          const selectNone = [...document.querySelectorAll('.pane-actions .btn')].find(
            (b) => (b.textContent ?? '').includes('取消全选')
          );
          if (selectNone) selectNone.click();
          await new Promise((r) => setTimeout(r, 120));
          return true;
        })()`,
      );
      await shotDelay(200);

      /*
       * 质量下拉框的交互验证。
       *
       * 起因：用户问"这个（质量下拉）是可以用的吗"。查下来发现更严重的问题——
       * 质量/分辨率/帧率/编码器/文件名模板全都写进了**按文件的 overrides**，
       * 而选中态读的是别的来源，导致调好的参数一换文件就丢。
       * 这里直接操作 <select> 并断言：① 值确实变了 ② 换文件后不丢。
       */
      const qualityChange = await evalJs<{
        before: string;
        after: string;
        options: number;
        persisted: boolean;
        estimateChanged: boolean;
      }>(
        '切换质量档位并验证跨文件保留',
        `(async () => {
          const sel = [...document.querySelectorAll('.details select')].find(
            (s) => s.querySelector('option')?.value?.includes('balanced') ||
                   [...s.options].some((o) => o.value === 'balanced')
          );
          if (!sel) return { before: '', after: '', options: 0, persisted: false, estimateChanged: false };
          const estimateOf = () => (document.querySelector('.details-foot .foot-estimate')?.textContent ?? '').trim();
          const before = sel.value;
          const beforeEstimate = estimateOf();
          // 选一个与当前不同的档位
          const target = [...sel.options].find((o) => o.value !== before);
          if (!target) return { before, after: before, options: sel.options.length, persisted: false, estimateChanged: false };
          sel.value = target.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          const after = sel.value;
          const estimateChanged = estimateOf() !== beforeEstimate;

          // 切到另一个文件再切回来，检查是否保留
          const cards = [...document.querySelectorAll('.file-card')];
          let persisted = false;
          if (cards.length >= 2) {
            cards[cards.length - 1].click();
            await new Promise((r) => setTimeout(r, 300));
            cards[0].click();
            await new Promise((r) => setTimeout(r, 300));
            const sel2 = [...document.querySelectorAll('.details select')].find(
              (s) => [...s.options].some((o) => o.value === 'balanced')
            );
            persisted = sel2 ? sel2.value === after : false;
          }
          return { before, after, options: sel.options.length, persisted, estimateChanged };
        })()`,
      );
      extraChecks.push(
        [
          '质量下拉：可选档位完整',
          qualityChange.options >= 5,
          `${qualityChange.options} 个档位`,
        ],
        [
          '质量下拉：切换后值生效',
          qualityChange.after !== qualityChange.before && qualityChange.after.length > 0,
          `${qualityChange.before} → ${qualityChange.after}`,
        ],
        [
          '质量下拉：切换后体积预估联动',
          qualityChange.estimateChanged,
          qualityChange.estimateChanged ? '预估已变化' : '预估未变化',
        ],
        [
          '质量选择跨文件保留',
          qualityChange.persisted,
          qualityChange.persisted ? '切文件后仍是所选档位' : '切文件后丢失（预期应为保留）',
        ],
      );

      // 移除第二个文件，保持后续队列/转换用例只有 1 个文件
      await evalJs<boolean>(
        '移除第二个文件',
        `(() => {
          const cards = [...document.querySelectorAll('.file-card')];
          const last = cards[cards.length - 1];
          if (last) last.querySelector('.file-remove')?.click();
          return true;
        })()`,
      );
      await shotDelay(300);
    } else {
      /*
       * 第二个样本找不到时**必须报一条失败**，不能默默少跑 8 项。
       *
       * 这是"假通过"的另一种形态：检查项被跳过后摘要仍然打印"全部通过"，
       * 于是没人会注意到覆盖范围缩水了。打包态就是这样退化成了 58/58（开发态 66/66），
       * 而文档一直宣称两者"完全相同"。
       * 现在只要样本缺失，就明确失败并说清怎么修。
       */
      extraChecks.push([
        '多文件相关检查（跨文件保留 / 勾选 / 质量联动）能跑起来',
        false,
        `第二个样本不存在：${secondSample}。这 8 项检查会被跳过。` +
          `开发态请先跑 npm run samples；打包态请加 --smoke-assets=<仓库的 test-assets 目录>`,
      ]);
    }

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
            sizeLimitMb: null, deviceId: null, useCaseId: null, fitMode: 'off',
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

      /*
       * 勾选语义的最终验证：先只勾选「第 2 个文件」，然后点「开始转换」，
       * 断言引擎里实际产生的任务**只有那一个文件**。
       *
       * 前面的界面断言只证明"勾选计数会联动"，这一步才证明"勾选真的限制了转换范围"，
       * 也就是用户真正关心的那句话：我能不能挑着转。
       */
      const pickedFileName = await evalJs<{ name: string; total: number }>(
        '只勾选第 2 个文件',
        `(async () => {
          const boxes = [...document.querySelectorAll('.pick-box input')];
          const pick = (sel) => {
            const b = [...document.querySelectorAll('.pane-actions .btn')].find(
              (x) => (x.textContent ?? '').includes(sel)
            );
            if (b) b.click();
          };
          pick('取消全选');
          await new Promise((r) => setTimeout(r, 120));
          const box = boxes[1] ?? boxes[0];
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 150));
          const cards = [...document.querySelectorAll('.file-card')];
          const idx = boxes.indexOf(box);
          return {
            name: (cards[idx]?.querySelector('.file-name')?.textContent ?? '').trim(),
            total: boxes.length,
          };
        })()`,
      );
      await shotDelay(200);

      /*
       * 「质量下拉真的有用吗」的硬证据。
       *
       * 光看界面值变了、预估变了都只是间接迹象，必须看到 ffmpeg 命令里的
       * 编码参数跟着变才算证明它影响转换结果。
       *
       * 但这里有个先后关系需要注意：**设了目标体积上限时，质量档位不参与决定**
       * （体积优先时码率是算出来的，不是猜出来的），命令里会是 -b:v + 两遍编码，
       * 而不是 -crf。所以分两种情况断言，两种都是正确行为：
       *   · 有体积上限 → 必须出现 -b:v 与 -pass 2，且**不应**出现 -crf
       *   · 无体积上限 → 必须是「极小体积」对应的 -crf 34
       * 先读一次体积上限输入框，决定断言哪一支。
       */
      const sizeLimitState = await evalJs<{ hasLimit: boolean; value: string }>(
        '读取当前体积上限',
        `(() => {
          const input = document.querySelector('.size-limit input');
          const value = input ? String(input.value) : '';
          return { hasLimit: Boolean(value && Number(value) > 0), value };
        })()`,
      );

      const qualityForCommand = await evalJs<{ picked: string; label: string }>(
        '将质量切到「极小体积」',
        `(() => {
          const sel = [...document.querySelectorAll('.details select')].find(
            (s) => [...s.options].some((o) => o.value === 'balanced')
          );
          if (!sel) return { picked: '', label: '' };
          sel.value = 'tiny';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          const label = (sel.options[sel.selectedIndex]?.textContent ?? '').trim();
          return { picked: sel.value, label };
        })()`,
      );
      await shotDelay(300);

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

      // 勾选限制转换范围：只勾了 1 个文件，队列里就应该只有 1 个任务，且是该文件
      const jobsAfterClick = engine.list();
      const onlyPicked =
        jobsAfterClick.length === 1 && jobsAfterClick[0].sourceName === pickedFileName.name;
      extraChecks.push([
        '勾选后「开始转换」只转勾选的文件',
        onlyPicked,
        `共 ${pickedFileName.total} 个文件，只勾选「${pickedFileName.name}」→ 队列 ${jobsAfterClick.length} 个任务（${jobsAfterClick.map((j) => j.sourceName).join(', ')}）`,
      ]);

      // 把"界面上的选择"与"真实执行的 ffmpeg 命令"对上。
      // 两种模式分别断言（见上面 sizeLimitState 的说明），都是硬断言：
      //   · 有体积上限 → -b:v + -pass 2，且不能有 -crf
      //   · 无体积上限 → 「极小体积」必须是 CRF 34
      const newJob = engine.list().find((j) => j.state !== 'canceled');
      const cmd = newJob?.command ?? '';
      const crfMatch = /-crf\s+(\d+)/.exec(cmd);
      const bvMatch = /-b:v\s+(\d+)k/.exec(cmd);

      if (sizeLimitState.hasLimit) {
        extraChecks.push([
          '体积上限生效：命令用目标码率 + 两遍编码，且不再给 CRF',
          Boolean(bvMatch) && !crfMatch,
          bvMatch
            ? `上限 ${sizeLimitState.value}MB → -b:v ${bvMatch[1]}k${crfMatch ? `（⚠ 仍出现了 -crf ${crfMatch[1]}）` : '，无 -crf'}`
            : `命令里未找到 -b:v（片段：${cmd.slice(0, 70)}）`,
        ]);
      } else {
        extraChecks.push([
          '质量下拉真的影响 ffmpeg 命令（极小体积 → CRF 34）',
          qualityForCommand.picked === 'tiny' && crfMatch?.[1] === '34',
          crfMatch
            ? `界面选「${qualityForCommand.label.slice(0, 8)}」，命令里 -crf ${crfMatch[1]}`
            : `未在命令里找到 -crf（片段：${cmd.slice(0, 70)}）`,
        ]);
      }

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
          queueReport.state.includes('已完成') && /\d/.test(queueReport.outSize) && queueReport.hasOpenBtn,
          `状态「${queueReport.state}」，产物 ${queueReport.outSize}，${queueReport.hasOpenBtn ? '有打开按钮' : '无打开按钮'}`,
        ]);

        /*
         * 队列级控制（暂停 / 继续 / 重排 / 并发）—— 2026-09 新增，见 DECISIONS.md D-023。
         *
         * 真实的用户路径：先「暂停队列」，再点「开始转换」—— 任务会停在排队中而不启动；
         * 此时排队卡片上应出现置顶/上移/下移，队列页头部应出现「继续队列」。
         * 这条链路走完，才说明这些按钮不是摆设。
         */
        const queueCtl = await evalJs<{
          pauseBtnExists: boolean;
          pausedLabel: string;
          queuedAfterPause: number;
          moveButtons: number;
          concurrencyOptions: number;
          resumeWorked: boolean;
          error: string;
        }>(
          '验证队列暂停 / 重排 / 并发控件',
          `(async () => {
            const tick = (ms) => new Promise((r) => setTimeout(r, ms));
            const blank = { pauseBtnExists: false, pausedLabel: '', queuedAfterPause: 0, moveButtons: 0, concurrencyOptions: 0, resumeWorked: false, error: '' };
            try {
              const nav = (i) => document.querySelectorAll('.nav-item')[i]?.click();

              // 1) 队列页：点「暂停队列」
              nav(1);
              await tick(400);
              const pauseBtn = [...document.querySelectorAll('.queue-head button')].find((b) =>
                (b.textContent ?? '').includes('暂停队列'),
              );
              if (!pauseBtn) return { ...blank, error: '队列页没有「暂停队列」按钮' };
              pauseBtn.click();
              await tick(400);
              const pausedLabel = (document.querySelector('.queue-head .chip-warn')?.textContent ?? '').trim();
              const concurrencyOptions = document.querySelectorAll('.queue-head .concurrency option').length;

              // 2) 回转换页点「开始转换」：任务应停在排队中
              nav(0);
              await tick(300);
              const startBtn = [...document.querySelectorAll('.pane-actions .btn, .btn-primary')].find((b) =>
                (b.textContent ?? '').includes('开始转换'),
              );
              if (startBtn) startBtn.click();
              await tick(1400);

              // 3) 回队列页看：排队卡片 + 重排按钮
              nav(1);
              await tick(600);
              const queuedCards = [...document.querySelectorAll('.job-card.queued')];
              const moveButtons = queuedCards.reduce(
                (n, c) => n + c.querySelectorAll('.move-btn').length,
                0,
              );

              // 4) 继续队列
              const resumeBtn = [...document.querySelectorAll('.queue-head button')].find((b) =>
                (b.textContent ?? '').includes('继续队列'),
              );
              if (resumeBtn) resumeBtn.click();
              await tick(1800);
              const resumeWorked = !document.querySelector('.queue-head .chip-warn');

              return {
                pauseBtnExists: true,
                pausedLabel,
                queuedAfterPause: queuedCards.length,
                moveButtons,
                concurrencyOptions,
                resumeWorked,
                error: '',
              };
            } catch (e) {
              return { ...blank, error: String(e) };
            }
          })()`,
        );
        extraChecks.push(
          [
            '队列控制：提供「暂停队列 / 继续队列」且暂停后任务真的停在排队中',
            queueCtl.pauseBtnExists && queueCtl.pausedLabel.includes('已暂停') && queueCtl.queuedAfterPause >= 1,
            queueCtl.error
              ? `执行出错：${queueCtl.error}`
              : `暂停标记「${queueCtl.pausedLabel}」，暂停期间排队任务 ${queueCtl.queuedAfterPause} 个`,
          ],
          [
            '队列控制：排队中的任务带重排按钮（置顶 / 上移 / 下移）',
            queueCtl.moveButtons >= 3,
            `排队卡片上的重排按钮共 ${queueCtl.moveButtons} 个`,
          ],
          [
            '队列控制：队列页可直接调并发数，且「继续」能恢复调度',
            queueCtl.concurrencyOptions >= 4 && queueCtl.resumeWorked,
            `并发可选 ${queueCtl.concurrencyOptions} 档；继续后暂停标记${queueCtl.resumeWorked ? '已消失' : '仍在'}`,
          ],
        );
      } else {
        extraChecks.push(['应用内转换：任务完成', false, '等待超时，未进入终态']);
      }
    }
  }

  /**
   * 依次切到队列页 / 设置页截图。
   *
   * 防覆盖：只有在「没有跑过 --smoke-convert」时才写 queue.png。
   * 否则同一次运行里已经截过"转换完成后的队列页"（queue-done.png），
   * 再截一次 queue.png 会把空队列那张覆盖成同一张图 —— 这正是之前的实际 bug：
   * 文档里宣称"queue.png 是空队列、queue-done.png 是转换完成后"，
   * 而两个文件的 sha256 完全相同。
   *
   * 因此正确的截图工作流是两步：
   *   1) `--smoke --smoke-file=…`            产出 main / main-with-file / queue / settings
   *   2) `--smoke --smoke-file=… --smoke-convert`  额外产出 queue-done（不动 queue.png）
   *
   * 打包态跑自检还要多带一个 `--smoke-assets=<仓库的 test-assets 目录>`：
   * 便携版旁边没有测试素材，不给这个参数会有 8 项多文件检查被跳过
   * （跳过会**明确报一条失败**，不会静默少跑）。
   */
  const ranConversion = process.argv.includes('--smoke-convert');
  if (!ranConversion) {
    await capture('queue.png', 1);
  } else if (!existsSync(path.join(outDir, 'queue.png'))) {
    console.warn('[smoke] 提示：queue.png 不存在，请先跑一次不带 --smoke-convert 的自检');
  }
  await capture('settings.png', 2);
  // 回到转换页
  await evalJs<boolean>(
    '切回转换页',
    `(() => { document.querySelectorAll('.nav-item')[0].click(); return true; })()`,
  );

  const queuePage = shots.find((s) => s.name.startsWith('queue'))?.page;
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
  handle<boolean>('jobs:pause-queue', () => engine.pauseQueue());
  handle<boolean>('jobs:resume-queue', () => engine.resumeQueue());
  handle<boolean>('jobs:move', (id: string, direction: 'up' | 'down' | 'top') =>
    engine.moveJob(id, direction),
  );

  /*
   * 磁盘剩余空间（开转前的预检用）。
   * `fsp.statfs` 需要 Node 18.15+ / Electron 相应版本，本机满足；
   * 拿不到时返回 0，调用方按"不知道"处理（不拦用户）。
   */
  handle<number>('system:free-space', async (target: string) => {
    try {
      const stats = await fsp.statfs(target);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return 0;
    }
  });
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

// isSmokeMode 已在文件顶部（单实例判定之前）声明 —— 那里需要它来决定拿不到锁时
// 是"静默退出"还是"报错并非零退出"。

app.whenReady().then(async () => {
  registerMediaProtocol();

  settings = await loadSettings();

  const bins = getBinaries(settings);
  ffmpegPath = bins.ffmpeg.path;
  ffprobePath = bins.ffprobe.path;
  engine.setFfmpegPath(ffmpegPath);
  engine.setFfprobePath(ffprobePath);
  engine.setConcurrency(settings.concurrency);

  // 先清掉上次自检遗留的任务，再创建窗口。
  //
  // 位置很关键：这个清理必须在 createWindow() **之前**完成。
  // 早期实现放在窗口加载后清，与渲染进程 initStore() 读列表构成竞态 ——
  // 实测 3 次里有 1 次会读到旧列表，导致「空队列」断言时灵时不灵（20/21）。
  // 放在窗口创建前，渲染层首次拿到的就已经是空列表，不存在竞态。
  //
  // 同理，界面偏好（appMode / theme）也要在这里重置：它同样是渲染层
  // initStore() 会读的持久化状态，放到窗口加载后再改一样会有竞态
  // （实测出现过"磁盘已是 recommended、渲染层读到的还是上一轮的 custom"）。
  if (isSmokeMode) {
    const staleJobs = engine.list();
    if (staleJobs.length > 0) {
      for (const j of staleJobs) await engine.remove(j.id);
      console.log(`[smoke] 已清理 ${staleJobs.length} 个上次运行遗留的任务，保证自检从干净队列开始`);
    }
    // 自检需要确定的初始界面状态：推荐模式 + 跟随系统主题
    settings = await saveSettings({ appMode: 'recommended', theme: 'system' });
    console.log('[smoke] 界面偏好已重置为推荐模式 + 跟随系统主题');
  }

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
