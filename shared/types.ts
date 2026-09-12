/**
 * 主进程 / 预加载 / 渲染进程共享的类型契约。
 * 这里只放「数据结构」，不放实现，保证三方引用同一份定义。
 */

import type { FitMode } from './output-size';

/**
 * 音频声道处理方式。
 * 'source' 保持原样；'mono' 混成单声道（体积更小、人声内容够用）；
 * 'stereo' 统一成立体声（把 5.1 下混，兼容性最好）。
 */
export type AudioChannelMode = 'source' | 'mono' | 'stereo';

/* ------------------------------------------------------------------ *
 * 视频信息探测（ffprobe）
 * ------------------------------------------------------------------ */

export interface VideoStreamInfo {
  index: number;
  codec: string;
  codecLongName: string;
  profile: string;
  width: number;
  height: number;
  /** 显示宽高（已按 sample_aspect_ratio 与旋转角校正，macroblocks 之外的直觉值） */
  displayWidth: number;
  displayHeight: number;
  /** 0 / 90 / 180 / 270 */
  rotation: number;
  fps: number;
  /** 平均帧率，VFR 视频下比 r_frame_rate 更可信 */
  avgFps: number;
  bitrateKbps: number | null;
  pixFmt: string;
  bitDepth: number;
  colorTransfer: string | null;
  /** 形如 smpte2084 / arib-std-b67 视为 HDR */
  isHdr: boolean;
  isAttachedPic: boolean;
  durationSec: number | null;
  language: string | null;
  title: string | null;
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
  codecLongName: string;
  profile: string;
  channels: number;
  channelLayout: string;
  sampleRate: number;
  bitrateKbps: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
}

export interface SubtitleStreamInfo {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  /** 文本字幕（可转软字幕） vs 图形字幕（PGS/VobSub，只能 copy 或烧录） */
  isTextBased: boolean;
}

export interface ChapterInfo {
  index: number;
  startSec: number;
  endSec: number;
  title: string | null;
}

export interface MediaProbeResult {
  /** 源文件绝对路径 */
  path: string;
  fileName: string;
  /** 容器格式，如 mov,mp4,m4a,3gp,3g2,mj2 */
  formatName: string;
  /** 人类可读容器名，如 MP4 / Matroska */
  formatLongName: string;
  /** 扩展名推导出的容器名，探测失败时兜底展示 */
  extension: string;
  durationSec: number;
  sizeBytes: number;
  /** 整体码率 kbps */
  bitrateKbps: number | null;
  /** 流数量为 0（如封面图 mp3 的极端情况）时为 true */
  hasVideo: boolean;
  hasAudio: boolean;
  hasSubtitle: boolean;
  video: VideoStreamInfo[];
  audio: AudioStreamInfo[];
  subtitle: SubtitleStreamInfo[];
  chapters: ChapterInfo[];
  /** 容器级元数据（title / artist / encoder …） */
  tags: Record<string, string>;
  /** 缩略图抽帧推荐时间点（秒），避开片头黑帧 */
  thumbnailAtSec: number;
}

/* ------------------------------------------------------------------ *
 * 缩略图
 * ------------------------------------------------------------------ */

export interface ThumbnailResult {
  sourcePath: string;
  /** 成功时是本地缓存文件路径；失败为 null */
  filePath: string | null;
  /** 实际抽帧时间点 */
  atSec: number;
  width: number | null;
  height: number | null;
  /** 失败原因（人类可读，供 UI 直接展示） */
  error: string | null;
  /** 是否来自缓存 */
  cached: boolean;
}

/* ------------------------------------------------------------------ *
 * 转换
 * ------------------------------------------------------------------ */

export type JobState =
  | 'queued'
  | 'probing'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled';

export interface ConversionProgress {
  /** 0 - 100，未知总时长时为 null（UI 显示不确定进度条） */
  percent: number | null;
  /** 已处理秒数 */
  processedSec: number;
  /** 已处理时长的文本形式，如 00:01:23 */
  processedText: string;
  /** 剩余秒数估算，null 表示暂不可估算 */
  etaSec: number | null;
  /** ffmpeg 上报的实时速度倍率，如 2.35 表示 2.35x */
  speed: number | null;
  /** 当前帧号 */
  frame: number | null;
  /** 已编码输出的字节数 */
  outBytes: number | null;
  /** 原始 -progress 键值对（用于「专家模式」展示与排错） */
  raw: Record<string, string>;
}

export interface JobError {
  /** 面向人类的一句话说明 */
  message: string;
  /** 归类，UI 据此给建议 */
  kind:
    | 'ffmpeg-missing'
    | 'unsupported-codec'
    | 'invalid-input'
    | 'disk-full'
    | 'permission'
    | 'canceled'
    | 'unknown';
  /** ffmpeg stderr 尾部原文，供折叠查看 / 复制 */
  rawLog: string;
  /** 针对性的修复建议 */
  hint: string | null;
}

export interface MediaJob {
  id: string;
  sourcePath: string;
  sourceName: string;
  outputPath: string;
  /** 源文件大小，用于显示压缩比 */
  sourceSizeBytes: number;
  sourceDurationSec: number;
  presetId: string;
  presetLabel: string;
  /** 将要执行的完整 ffmpeg 命令行（专家模式展示，也方便出问题自查） */
  command: string;
  state: JobState;
  progress: ConversionProgress | null;
  error: JobError | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 完成后产物的实际大小 */
  outputSizeBytes: number | null;
  createdAtLabel: string;
}

/* ------------------------------------------------------------------ *
 * 转换预设
 * ------------------------------------------------------------------ */

export type TargetContainer = 'mp4' | 'mkv' | 'webm' | 'gif' | 'mp3' | 'm4a' | 'copy';

export interface QualityPreset {
  id: string;
  label: string;
  /** 一句话说明，展示在 UI 上帮用户做选择 */
  description: string;
}

export interface VideoCodecOption {
  id: string;
  label: string;
  description: string;
  /** 该编码器可用的输出容器 */
  containers: TargetContainer[];
  /** 是否为硬件编码器（需运行时探测可用性） */
  hardware: boolean;
  /** 编码器不接受 CRF 而是用 -b:v 时，用码率档位控制质量 */
  usesBitrate: boolean;
}

export interface ConversionPreset {
  id: string;
  /** 分组：常用 / 压缩 / 音频 / 高级 */
  group: 'common' | 'compress' | 'audio' | 'advanced';
  label: string;
  description: string;
  container: TargetContainer;
  /** 视频编码器 id（copy 容器或纯音频预设为 null） */
  videoCodecId: string | null;
  /** 音频编码器 id（'none' 表示丢弃音轨） */
  audioCodecId: string;
  /** 默认质量档位 id */
  qualityId: string;
  /** 默认分辨率档位 id */
  resolutionId: string;
  /** 备注，展示在 UI 的提示条上 */
  tip: string | null;
}

/* ------------------------------------------------------------------ *
 * 编码器可用性探测
 * ------------------------------------------------------------------ */

export interface EncoderAvailability {
  id: string;
  label: string;
  kind: 'software' | 'nvidia' | 'intel' | 'amd';
  available: boolean;
  /** 不可用原因，如「未检测到 NVIDIA 显卡」 */
  reason: string | null;
}

export interface SystemCapabilities {
  ffmpegPath: string | null;
  ffprobePath: string | null;
  ffmpegVersion: string | null;
  /** ffmpeg 构建配置里是否含 --enable-libx264 等 */
  encoders: EncoderAvailability[];
  /** 探测时间戳 */
  probedAt: number;
  /** 二进制是否就绪；false 时 UI 显示引导 */
  ready: boolean;
  /** 整体诊断信息 */
  diagnostics: string[];
}

/* ------------------------------------------------------------------ *
 * 任务创建请求
 * ------------------------------------------------------------------ */

export interface ConversionOptions {
  presetId: string;
  videoCodecId: string;
  audioCodecId: string;
  qualityId: string;
  resolutionId: string;
  fpsId: string;
  /**
   * 目标体积上限（MB）。设了它就走**两遍编码**精确命中，
   * 此时 qualityId 不再参与码率决定（界面会自动禁用并说明原因）。
   */
  sizeLimitMb: number | null;
  /**
   * 画面比例处理：'off' 保持原样（默认）/ 'pad' 竖屏 9:16 补黑边 / 'crop' 竖屏 9:16 裁剪填满。
   *
   * 为什么要它：手机是竖屏设备，横屏视频存到手机里看着小；但**默认不能改比例**
   * （补黑边或裁掉画面都是用户看得见的损失），所以做成显式选项，默认关。
   * 尺寸计算见 `shared/output-size.ts`。
   */
  fitMode: FitMode;
  /** 播放设备 id，用于兼容性预检与参数纠偏；null = 不限定 */
  deviceId: string | null;
  /** 选中的用途 id，仅用于界面回显与提示 */
  useCaseId: string | null;
  /** 输出目录；null 表示与源文件同目录 */
  outputDir: string | null;
  /** 文件名模板，支持 {name} {preset} {date} {index} */
  fileNameTemplate: string;
  /** 覆盖已存在文件 */
  overwrite: boolean;
  /** 保留元数据（-map_metadata 0） */
  keepMetadata: boolean;
  /** 起始时间（秒），用于裁剪，null 为从头 */
  trimStartSec: number | null;
  /** 结束时间（秒），null 为到结尾 */
  trimEndSec: number | null;
  /** 保留的字幕流 index 列表（空数组表示不保留） */
  subtitleStreamIndexes: number[];
  /**
   * 要**烧进画面**的字幕流 index（全局流序号）；null = 不烧录。
   *
   * 为什么需要：勾选"保留字幕轨"只是把字幕当作可选轨道封装进去，
   * 很多播放器/设备默认不显示（尤其电视和手机），对方看到的还是没字幕。
   * 烧录（hardcode）会把字幕画进像素里，任何设备都看得到 —— 代价是必须重新编码视频、
   * 且烧上去就关不掉了。见 `shared/subtitle-burn.ts` 与 DECISIONS.md D-022。
   */
  burnSubtitleIndex: number | null;
  /**
   * 音频响度归一化（EBU R128）。
   *
   * 自媒体/课堂录音最常见的需求：不同片源音量忽大忽小，发出去对方要不停调音量。
   * 目标是 -16 LUFS / 真峰 -1.5 dBTP，符合网络投放的通行做法。
   */
  audioLoudnorm: boolean;
  /** 音量增益（dB），负数为减小；null = 不调整。范围 -30 ~ +30 */
  audioVolumeDb: number | null;
  /** 声道转换：'source' 保持 / 'mono' 单声道 / 'stereo' 立体声 */
  audioChannels: AudioChannelMode;
  /** 保留的音轨 index 列表（空数组表示使用默认音轨） */
  audioStreamIndexes: number[];
}

/** 单帧预览的结果 */
export interface PreviewFrameResult {
  filePath: string | null;
  /** 这次套用了哪些效果（人话，界面直接显示） */
  effects: string[];
  error: string | null;
}

export interface CreateJobRequest {
  sourcePath: string;
  options: ConversionOptions;
}

/**
 * 兼容性告警：在转换**之前**就告诉用户"这样转出来可能用不了"。
 *
 * 场景：用户选了 H.265 想发给老安卓电视 —— 不预检的话，用户会白等 20 分钟
 * 才发现播不了。这是最容易让人白干一场的坑，而且完全可以在开转前拦住。
 */
export interface CompatibilityIssue {
  /** 严重程度：block = 基本一定失败；warn = 可能有问题；info = 只是提醒 */
  level: 'block' | 'warn' | 'info';
  /** 一句话结论（面向用户，尽量不出现编码器黑话） */
  message: string;
  /** 可操作的建议 */
  suggestion: string | null;
  /** 一键修复：把选项改成建议值；null 表示无法自动修 */
  fix: Partial<ConversionOptions> | null;
}

export interface CreateJobResult {
  job: MediaJob | null;
  error: string | null;
}

/* ------------------------------------------------------------------ *
 * 应用设置
 * ------------------------------------------------------------------ */

export interface AppSettings {
  /** 自定义 ffmpeg 路径；null 表示使用内置二进制 */
  ffmpegPath: string | null;
  ffprobePath: string | null;
  /** 并发转换数 */
  concurrency: number;
  /** 默认输出目录；null 表示与源文件同目录 */
  defaultOutputDir: string | null;
  /** 主题 */
  theme: 'system' | 'light' | 'dark';
  /** 转换完成后系统通知 */
  notifyOnFinish: boolean;
  /** 完成后打开输出目录 */
  openFolderOnFinish: boolean;
  /**
   * 界面模式：
   *   recommended —— 推荐（默认）：只需选用途，专业参数全部隐藏
   *   custom      —— 自定义：展开全部参数，适合专业用户
   * 持久化保存，避免专业用户每次启动都要重新展开。
   */
  appMode: 'recommended' | 'custom';
}

export const DEFAULT_SETTINGS: AppSettings = {
  ffmpegPath: null,
  ffprobePath: null,
  concurrency: 2,
  defaultOutputDir: null,
  theme: 'system',
  notifyOnFinish: true,
  openFolderOnFinish: false,
  appMode: 'recommended',
};

/* ------------------------------------------------------------------ *
 * IPC 事件
 * ------------------------------------------------------------------ */

export interface IpcEvents {
  'job:updated': MediaJob;
  'job:log': { jobId: string; line: string };
  'capabilities:updated': SystemCapabilities;
}

export interface FfmpegDetectResult {
  ok: boolean;
  version: string | null;
  message: string;
  path: string | null;
}

/** 统一的 IPC 响应包装，避免异常跨进程丢失堆栈 */
export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** preload 暴露到 window.converter 的 API 面 */
export interface ConverterApi {
  /* 探测与能力 */
  probe(path: string): Promise<IpcResponse<MediaProbeResult>>;
  pickVideoFiles(): Promise<string[]>;
  pickOutputDir(): Promise<string | null>;
  /** 选择一个 .exe（用于手动指定 ffmpeg / ffprobe 路径） */
  pickExecutable(): Promise<string | null>;
  /** 清理缩略图缓存，返回释放的字节数 */
  clearThumbnailCache(): Promise<IpcResponse<number>>;
  revealInFolder(path: string): Promise<void>;
  /**
   * 取拖拽文件在磁盘上的真实路径。
   * Electron 32 起 File.path 已被移除，必须走 webUtils.getPathForFile，
   * 且只能在 drop 事件同步阶段调用（DataTransfer 之后会被回收）。
   */
  pathsForFiles(files: File[]): string[];
  thumbnail(path: string, atSec?: number): Promise<IpcResponse<ThumbnailResult>>;
  /**
   * 单帧预览：把当前参数（尺寸/画面比例/字幕烧录）套用在同一帧上，返回 PNG 路径。
   * 与正式转换读同一份尺寸/字幕规则，所以预览里看到的构图就是产物的构图；
   * 但它**不反映编码质量**（预览是无损 PNG）—— 界面文案也照这个界限写。
   */
  previewFrame(
    path: string,
    options: ConversionOptions,
    atSec: number,
  ): Promise<IpcResponse<PreviewFrameResult>>;
  getCapabilities(forceRefresh?: boolean): Promise<IpcResponse<SystemCapabilities>>;
  /** 指定目录所在磁盘的剩余字节数（开转前的磁盘空间预检用） */
  freeSpace(path: string): Promise<IpcResponse<number>>;

  /* Shell 集成（命令行文件 / 发送到 / 右键菜单） */
  /** 取走"启动时通过命令行传进来"的文件路径，取完即清空（幂等） */
  takePendingFiles(): Promise<IpcResponse<string[]>>;
  /** 查询当前是否已加入「发送到」与右键菜单 */
  getShellIntegration(): Promise<
    IpcResponse<{ sendTo: boolean; contextMenu: boolean; exePath: string; supported: boolean }>
  >;
  /** 加入 / 移除「发送到」与右键菜单（仅 HKCU，可撤销） */
  setShellIntegration(enable: boolean): Promise<IpcResponse<{ ok: boolean; message: string }>>;
  /**
   * 创建桌面快捷方式（图标指向包内 ico，并带 "%1" 以便拖放文件）。
   * 发布包里没有快捷方式，用户手动右键创建只能用 exe 内嵌图标 —— 那是 Electron 默认图标。
   */
  createDesktopShortcut(): Promise<IpcResponse<{ ok: boolean; message: string }>>;
  /** 第二个实例把文件转交给当前窗口时触发 */
  onOpenExternalFiles(cb: (paths: string[]) => void): () => void;
  detectFfmpeg(): Promise<IpcResponse<FfmpegDetectResult>>;

  /* 设置 */
  getSettings(): Promise<IpcResponse<AppSettings>>;
  saveSettings(patch: Partial<AppSettings>): Promise<IpcResponse<AppSettings>>;
  resetSettings(): Promise<IpcResponse<AppSettings>>;

  /* 任务 */
  createJobs(requests: CreateJobRequest[]): Promise<IpcResponse<CreateJobResult[]>>;
  listJobs(): Promise<IpcResponse<MediaJob[]>>;
  cancelJob(jobId: string): Promise<IpcResponse<boolean>>;
  cancelAllJobs(): Promise<IpcResponse<number>>;
  retryJob(jobId: string): Promise<IpcResponse<MediaJob | null>>;
  removeJob(jobId: string): Promise<IpcResponse<boolean>>;
  clearFinished(): Promise<IpcResponse<number>>;
  /**
   * 队列级暂停/继续：暂停后**不再启动新任务**，正在跑的继续跑完。
   *
   * 语义见 `electron/ffmpeg/convert.ts` 的 pauseQueue 注释：
   * ffmpeg 不支持断点续传，硬停一个跑一半的任务只能从头再来 —— 那叫"取消"。
   */
  pauseQueue(): Promise<IpcResponse<boolean>>;
  resumeQueue(): Promise<IpcResponse<boolean>>;
  /** 调整排队中任务的位置；运行中的任务不受影响 */
  moveJob(jobId: string, direction: 'up' | 'down' | 'top'): Promise<IpcResponse<boolean>>;
  openOutput(jobId: string): Promise<IpcResponse<boolean>>;

  /* 预设目录（静态，随应用分发） */
  getPresets(): Promise<IpcResponse<unknown>>;

  /* 窗口控制（自绘标题栏） */
  windowMinimize(): void;
  windowMaximize(): Promise<boolean>;
  windowClose(): void;

  /* 事件订阅，返回取消订阅函数 */
  onJobUpdated(cb: (job: MediaJob) => void): () => void;
  onJobLog(cb: (payload: { jobId: string; line: string }) => void): () => void;
  onCapabilitiesUpdated(cb: (caps: SystemCapabilities) => void): () => void;
}
