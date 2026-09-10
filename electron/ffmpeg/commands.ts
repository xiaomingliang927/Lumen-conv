/**
 * 命令行装配器：把 UI 上的结构化选项翻译成 ffmpeg 参数数组。
 *
 * 这是整个项目最核心的模块，也是「专家模式」展示内容的数据来源。
 *
 * 工程取舍：
 * 1) 返回 string[] 而不是拼接好的字符串 —— 避免路径含空格/中文时被 shell 拆词，
 *    同时另存一份 `commandText`（经引号转义）供 UI 展示与用户复制。
 * 2) 编码器私有参数集中在这里，UI 不需要知道 -crf / -cq / -global_quality 的差异。
 * 3) 先做兼容性校验并抛出人类可读错误，而不是让 ffmpeg 报一句
 *    "Could not find tag for codec xxx" 让用户猜。
 */
import path from 'node:path';
import type {
  ConversionOptions,
  MediaProbeResult,
  TargetContainer,
  VideoStreamInfo,
} from '../../shared/types';
import {
  CONTAINERS,
  findFps,
  findPreset,
  findQuality,
  findResolution,
  findVideoCodec,
} from '../../shared/presets';

export interface BuildContext {
  probe: MediaProbeResult;
  outputPath: string;
}

export interface BuiltCommand {
  /** 主命令参数（不含可执行文件本身） */
  args: string[];
  /** 主命令的完整可读文本，用于展示与复制 */
  commandText: string;
  /** 供 UI 提示的说明（如「已自动纠正旋转」） */
  notes: string[];
  /** 预估输出码率 kbps，用于磁盘空间预检与进度估算 */
  estimatedBitrateKbps: number;
}

export class CommandBuildError extends Error {
  constructor(
    message: string,
    readonly kind: 'unsupported-codec' | 'invalid-input',
    readonly hint: string | null,
  ) {
    super(message);
    this.name = 'CommandBuildError';
  }
}

/* ------------------------- 编码器名称映射 ------------------------- */

const VIDEO_ENCODER_NAME: Record<string, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  av1: 'libsvtav1',
  vp9: 'libvpx-vp9',
  vp8: 'libvpx',
  mpeg4: 'mpeg4',
  gif: 'gif',
  copy: 'copy',
  // 硬件编码器在 ffmpeg 里的名字与我们的 id 一致
  h264_nvenc: 'h264_nvenc',
  hevc_nvenc: 'hevc_nvenc',
  h264_qsv: 'h264_qsv',
  hevc_qsv: 'hevc_qsv',
  h264_amf: 'h264_amf',
  hevc_amf: 'hevc_amf',
};

const AUDIO_ENCODER_NAME: Record<string, string> = {
  aac: 'aac',
  mp3: 'libmp3lame',
  ac3: 'ac3',
  eac3: 'eac3',
  flac: 'flac',
  opus: 'libopus',
  vorbis: 'libvorbis',
  copy: 'copy',
  none: '',
};

/** 硬件编码器的质量参数写法不同，集中处理 */
function hardwareQualityArgs(codecId: string, quality: number): string[] {
  if (codecId.endsWith('_nvenc')) {
    // NVENC: -cq 是恒定质量模式；preset 用 p5（速度/质量平衡）
    return ['-rc', 'vbr', '-cq', String(quality), '-preset', 'p5'];
  }
  if (codecId.endsWith('_qsv')) {
    // QSV: -global_quality（配合 -look_ahead 1 提升质量）
    return ['-global_quality', String(quality), '-look_ahead', '1'];
  }
  if (codecId.endsWith('_amf')) {
    // AMF 没有等价的 CQ 参数，直接给码率，由调用方处理（见 buildVideoArgs）
    return [];
  }
  return [];
}

/** 目标分辨率下的码率缩放系数：以 1080p 为基准 */
function bitrateScaleForHeight(height: number | null): number {
  if (height === null) return 1;
  const table: Record<number, number> = {
    2160: 4,
    1440: 2,
    1080: 1,
    720: 0.55,
    480: 0.3,
    360: 0.18,
  };
  return table[height] ?? 1;
}

/** 命令行展示时的引号转义（Windows 风格），只用于显示与复制 */
export function quoteArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"'&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}

export function toCommandText(bin: string, args: string[]): string {
  return [quoteArg(bin), ...args.map(quoteArg)].join(' ');
}

/* ------------------------- 视频参数 ------------------------- */

interface VideoPlan {
  args: string[];
  notes: string[];
  estimatedBitrateKbps: number;
  /** 编码前置校验：返回错误说明，或 null 表示通过 */
  verify: string | null;
}

function buildVideoArgs(
  options: ConversionOptions,
  container: TargetContainer,
  source: VideoStreamInfo,
  quality: ReturnType<typeof findQuality>,
  resolutionHeight: number | null,
): VideoPlan {
  const codecId = options.videoCodecId;
  const encoder = VIDEO_ENCODER_NAME[codecId];
  const notes: string[] = [];

  if (!encoder) {
    throw new CommandBuildError(`不认识的视频编码器：${codecId}`, 'unsupported-codec', '请重新选择输出格式');
  }

  // 直通：不重新编码。
  // 这里提前做容器兼容性预检 —— 否则 ffmpeg 会在耗时很久之后才报
  // "Could not find tag for codec xxx"，用户白等一场。
  if (codecId === 'copy') {
    if (!isCodecAllowedInContainer(source.codec, container)) {
      return {
        args: ['-c:v', 'copy'],
        notes: [],
        estimatedBitrateKbps: 0,
        verify: `源视频是 ${source.codec.toUpperCase()} 编码，装不进 ${CONTAINERS[container].label} 容器`,
      };
    }
    return {
      args: ['-c:v', 'copy'],
      notes: ['视频流直接复制，速度最快且画质零损失'],
      estimatedBitrateKbps: source.bitrateKbps ?? 0,
      verify: null,
    };
  }

  const args: string[] = ['-c:v', encoder];

  /* ---- 缩放 / 帧率 / 旋转 ---- */
  const filters: string[] = [];

  // 旋转：源带 rotation 元数据时，播放器会自动转；但重新编码后元数据可能丢失，
  // 所以这里用 transpose 把像素真正转正，保证任何播放器方向都正确。
  if (source.rotation === 90) {
    filters.push('transpose=1');
    notes.push('已按元数据把画面转正（源视频旋转 90°）');
  } else if (source.rotation === 180) {
    filters.push('transpose=2,transpose=2');
    notes.push('已按元数据把画面转正（源视频旋转 180°）');
  } else if (source.rotation === 270) {
    filters.push('transpose=2');
    notes.push('已按元数据把画面转正（源视频旋转 270°）');
  }

  const srcHeight = source.rotation === 90 || source.rotation === 270 ? source.width : source.height;
  if (resolutionHeight !== null) {
    if (srcHeight > resolutionHeight) {
      // 只缩不放：强行放大会变糊且浪费体积
      filters.push(`scale=-2:${resolutionHeight}:flags=lanczos`);
      notes.push(`已缩放到 ${resolutionHeight}p（等比，宽度自动计算）`);
    } else if (srcHeight < resolutionHeight) {
      notes.push(`源分辨率 ${srcHeight}p 低于目标 ${resolutionHeight}p，已自动保持原分辨率（不放大）`);
    }
  }

  const fps = findFps(options.fpsId);
  if (fps.value !== null && Math.abs((source.avgFps || source.fps) - fps.value) > 0.5) {
    filters.push(`fps=${fps.value}`);
    notes.push(`帧率调整为 ${fps.value} fps`);
  }

  // HDR → 8bit 编码器时的色调映射，否则画面会发灰
  const tenBitTarget = codecId === 'hevc' || codecId === 'av1' || codecId === 'vp9';
  if (source.isHdr && !tenBitTarget) {
    filters.push(
      'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p',
    );
    notes.push('检测到 HDR 片源，已做色调映射转换到 SDR，避免转出来画面发灰');
  }

  // 像素格式：H.264/H.265 输出 yuv420p 才能被绝大多数设备播放
  const needsPixFmt = ['h264', 'hevc', 'h264_nvenc', 'hevc_nvenc', 'mpeg4'].includes(codecId);
  const pixFmt = tenBitTarget && source.bitDepth >= 10 ? 'yuv420p10le' : 'yuv420p';

  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }
  if (needsPixFmt) {
    args.push('-pix_fmt', pixFmt);
  }

  /* ---- 质量参数 ---- */
  const hwCodec = findVideoCodec(codecId)?.hardware ?? false;
  let estimatedBitrateKbps = quality.bitrateKbps * bitrateScaleForHeight(resolutionHeight);

  if (codecId === 'gif') {
    // GIF：单次调用内完成「生成调色板 → 套用调色板」两遍流程：
    //   [前置缩放/帧率滤镜],split[a][b];[a]palettegen[p];[b][p]paletteuse
    // 只启动一个 ffmpeg 进程，也不落地临时调色板文件。
    //
    // 注意（真实踩坑）：前置滤镜可能为空（源分辨率已低于目标、且未改帧率），
    // 此时若直接拼 `${prefix},split…` 会得到以逗号开头的滤镜链，
    // ffmpeg 报 "No such filter: ''" 并产出 0 字节文件。必须先滤掉空串再拼接。
    const paletteChain =
      'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3';
    const vfIndex = args.indexOf('-vf');
    if (vfIndex >= 0) {
      // 已有前置滤镜：合并进同一条 -vf
      args[vfIndex + 1] = [args[vfIndex + 1], paletteChain].filter((s) => s.length > 0).join(',');
    } else {
      args.push('-vf', paletteChain);
    }
    args.push('-an', '-loop', '0');
    return {
      args,
      notes: [...notes, 'GIF 使用调色板两遍编码，画质明显优于默认输出'],
      estimatedBitrateKbps: 0,
      verify: null,
    };
  }

  if (hwCodec) {
    const hwArgs = hardwareQualityArgs(codecId, quality.value);
    if (hwArgs.length > 0) {
      args.push(...hwArgs);
      notes.push(`使用硬件编码（${findVideoCodec(codecId)?.label ?? codecId}），速度优先`);
    } else {
      // AMF 等没有等价 CQ 的编码器，退化为码率控制
      args.push('-b:v', `${Math.round(estimatedBitrateKbps)}k`, '-quality', 'balanced');
      notes.push('该编码器不支持恒定质量模式，已改用目标码率控制');
    }
  } else if (codecId === 'h264') {
    args.push('-preset', 'medium', '-crf', String(quality.value), '-profile:v', 'high', '-level', '4.1');
  } else if (codecId === 'hevc') {
    args.push('-preset', 'medium', '-crf', String(quality.value), '-tag:v', 'hvc1');
    // hvc1 标签让 Apple 设备与 QuickTime 正常识别 HEVC
  } else if (codecId === 'av1') {
    args.push('-preset', '6', '-crf', String(quality.value));
  } else if (codecId === 'vp9') {
    args.push('-crf', String(quality.value), '-b:v', '0', '-row-mt', '1');
  } else if (codecId === 'vp8') {
    args.push('-b:v', `${Math.round(estimatedBitrateKbps)}k`);
  } else if (codecId === 'mpeg4') {
    args.push('-b:v', `${Math.round(estimatedBitrateKbps)}k`);
  } else {
    args.push('-crf', String(quality.value));
  }

  if (container === 'mp4') {
    // faststart 把索引移到文件头，网页/流媒体可直接边下边播
    args.push('-movflags', '+faststart');
  }

  return { args, notes, estimatedBitrateKbps, verify: null };
}

/* ------------------------- 音频参数 ------------------------- */

function buildAudioArgs(
  options: ConversionOptions,
  probe: MediaProbeResult,
  quality: ReturnType<typeof findQuality>,
  notes: string[],
): { args: string[]; estimatedBitrateKbps: number } {
  const codecId = options.audioCodecId;

  if (codecId === 'none' || !probe.hasAudio) {
    if (!probe.hasAudio) notes.push('源文件没有音轨，输出同样无音轨');
    return { args: ['-an'], estimatedBitrateKbps: 0 };
  }

  const encoder = AUDIO_ENCODER_NAME[codecId];
  if (encoder === undefined) {
    throw new CommandBuildError(`不认识的音频编码器：${codecId}`, 'unsupported-codec', '请重新选择音频格式');
  }

  if (encoder === 'copy') {
    return { args: ['-c:a', 'copy'], estimatedBitrateKbps: probe.audio[0]?.bitrateKbps ?? 192 };
  }

  const args = ['-c:a', encoder];
  const channels = probe.audio[0]?.channels ?? 2;

  // 声道数处理：AC3/EAC3 保留 5.1，其余下混成立体声（手机/耳机场景下更有意义）
  if (codecId === 'ac3' || codecId === 'eac3') {
    if (channels > 2) args.push('-ac', String(Math.min(channels, 6)));
  } else if (channels > 2) {
    args.push('-ac', '2');
    notes.push(`音轨从 ${channels} 声道下混为立体声`);
  }

  // 采样率：Opus 只支持 48kHz 系列
  const srcRate = probe.audio[0]?.sampleRate ?? 48000;
  if (codecId === 'opus') {
    args.push('-ar', '48000');
  } else if (srcRate && srcRate !== 48000 && srcRate !== 44100) {
    args.push('-ar', '48000');
  }

  if (codecId === 'flac') {
    // 无损不需要码率参数
    return { args, estimatedBitrateKbps: Math.round(srcRate * 16 * Math.min(channels, 2) / 1000) };
  }

  const bitrate = quality.audioBitrateKbps;
  args.push('-b:a', `${bitrate}k`);
  return { args, estimatedBitrateKbps: bitrate };
}

/* ------------------------- 流映射 ------------------------- */

function buildStreamMapping(
  probe: MediaProbeResult,
  options: ConversionOptions,
  container: string,
  videoCodecId: string | null,
  notes: string[],
): string[] {
  const args: string[] = [];
  const containerDef = CONTAINERS[container as TargetContainer];

  /* ---- 视频 ---- */
  if (videoCodecId !== null && container === 'copy') {
    // 换壳：所有流都直通
    args.push('-map', '0');
    notes.push('所有轨道（视频/音频/字幕）原样复制到新容器');
    return args;
  }

  if (videoCodecId !== null && containerDef.videoCodecs.length > 0) {
    // 选第一个非封面、非 attached_pic 的视频流，且优先选分辨率最大的
    const realVideos = probe.video.filter((v) => !v.isAttachedPic);
    if (realVideos.length === 0) {
      throw new CommandBuildError(
        '源文件里没有可用的视频轨道',
        'invalid-input',
        '请改用「导出音频」类预设',
      );
    }
    const best = realVideos.reduce((a, b) => (a.displayWidth * a.displayHeight >= b.displayWidth * b.displayHeight ? a : b));
    args.push('-map', `0:${best.index}`);
  } else {
    args.push('-vn');
  }

  /* ---- 音频 ---- */
  if (options.audioStreamIndexes.length > 0) {
    for (const idx of options.audioStreamIndexes) {
      if (probe.audio.some((a) => a.index === idx)) args.push('-map', `0:${idx}`);
    }
  } else if (probe.hasAudio && videoCodecId !== null && container !== 'mp3' && container !== 'm4a') {
    // 默认带第一条音轨（保持行为可预期：不会因为源有 8 条音轨就把输出撑大）
    const def = probe.audio.find((a) => a.isDefault) ?? probe.audio[0];
    args.push('-map', `0:${def.index}`);
  } else if (probe.hasAudio && (container === 'mp3' || container === 'm4a')) {
    const def = probe.audio.find((a) => a.isDefault) ?? probe.audio[0];
    args.push('-map', `0:${def.index}`);
  }

  /* ---- 字幕 ---- */
  if (options.subtitleStreamIndexes.length > 0 && videoCodecId !== null) {
    let added = 0;
    let skipped = 0;
    for (const idx of options.subtitleStreamIndexes) {
      const stream = probe.subtitle.find((s) => s.index === idx);
      if (!stream) continue;
      // WebM 只接受 WebVTT：图形字幕（PGS/VobSub）和 ASS 都不能直接装进去，
      // 硬装会让 ffmpeg 在最后阶段报错，不如提前剔除并告知用户。
      if (container === 'webm' && !['webvtt', 'subrip'].includes(stream.codec)) {
        skipped++;
        continue;
      }
      args.push('-map', `0:${idx}`);
      added++;
    }
    if (added > 0) {
      if (container === 'mp4') args.push('-c:s', 'mov_text');
      else if (container === 'webm') args.push('-c:s', 'webvtt');
      // MKV 什么字幕都能装，直通即可
      else args.push('-c:s', 'copy');
      notes.push(`保留 ${added} 条字幕轨道`);
    }
    if (skipped > 0) {
      notes.push(`有 ${skipped} 条图形/ASS 字幕与 WebM 不兼容，已跳过（如需保留请改用 MKV）`);
    }
  } else if (probe.hasSubtitle && options.subtitleStreamIndexes.length === 0 && videoCodecId !== null && container !== 'copy') {
    notes.push('未勾选任何字幕轨道，输出不含字幕');
  }

  return args;
}

/* ------------------------- 主入口 ------------------------- */

export function buildCommand(options: ConversionOptions, ctx: BuildContext): BuiltCommand {
  const { probe } = ctx;
  const presetContainer: TargetContainer = presetContainerOf(options.presetId);
  const container = presetContainer;
  const containerDef = CONTAINERS[container];
  const notes: string[] = [];

  /* ---- 兼容性校验 ---- */
  if (options.videoCodecId && options.videoCodecId !== 'copy') {
    if (!containerDef.videoCodecs.includes(options.videoCodecId)) {
      throw new CommandBuildError(
        `${containerDef.label} 容器不支持 ${findVideoCodec(options.videoCodecId)?.label ?? options.videoCodecId}`,
        'unsupported-codec',
        `请把输出格式改成支持该编码的容器，或换一个编码器`,
      );
    }
  }
  if (options.audioCodecId && options.audioCodecId !== 'none' && options.audioCodecId !== 'copy') {
    if (!containerDef.audioCodecs.includes(options.audioCodecId)) {
      throw new CommandBuildError(
        `${containerDef.label} 容器不支持 ${options.audioCodecId.toUpperCase()} 音频`,
        'unsupported-codec',
        '请把音频编码改成该容器支持的格式（MP4 常用 AAC，WebM 常用 Opus）',
      );
    }
  }
  // 直通模式的容器兼容性预检在 buildVideoArgs 内部完成（见 videoPlan.verify），
  // 这里无需重复判断。

  const quality = findQuality(options.qualityId);
  const resolution = findResolution(options.resolutionId);

  /* ---- 输入与裁剪 ---- */
  const args: string[] = ['-hide_banner', '-loglevel', 'info', '-nostdin', '-y'];

  // -ss 放在 -i 前：关键帧快速定位，长视频能省几十秒
  if (options.trimStartSec && options.trimStartSec > 0) {
    args.push('-ss', options.trimStartSec.toFixed(3));
    notes.push(`从 ${formatSeconds(options.trimStartSec)} 开始裁剪`);
  }
  args.push('-i', probe.path);

  if (options.trimEndSec !== null && options.trimEndSec !== undefined) {
    const start = options.trimStartSec ?? 0;
    const dur = options.trimEndSec - start;
    if (dur > 0) {
      args.push('-t', dur.toFixed(3));
      notes.push(`裁剪时长 ${formatSeconds(dur)}`);
    }
  }

  /* ---- 流映射 ---- */
  args.push(...buildStreamMapping(probe, options, container, options.videoCodecId, notes));

  /* ---- 视频编码 ---- */
  let videoPlan: VideoPlan | null = null;
  if (options.videoCodecId && container !== 'mp3' && container !== 'm4a') {
    const source = probe.video.find((v) => !v.isAttachedPic) ?? probe.video[0];
    if (!source) {
      throw new CommandBuildError('源文件没有视频轨道', 'invalid-input', '请改用「导出音频」类预设');
    }
    videoPlan = buildVideoArgs(options, container, source, quality, resolution.height);
    if (videoPlan.verify) {
      // 直通时的容器兼容性预检失败：立刻抛出人话错误，别让用户等到最后才失败
      throw new CommandBuildError(
        videoPlan.verify,
        'unsupported-codec',
        '请改用会重新编码的预设（例如「MP4 通用兼容」），或把输出格式换成 MKV',
      );
    }
    args.push(...videoPlan.args);
    notes.push(...videoPlan.notes);
  }

  /* ---- 音频编码 ---- */
  const audioPlan = buildAudioArgs(options, probe, quality, notes);
  args.push(...audioPlan.args);

  /* ---- 元数据 ---- */
  if (options.keepMetadata) {
    args.push('-map_metadata', '0');
  } else {
    args.push('-map_metadata', '-1');
  }
  args.push('-map_chapters', options.keepMetadata ? '0' : '-1');

  /* ---- 进度上报：机器可读的 key=value，走 stdout ---- */
  args.push('-progress', 'pipe:1', '-nostats');

  /* ---- 输出 ---- */
  const ext = containerDef.extension || path.extname(ctx.outputPath).replace('.', '');
  const outputPath = ctx.outputPath.endsWith(`.${ext}`) ? ctx.outputPath : `${ctx.outputPath}.${ext}`;
  args.push('-f', containerToFormat(container));
  args.push(outputPath);

  const estimatedBitrateKbps =
    (videoPlan?.estimatedBitrateKbps ?? 0) + audioPlan.estimatedBitrateKbps;

  return {
    args,
    commandText: '', // 由调用方补 bin 后填充
    notes,
    estimatedBitrateKbps,
  };
}

function containerToFormat(container: TargetContainer): string {
  switch (container) {
    case 'mp4':
      return 'mp4';
    case 'mkv':
      return 'matroska';
    case 'webm':
      return 'webm';
    case 'gif':
      return 'gif';
    case 'mp3':
      return 'mp3';
    case 'm4a':
      return 'ipod';
    case 'copy':
      return 'matroska';
    default:
      return 'mp4';
  }
}

/** 源编码能否装进目标容器（仅覆盖常见组合，够用且不会误拦） */
function isCodecAllowedInContainer(codec: string, container: TargetContainer): boolean {
  const c = codec.toLowerCase();
  switch (container) {
    case 'mp4':
      return ['h264', 'hevc', 'h265', 'mpeg4', 'av1', 'vp9', 'mjpeg', 'mpeg2video'].includes(c);
    case 'webm':
      return ['vp8', 'vp9', 'av1'].includes(c);
    case 'mkv':
      return true; // Matroska 几乎什么都能装
    default:
      return true;
  }
}

/** 由预设 id 推导容器：预设是容器的唯一来源，UI 不单独暴露容器选择，避免出现非法组合 */
function presetContainerOf(presetId: string): TargetContainer {
  const preset = findPreset(presetId);
  if (!preset) {
    throw new CommandBuildError(`未知的预设：${presetId}`, 'invalid-input', '请重新选择输出格式');
  }
  return preset.container;
}

function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}
