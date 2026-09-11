/**
 * 应用状态中心（组合式函数，不引 Pinia）。
 *
 * 为什么不用状态库：这个应用的状态图很简单（文件队列 / 任务 / 设置 / 能力），
 * 一个模块级单例 + ref 就够，少一层抽象也少一份打包体积。
 *
 * 关键设计：任务状态以主进程为准，这里只是「投影」。
 * 渲染进程不做任何乐观更新，避免界面显示"已完成"但实际失败这类不一致。
 */
import { computed, reactive, ref } from 'vue';
import type {
  AppSettings,
  CompatibilityIssue,
  ConversionOptions,
  CreateJobRequest,
  MediaJob,
  MediaProbeResult,
  SystemCapabilities,
} from '@shared/types';
import {
  CONVERSION_PRESETS,
  QUALITY_PRESETS,
  RESOLUTION_PRESETS,
  FPS_PRESETS,
  VIDEO_CODECS,
  CONTAINERS,
  findPreset,
} from '@shared/presets';
import { checkCompatibility } from '@shared/compatibility';
import { fileExtension, predictOutputBytes } from '@/utils/format';

/* ------------------------------ 类型 ------------------------------ */

export interface LoadedFile {
  path: string;
  probe: MediaProbeResult | null;
  thumbnail: string | null;
  status: 'analyzing' | 'ready' | 'error';
  error: string | null;
  /** 用户在界面上单独调整过的选项（未调整则继承全局） */
  overrides?: Partial<ConversionOptions>;
}

/* ------------------------------ 单例状态 ------------------------------ */

const api = window.converter;

export const files = ref<LoadedFile[]>([]);
export const activePath = ref<string | null>(null);
export const jobs = ref<MediaJob[]>([]);
export const capabilities = ref<SystemCapabilities | null>(null);
export const settings = ref<AppSettings | null>(null);
export const jobLogs = reactive<Record<string, string[]>>({});
export const toast = ref<{ text: string; kind: 'info' | 'success' | 'danger' } | null>(null);

/**
 * 初始化是否已完成。
 * 界面骨架（标题栏/导航/空状态）在 store 就绪前就能渲染，但设置页依赖
 * settings 数据（v-if 会让整块不渲染），所以需要一个明确的标志：
 *   1) 给界面用：避免"看起来渲染了其实是空的"
 *   2) 给自动化界面自检（npm run smoke:ui）用：等待条件不能只看 DOM 是否存在
 */
export const storeReady = ref(false);

/** 三栏布局的当前页 */
export const activeView = ref<'convert' | 'queue' | 'settings'>('convert');

/* ------------------------------ 全局转换选项 ------------------------------ */

export const options = ref<ConversionOptions>({
  // 默认落在「发微信 / QQ」这个用途上：它代表最常见的场景，
  // 且固定 H.264 + 1080p + 100MB 上限，用户不改任何东西也能得到可用的产物
  presetId: 'mp4-compatible',
  videoCodecId: 'h264',
  audioCodecId: 'aac',
  qualityId: 'balanced',
  resolutionId: '1080p',
  fpsId: 'source',
  sizeLimitMb: 100,
  // 默认设备跟着默认用途「发微信 / QQ」走（见 shared/use-cases.ts 的 2026-09 修订）
  deviceId: 'android-phone',
  useCaseId: 'wechat',
  // 画面比例默认**保持原样**：补黑边/裁剪都是用户看得见的画面损失，必须是显式选择
  fitMode: 'off',
  // 字幕默认既不保留也不烧录（烧录会强制重编码，不能默认开）
  burnSubtitleIndex: null,
  // 音频处理默认全关：不动用户的原始音频是最安全的默认值
  audioLoudnorm: false,
  audioVolumeDb: null,
  audioChannels: 'source',
  outputDir: null,
  fileNameTemplate: '{name}',
  overwrite: false,
  keepMetadata: true,
  trimStartSec: null,
  trimEndSec: null,
  subtitleStreamIndexes: [],
  audioStreamIndexes: [],
});

/* ------------------------------ 派生数据 ------------------------------ */

/** 转换前兼容性检查（选错编码器 / 目标体积不可行等） */
export const compatibilityIssues = computed<CompatibilityIssue[]>(() => {
  const probe = activeProbe.value;
  if (!probe) return [];
  const preset = activePreset.value;
  const container = CONTAINERS[preset.container];
  const quality =
    QUALITY_PRESETS.find((q) => q.id === options.value.qualityId) ?? QUALITY_PRESETS[2];
  const res = RESOLUTION_PRESETS.find((r) => r.id === options.value.resolutionId);
  try {
    return checkCompatibility({
      probe,
      options: options.value,
      targetHeight: res?.height ?? null,
      audioBitrateKbps: options.value.audioCodecId === 'none' ? 0 : quality.audioBitrateKbps,
    });
  } catch (err) {
    // 兼容性检查只是"锦上添花"，它自身出错绝不能拦住转换
    console.error('[compatibility] 检查失败：', err);
    void container;
    return [];
  }
});

/** 有没有必须处理的问题（block） */
export const hasBlockingIssue = computed(() =>
  compatibilityIssues.value.some((i) => i.level === 'block'),
);

/** 一键套用某个问题的修复建议 */
export function applyCompatibilityFix(fix: Partial<ConversionOptions>): void {
  options.value = { ...options.value, ...fix };
}

export const activeFile = computed<LoadedFile | null>(
  () => files.value.find((f) => f.path === activePath.value) ?? null,
);

export const activeProbe = computed<MediaProbeResult | null>(() => activeFile.value?.probe ?? null);

export const activePreset = computed(() => findPreset(options.value.presetId) ?? CONVERSION_PRESETS[0]);

export const runningJobs = computed(() =>
  jobs.value.filter((j) => j.state === 'running' || j.state === 'queued'),
);

export const finishedJobs = computed(() =>
  jobs.value.filter((j) => j.state === 'done' || j.state === 'failed' || j.state === 'canceled'),
);

/** 硬件编码器可用性映射 */
export const encoderAvailability = computed(() => {
  const map = new Map<string, { available: boolean; reason: string | null }>();
  for (const e of capabilities.value?.encoders ?? []) {
    map.set(e.id, { available: e.available, reason: e.reason });
  }
  return map;
});

/** 当前预设下可选的视频编码器（受容器限制 + 硬件可用性过滤） */
export const availableVideoCodecs = computed(() => {
  const preset = activePreset.value;
  const container = CONTAINERS[preset.container];
  return VIDEO_CODECS.filter((c) => container.videoCodecs.includes(c.id)).map((c) => {
    const av = encoderAvailability.value.get(c.id);
    return {
      ...c,
      available: av ? av.available : true,
      unavailableReason: av?.reason ?? null,
    };
  });
});

/** 预期产物体积（用于转换前的提示） */
/**
 * 预估某个文件在给定参数下的产物大小。
 *
 * 从 `predictedOutput` 里抽出来是为了**批量场景复用**：
 * 开始转换前要用它把 N 个文件的预计总产出加起来，跟目标磁盘的剩余空间对一下
 * （见 D-023 的磁盘空间预检）。写成 computed 的话只有"当前选中文件"能算，
 * 批量就没办法了。
 */
export function estimateOutputBytes(
  probe: { sizeBytes: number; durationSec: number },
  opts: ConversionOptions,
): { bytes: number; approximate: boolean; note: string } {
  const preset = CONVERSION_PRESETS.find((p) => p.id === opts.presetId) ?? CONVERSION_PRESETS[0];
  const container = CONTAINERS[preset.container];
  const quality = QUALITY_PRESETS.find((q) => q.id === opts.qualityId) ?? QUALITY_PRESETS[2];

  // 直通：产物大小≈源大小
  if (opts.videoCodecId === 'copy' || container.id === 'copy') {
    return { bytes: probe.sizeBytes, approximate: true, note: '不重新编码，体积与源文件接近' };
  }

  /*
   * 目标体积模式：预估直接就是目标值。
   * 这也是这个功能的意义 —— 用户不用再"猜一档质量、转完看结果、不行再转一遍"。
   */
  if (opts.sizeLimitMb && opts.sizeLimitMb > 0 && container.videoCodecs.length > 0) {
    const targetBytes = Math.round(opts.sizeLimitMb * 1024 * 1024);
    const duration = Math.max(0.1, probe.durationSec);
    const totalKbps = (targetBytes * 8) / duration / 1000;
    const audioKbps = opts.audioCodecId === 'none' ? 0 : quality.audioBitrateKbps;
    return {
      bytes: targetBytes,
      approximate: false,
      note:
        `按目标体积反推：总码率约 ${Math.round(totalKbps)} kbps` +
        `（视频 ${Math.round(Math.max(50, totalKbps - audioKbps))} + 音频 ${audioKbps}），两遍编码精确命中`,
    };
  }

  if (!container.videoCodecs.length) {
    // 纯音频导出：按音频码率估算
    const hw = quality.audioBitrateKbps;
    const bytes = Math.round((hw * 1000 * probe.durationSec) / 8);
    return { bytes, approximate: true, note: '仅音频，约等于音频码率 × 时长' };
  }

  const scale: Record<string, number> = {
    source: 1,
    '2160p': 4,
    '1440p': 2,
    '1080p': 1,
    '720p': 0.55,
    '480p': 0.3,
    '360p': 0.18,
  };
  const factor = scale[opts.resolutionId] ?? 1;
  const bitrate = quality.bitrateKbps * factor + quality.audioBitrateKbps;
  // predictOutputBytes 在码率/时长为 0 时返回 null（表示"算不出来"）。
  // 这里把它折成 0 并标注为近似值：调用方（磁盘预检）会跳过 0，不会拿它当真。
  const bytes = predictOutputBytes(bitrate, probe.durationSec) ?? 0;
  return {
    bytes,
    approximate: true,
    note: `按 ${quality.label} 质量与目标分辨率估算`,
  };
}

export const predictedOutput = computed(() => {
  const probe = activeProbe.value;
  if (!probe) return null;
  // 用当前文件真正生效的参数（全局 + 本文件覆盖），而不是只看全局
  const opts = activeFile.value ? effectiveOptions(activeFile.value) : options.value;
  return estimateOutputBytes(probe, opts);
});

/* ------------------------------ 动作 ------------------------------ */

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(text: string, kind: 'info' | 'success' | 'danger' = 'info', ms = 4000): void {
  toast.value = { text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, ms);
}

/** 从路径列表添加文件（拖拽与「选择文件」共用） */
export async function addFiles(paths: string[]): Promise<void> {
  const known = new Set(files.value.map((f) => f.path));
  const fresh: LoadedFile[] = [];
  for (const p of paths) {
    if (known.has(p)) continue;
    known.add(p);
    fresh.push({ path: p, probe: null, thumbnail: null, status: 'analyzing', error: null });
  }
  if (fresh.length === 0) return;

  files.value = [...files.value, ...fresh];
  if (!activePath.value) activePath.value = fresh[0].path;

  // 并发探测但有上限，避免一次拖入 50 个文件时把 ffprobe 打爆
  const queue = [...fresh];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      await analyzeOne(item);
    }
  });
  await Promise.all(workers);
}

async function analyzeOne(item: LoadedFile): Promise<void> {
  const res = await api.probe(item.path);
  const target = files.value.find((f) => f.path === item.path);
  if (!target) return;

  if (!res.ok) {
    target.status = 'error';
    target.error = res.error;
    return;
  }
  target.probe = res.data;
  target.status = 'ready';
  target.error = null;

  // 缩略图与探测并行会更慢（都要解码），探测完成后再取，且不阻塞 UI
  void loadThumbnail(item.path);
}

export async function loadThumbnail(path: string): Promise<void> {
  const res = await api.thumbnail(path);
  const target = files.value.find((f) => f.path === path);
  if (!target) return;
  if (res.ok && res.data.filePath) {
    target.thumbnail = res.data.filePath;
  } else if (res.ok && res.data.error) {
    // 缩略图失败不算致命错误，界面上给占位图即可
    target.thumbnail = null;
  }
}

export function removeFile(path: string): void {
  files.value = files.value.filter((f) => f.path !== path);
  if (activePath.value === path) {
    activePath.value = files.value[0]?.path ?? null;
  }
}

export function clearFiles(): void {
  files.value = [];
  activePath.value = null;
}

/** 当前选中的文件覆盖选项（用于「本文件单独设置」） */
export function setActiveOverride(patch: Partial<ConversionOptions>): void {
  const file = activeFile.value;
  if (!file) return;
  file.overrides = { ...(file.overrides ?? {}), ...patch };
}

export function clearActiveOverride(): void {
  const file = activeFile.value;
  if (file) file.overrides = undefined;
}

/**
 * 合并全局选项与文件级覆盖，并**返回脱离响应式的纯对象**。
 *
 * 为什么必须去响应式（真实 bug，第 2 轮自测才发现）：
 * `file.overrides` 存进响应式 `files` 之后，其中的数组字段（subtitleStreamIndexes /
 * audioStreamIndexes）会被 Vue 包成 Proxy 数组。IPC 的 structuredClone 无法克隆 Proxy，
 * 于是 ipcRenderer.invoke 抛 "An object could not be cloned."，
 * 表现是：用户只要改过字幕/音轨勾选，点「开始转换」就静默失败、队列里什么都没有。
 * 单元测试与"点按钮没报错"都发现不了这个问题，只有真正跑一遍界面交互才会暴露。
 *
 * 实现上用 JSON 往返而不是 structuredClone：这个结构里只有字符串/数字/布尔/null/数组，
 * 没有 Date、Map 等需要保留类型的值，JSON 往返最稳妥且无需担心兼容性。
 */
export function effectiveOptions(file: LoadedFile): ConversionOptions {
  const merged = { ...options.value, ...(file.overrides ?? {}) };
  return JSON.parse(JSON.stringify(merged)) as ConversionOptions;
}

/** 把文件加入转换队列；传入 paths 时只处理这些（用于"只转勾选的"） */
export async function startConversion(paths?: string[]): Promise<number> {
  const targets = paths
    ? // 显式指定时也要过滤掉尚未分析完 / 分析失败的文件，
      // 否则会拿着没有 probe 结果的文件去建任务
      files.value.filter((f) => paths.includes(f.path) && f.status === 'ready')
    : files.value.filter((f) => f.status === 'ready');
  if (targets.length === 0) {
    showToast(paths && paths.length > 0 ? '勾选的文件都还没分析完或无法读取' : '没有可转换的文件', 'danger');
    return 0;
  }

  const requests: CreateJobRequest[] = targets.map((f) => ({
    sourcePath: f.path,
    options: effectiveOptions(f),
  }));

  /*
   * 磁盘空间预检（2026-09 新增，见 DECISIONS.md D-023）。
   *
   * 为什么要做：批量转 4K 素材很容易写出几十 GB，盘满时 ffmpeg 会在**转了很久之后**
   * 才报 "No space left on device"，用户白等一场。这里在开转前把"预计总产出"和
   * 目标盘的剩余空间对一下 —— 估算本来就是近似的，所以留 10% 余量并且只说"可能不够"，
   * 由用户决定是否继续（不硬拦）。
   */
  try {
    const outputDir =
      targets[0]?.overrides?.outputDir ??
      targets[0]?.probe?.path?.replace(/[\\/][^\\/]*$/, '') ??
      options.value.outputDir ??
      null;
    if (outputDir) {
      const free = await api.freeSpace(outputDir);
      if (free.ok && free.data > 0) {
        const estimated = targets.reduce((sum, f) => {
          if (!f.probe) return sum;
          const e = estimateOutputBytes(f.probe, effectiveOptions(f));
          return sum + e.bytes;
        }, 0);
        if (estimated > 0 && estimated * 1.1 > free.data) {
          const need = (estimated / 1024 ** 3).toFixed(1);
          const have = (free.data / 1024 ** 3).toFixed(1);
          showToast(
            `目标磁盘剩余 ${have} GB，预计要写出约 ${need} GB（估算值）—— 可能不够，建议先清理磁盘或改输出目录`,
            'danger',
            8000,
          );
        }
      }
    }
  } catch {
    /* 预检失败不影响转换本身，静默跳过 */
  }

  let res;
  try {
    res = await api.createJobs(requests);
  } catch (err) {
    // IPC 参数无法被结构化克隆时会在这里抛错。这类错误默认只在控制台留一行
    // 没有上下文的提示，用户只会看到"点了没反应"，因此必须显式兜住并给出提示。
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[startConversion] createJobs 调用失败：' + msg);
    showToast(`无法创建转换任务：${msg}`, 'danger', 8000);
    return 0;
  }
  if (!res.ok) {
    showToast(`加入队列失败：${res.error}`, 'danger');
    return 0;
  }

  const failures = res.data.filter((r) => r.error);
  const successes = res.data.filter((r) => r.job);
  if (failures.length > 0) {
    // 逐个列出失败原因，比笼统说"部分失败"有用得多
    const detail = failures
      .slice(0, 3)
      .map((f) => f.error)
      .join('；');
    showToast(
      `${successes.length} 个已加入队列，${failures.length} 个未通过检查：${detail}`,
      failures.length === res.data.length ? 'danger' : 'info',
      8000,
    );
  } else {
    showToast(`已加入队列：${successes.length} 个任务`, 'success');
  }

  if (successes.length > 0) activeView.value = 'queue';
  return successes.length;
}

export async function refreshJobs(): Promise<void> {
  const res = await api.listJobs();
  if (res.ok) jobs.value = res.data;
}

export async function cancelJob(id: string): Promise<void> {
  await api.cancelJob(id);
}

export async function retryJob(id: string): Promise<void> {
  const res = await api.retryJob(id);
  if (!res.ok) showToast(`重试失败：${res.error}`, 'danger');
}

export async function removeJob(id: string): Promise<void> {
  await api.removeJob(id);
  jobs.value = jobs.value.filter((j) => j.id !== id);
}

export async function clearFinished(): Promise<void> {
  const res = await api.clearFinished();
  if (res.ok) {
    await refreshJobs();
    showToast(`已清除 ${res.data} 条记录`, 'info', 2000);
  }
}

/* ---------------- 队列级控制（暂停 / 继续 / 重排） ---------------- */

/** 队列是否处于暂停（暂停 = 不再启动新任务，正在跑的继续跑完） */
export const queuePaused = ref(false);

export async function pauseQueue(): Promise<void> {
  const res = await api.pauseQueue();
  if (!res.ok) {
    showToast(`暂停失败：${res.error}`, 'danger');
    return;
  }
  queuePaused.value = res.data;
  showToast('队列已暂停：正在转换的任务会跑完，后面的先不开始', 'info', 3200);
}

export async function resumeQueue(): Promise<void> {
  const res = await api.resumeQueue();
  if (!res.ok) {
    showToast(`继续失败：${res.error}`, 'danger');
    return;
  }
  queuePaused.value = res.data;
  showToast('队列已继续', 'info', 2000);
}

export async function moveJob(id: string, direction: 'up' | 'down' | 'top'): Promise<void> {
  const res = await api.moveJob(id, direction);
  if (!res.ok) {
    showToast(`调整顺序失败：${res.error}`, 'danger');
    return;
  }
  await refreshJobs();
}

/** 排队中的任务（按引擎给出的顺序），界面用它渲染"第 N 位"与重排按钮 */
export const queuedJobs = computed(() => jobs.value.filter((j) => j.state === 'queued'));

/**
 * 队列总剩余时间（秒）。
 *
 * 只累加**已知 ETA** 的任务：正在跑的用它的 etaSec，排队中的用"自己的预计时长"
 * （由预估体积/码率推不出来，所以排队中的暂时按"已运行任务的平均速度"估——
 *  估不出来就返回 null，界面显示"—"，**不编一个数字**）。
 */
export const queueEtaSec = computed<number | null>(() => {
  const list = jobs.value;
  const running = list.filter((j) => j.state === 'running');
  const queued = list.filter((j) => j.state === 'queued');
  if (running.length === 0 && queued.length === 0) return null;

  let total = running.reduce((sum, j) => sum + (j.progress?.etaSec ?? 0), 0);
  // 排队中的任务：用"每个已完成任务的平均耗时"粗估，没有历史就不猜
  const finished = list.filter((j) => j.state === 'done' && j.startedAt && j.finishedAt);
  if (queued.length > 0) {
    if (finished.length === 0) return null;
    const avgSec =
      finished.reduce((sum, j) => sum + ((j.finishedAt ?? 0) - (j.startedAt ?? 0)) / 1000, 0) /
      finished.length;
    total += avgSec * queued.length;
  }
  return total > 0 ? Math.round(total) : null;
});

export async function openJobOutput(id: string): Promise<void> {
  const ok = await api.openOutput(id);
  if (!ok.ok || !ok.data) showToast('输出文件不存在，可能已被移动或删除', 'danger');
}

/* ------------------------------ 初始化 ------------------------------ */

let initialized = false;

export async function initStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const [s, c, j] = await Promise.all([api.getSettings(), api.getCapabilities(), api.listJobs()]);
  if (s.ok) settings.value = s.data;
  if (c.ok) capabilities.value = c.data;
  if (j.ok) jobs.value = j.data;

  // 应用主题
  applyTheme(settings.value?.theme ?? 'system');

  api.onJobUpdated((job) => {
    const idx = jobs.value.findIndex((j) => j.id === job.id);
    const prev = idx >= 0 ? jobs.value[idx] : null;
    if (idx >= 0) jobs.value[idx] = job;
    else jobs.value = [job, ...jobs.value];

    const justFinished = job.state === 'done' && prev?.state !== 'done';
    if (justFinished) {
      if (settings.value?.notifyOnFinish) notifyDone(job);
      // 「完成后打开输出目录」是一个明确勾选的偏好，这里才真正生效
      if (settings.value?.openFolderOnFinish) void api.openOutput(job.id);
    }
  });

  api.onJobLog(({ jobId, line }) => {
    const arr = jobLogs[jobId] ?? (jobLogs[jobId] = []);
    arr.push(line);
    // 单任务日志上限，防止长视频转 3 小时后日志吃掉几百 MB
    if (arr.length > 500) arr.splice(0, arr.length - 500);
  });

  api.onCapabilitiesUpdated((caps) => {
    capabilities.value = caps;
  });

  storeReady.value = true;
}

export function applyTheme(theme: AppSettings['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  const res = await api.saveSettings(patch);
  if (res.ok) {
    settings.value = res.data;
    if (patch.theme) applyTheme(res.data.theme);
    if (patch.ffmpegPath !== undefined || patch.ffprobePath !== undefined) {
      const c = await api.getCapabilities(true);
      if (c.ok) capabilities.value = c.data;
    }
  } else {
    showToast(`保存设置失败：${res.error}`, 'danger');
  }
}

function notifyDone(job: MediaJob): void {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification('转换完成', { body: job.sourceName, silent: false });
    } else if (Notification.permission !== 'denied') {
      // requestPermission() 返回 Promise；在某些环境下该 Promise 会跨 IPC 传递，
      // 而 Promise 不可结构化克隆，会抛 "An object could not be cloned."。
      // 因此这里必须显式 void + catch，避免把整个任务的更新流程带崩。
      void Notification.requestPermission().catch(() => undefined);
    }
  } catch {
    /* 通知失败不影响主流程：它是锦上添花，不是必要路径 */
  }
}

/* 供组件使用的只读工具 */
export { CONVERSION_PRESETS, QUALITY_PRESETS, RESOLUTION_PRESETS, FPS_PRESETS, CONTAINERS, fileExtension };
