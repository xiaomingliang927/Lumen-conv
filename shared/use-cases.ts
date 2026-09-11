/**
 * 「用途」与「播放设备」两层语义（主进程与渲染进程共用）。
 *
 * 为什么要加这两层：
 *   用户不关心编码器。用户脑子里想的是「我要发微信」「我要在电视上放」
 *   「我要拿去剪视频」。原来的界面直接问"你要 MP4 还是 MKV"，
 *   等于把技术决策推给了用户 —— 而选错的代价（发不出去 / 播不了 / 白等一场）
 *   全部由用户承担。
 *
 * 分层设计：
 *   用途（UseCase）  → 决定「转成什么样」：容器 / 编码器 / 分辨率上限 / 体积上限
 *   设备（Device）    → 决定「能不能播」：给兼容性预检提供判据，并可一键纠偏
 *
 * 两者独立：同一份"发微信"的产物，发给不同的电视可能依然放不了。
 */

import type { ConversionOptions } from './types';

/* ------------------------------------------------------------------ *
 * 用途
 * ------------------------------------------------------------------ */

export interface UseCase {
  id: string;
  /** 卡片主标题，用用户的原话 */
  label: string;
  /** 一句话说明"什么时候用它" */
  description: string;
  /** 默认落到哪个预设（决定容器与基础编码器） */
  presetId: string;
  /** 默认目标体积上限（MB）；null = 不限制 */
  sizeLimitMb: number | null;
  /**
   * 分辨率上限（高度）。null = 不限制。
   * 注意是"上限"：源比它低时不会放大。
   */
  resolutionId: string;
  /** 默认质量档位 */
  qualityId: string;
  /** 是否需要提示（展示在卡片下方） */
  tip: string | null;
  /**
   * 该用途下的固定约束：不满足时给出提醒。
   * 例如"发微信"必须 H.264 —— 因为微信在部分机型上确实放不了 HEVC。
   */
  requiresCodec: string | null;
}

export const USE_CASES: UseCase[] = [
  {
    id: 'wechat',
    label: '发微信 / QQ',
    description: '按平台友好的规格压到指定体积，保证发得出去、对方点得开',
    presetId: 'mp4-compatible',
    // 微信单文件上限 1GB，但实际聊天里几百 MB 就很勉强；
    // 100MB 是"几乎一定能发出去"的经验值
    sizeLimitMb: 100,
    resolutionId: '1080p',
    qualityId: 'balanced',
    tip: '微信在部分机型上放不了 H.265，所以这里固定用兼容性最好的 H.264',
    requiresCodec: 'h264',
  },
  {
    id: 'phone',
    label: '手机存着看',
    description: '明显减小体积，画质仍够手机屏幕看，适合清手机空间',
    presetId: 'mp4-1080p',
    sizeLimitMb: null,
    resolutionId: '1080p',
    qualityId: 'small',
    tip: '按手机屏幕尺寸，1080p 已经看不出和原片的差别',
    requiresCodec: null,
  },
  {
    id: 'edit',
    label: '拿去剪视频',
    description: '保持高画质与流畅剪辑，只换容器方便导入剪辑软件',
    presetId: 'mp4-compatible',
    sizeLimitMb: null,
    resolutionId: 'source',
    qualityId: 'high',
    tip: '剪辑软件通常不吃 H.265 与 MKV，这里统一转成 H.264 的 MP4',
    requiresCodec: 'h264',
  },
  {
    id: 'tv',
    label: '老电视 / 车载 U 盘',
    description: '按最保守的规格转，老设备与车机也能直接播',
    presetId: 'mp4-compatible',
    sizeLimitMb: null,
    resolutionId: '1080p',
    qualityId: 'balanced',
    tip: '老设备解码能力弱：固定 H.264 + AAC，并避免 HDR 与高帧率',
    requiresCodec: 'h264',
  },
  {
    id: 'archive',
    label: '长期存档',
    description: '同画质下体积最小，画质保留最多，适合存起来以后再看',
    presetId: 'mp4-hevc',
    sizeLimitMb: null,
    resolutionId: 'source',
    qualityId: 'high',
    tip: 'H.265 比 H.264 省约 40% 体积，但老设备可能播不了',
    requiresCodec: null,
  },
  {
    id: 'audio',
    label: '只要声音',
    description: '把视频里的音轨抽出来，转成通用音频文件',
    presetId: 'audio-mp3',
    sizeLimitMb: null,
    resolutionId: 'source',
    qualityId: 'high',
    tip: null,
    requiresCodec: null,
  },
  {
    id: 'gif',
    label: '做 GIF 动图',
    description: '生成动图；建议先用「裁剪」截几秒，否则文件会很大',
    presetId: 'gif-motion',
    sizeLimitMb: null,
    resolutionId: '480p',
    qualityId: 'balanced',
    tip: 'GIF 不适合长片段：建议先裁剪到 3-6 秒',
    requiresCodec: null,
  },
  {
    id: 'remux',
    label: '只换容器（极速）',
    description: '不重新编码，几秒完成，画质零损失，只改封装格式',
    presetId: 'remux-copy',
    sizeLimitMb: null,
    resolutionId: 'source',
    qualityId: 'high',
    tip: '源编码装不进目标容器时会失败，届时请改用其它用途',
    requiresCodec: null,
  },
];

export function findUseCase(id: string | null): UseCase | undefined {
  if (!id) return undefined;
  return USE_CASES.find((u) => u.id === id);
}

/** 把用途套用到选项上（返回新的选项对象） */
export function applyUseCase(
  base: ConversionOptions,
  useCaseId: string,
  preset: { id: string; videoCodecId: string | null; audioCodecId: string },
): ConversionOptions {
  const uc = findUseCase(useCaseId);
  if (!uc) return { ...base, useCaseId: null };
  const videoCodecId = uc.requiresCodec ?? preset.videoCodecId ?? 'none';
  return {
    ...base,
    useCaseId: uc.id,
    presetId: preset.id,
    videoCodecId,
    audioCodecId: preset.audioCodecId,
    qualityId: uc.qualityId,
    resolutionId: uc.resolutionId,
    sizeLimitMb: uc.sizeLimitMb,
    subtitleStreamIndexes: [],
    audioStreamIndexes: [],
  };
}

/* ------------------------------------------------------------------ *
 * 播放设备
 * ------------------------------------------------------------------ */

export interface Device {
  id: string;
  label: string;
  /** 该设备接受的视频编码（ffmpeg 编码器 id 的"家族"） */
  videoCodecs: string[];
  /** 接受的音频编码 */
  audioCodecs: string[];
  /** 是否支持 HDR 播放 */
  supportsHdr: boolean;
  /** 是否支持 10bit */
  supports10Bit: boolean;
  /** 说明，展示给用户 */
  note: string;
}

export const DEVICES: Device[] = [
  {
    id: 'any',
    label: '不限定 / 不确定',
    videoCodecs: [],
    audioCodecs: [],
    supportsHdr: true,
    supports10Bit: true,
    note: '不做兼容性检查',
  },
  {
    id: 'android-old',
    label: '老安卓电视 / 车机',
    videoCodecs: ['h264', 'mpeg4', 'mpeg2video'],
    audioCodecs: ['aac', 'mp3', 'ac3'],
    supportsHdr: false,
    supports10Bit: false,
    note: '这类设备解码能力弱，通常不接受 H.265、AV1、VP9，也不支持 HDR',
  },
  {
    id: 'modern-tv',
    label: '较新的智能电视',
    videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
    audioCodecs: ['aac', 'ac3', 'eac3', 'opus', 'mp3'],
    supportsHdr: true,
    supports10Bit: true,
    note: '近几年的智能电视一般支持 H.265 与 HDR',
  },
  {
    id: 'apple',
    label: 'iPhone / iPad / Mac',
    videoCodecs: ['h264', 'hevc'],
    audioCodecs: ['aac', 'mp3', 'ac3', 'eac3', 'flac'],
    supportsHdr: true,
    supports10Bit: true,
    note: '苹果设备对 H.265 支持良好，但 VP9 / AV1 在老旧机型上可能不行',
  },
  {
    id: 'android-phone',
    label: '安卓手机',
    videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
    audioCodecs: ['aac', 'mp3', 'opus', 'flac', 'ac3'],
    supportsHdr: true,
    supports10Bit: true,
    note: '近几年安卓机基本都能放 H.265',
  },
  {
    id: 'windows',
    label: 'Windows 电脑',
    videoCodecs: ['h264', 'hevc', 'vp9', 'av1', 'mpeg4', 'mpeg2video'],
    audioCodecs: ['aac', 'mp3', 'ac3', 'eac3', 'flac', 'opus', 'vorbis'],
    supportsHdr: true,
    supports10Bit: true,
    note: 'H.265 需要装「HEVC 视频扩展」；如果对方电脑没装，建议用 H.264',
  },
  {
    id: 'editor',
    label: '剪辑软件（Pr / 达芬奇）',
    videoCodecs: ['h264', 'hevc', 'prores'],
    audioCodecs: ['aac', 'pcm_s16le', 'pcm_s24le', 'mp3'],
    supportsHdr: true,
    supports10Bit: true,
    note: '剪辑软件对 H.265 与 MKV 的支持较差，建议 H.264 的 MP4',
  },
];

export function findDevice(id: string | null): Device | undefined {
  if (!id) return undefined;
  return DEVICES.find((d) => d.id === id);
}

/** 把 ffmpeg 编码器 id 归一成"家族"（h264_nvenc → h264） */
export function codecFamily(codecId: string): string {
  if (!codecId) return '';
  const base = codecId.replace(/_(nvenc|qsv|amf|videotoolbox|vaapi)$/, '');
  return base === 'copy' ? 'copy' : base;
}
