/**
 * 转换预设与编码器目录（主进程与渲染进程共用）。
 *
 * 设计取舍：
 * - 预设不是「写死的命令」，而是「结构化参数」，最终由 buildFfmpegArgs() 组装成命令行。
 *   这样 UI 上改一个滑杆只影响一个参数，也便于专家模式展示真实命令。
 * - 质量档位对 CRF 编码器给 CRF 值，对硬件编码器（NVENC/QSV/AMF）改给 -cq/-global_quality，
 *   因为硬件编码器普遍不支持 CRF 语义（nvENC 的 -cq 接近但不等价）。
 */

import type {
  ConversionPreset,
  VideoCodecOption,
  QualityPreset,
  TargetContainer,
} from './types';

/* ------------------------------------------------------------------ *
 * 容器
 * ------------------------------------------------------------------ */

export interface ContainerOption {
  id: TargetContainer;
  label: string;
  extension: string;
  /** 一句话说明，直接展示给用户 */
  description: string;
  /** 该容器允许的视频编码器 id */
  videoCodecs: string[];
  /** 该容器允许的音频编码器 id */
  audioCodecs: string[];
  /** 是否可以无损直通（-c copy） */
  supportsCopy: boolean;
}

export const CONTAINERS: Record<TargetContainer, ContainerOption> = {
  mp4: {
    id: 'mp4',
    label: 'MP4',
    extension: 'mp4',
    description: '兼容性最好，手机、电视、网页都能放',
    videoCodecs: ['h264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'hevc', 'hevc_nvenc', 'hevc_qsv', 'av1', 'mpeg4'],
    audioCodecs: ['aac', 'mp3', 'ac3', 'flac', 'opus', 'none'],
    supportsCopy: true,
  },
  mkv: {
    id: 'mkv',
    label: 'MKV',
    extension: 'mkv',
    description: '能装下几乎所有编码，适合收藏与多音轨',
    videoCodecs: ['h264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'hevc', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'av1', 'vp9', 'mpeg4', 'copy'],
    audioCodecs: ['aac', 'mp3', 'ac3', 'eac3', 'flac', 'opus', 'vorbis', 'copy', 'none'],
    supportsCopy: true,
  },
  webm: {
    id: 'webm',
    label: 'WebM',
    extension: 'webm',
    description: '网页优先格式，体积小，开源免专利',
    videoCodecs: ['vp9', 'vp8', 'av1', 'copy'],
    audioCodecs: ['opus', 'vorbis', 'copy', 'none'],
    supportsCopy: true,
  },
  gif: {
    id: 'gif',
    label: 'GIF',
    extension: 'gif',
    description: '动图，自动调色板生成，画质优于默认转换',
    videoCodecs: ['gif'],
    audioCodecs: ['none'],
    supportsCopy: false,
  },
  mp3: {
    id: 'mp3',
    label: 'MP3',
    extension: 'mp3',
    description: '只导出音频，最常见的音乐格式',
    videoCodecs: [],
    audioCodecs: ['mp3'],
    supportsCopy: false,
  },
  m4a: {
    id: 'm4a',
    label: 'M4A',
    extension: 'm4a',
    description: '只导出音频，AAC 编码，同码率下比 MP3 更好听',
    videoCodecs: [],
    audioCodecs: ['aac'],
    supportsCopy: false,
  },
  copy: {
    id: 'copy',
    label: '原样重封装',
    extension: '',
    description: '不重新编码，几秒完成，画质零损失（仅换容器）',
    videoCodecs: ['copy'],
    audioCodecs: ['copy'],
    supportsCopy: true,
  },
};

/* ------------------------------------------------------------------ *
 * 视频编码器
 * ------------------------------------------------------------------ */

export const VIDEO_CODECS: VideoCodecOption[] = [
  {
    id: 'h264',
    label: 'H.264 / AVC（软编码）',
    description: '兼容性最好，速度与体积均衡，任何设备都能播',
    containers: ['mp4', 'mkv'],
    hardware: false,
    usesBitrate: false,
  },
  {
    id: 'h264_nvenc',
    label: 'H.264（NVIDIA 显卡加速）',
    description: '用显卡编码，速度快 5-10 倍，体积略大',
    containers: ['mp4', 'mkv'],
    hardware: true,
    usesBitrate: true,
  },
  {
    id: 'h264_qsv',
    label: 'H.264（Intel 核显加速）',
    description: '用 Intel 核显编码，速度快，功耗低',
    containers: ['mp4', 'mkv'],
    hardware: true,
    usesBitrate: true,
  },
  {
    id: 'h264_amf',
    label: 'H.264（AMD 显卡加速）',
    description: '用 AMD 显卡编码',
    containers: ['mp4', 'mkv'],
    hardware: true,
    usesBitrate: true,
  },
  {
    id: 'hevc',
    label: 'H.265 / HEVC（软编码）',
    description: '同画质下体积比 H.264 小约 40%，编码较慢',
    containers: ['mp4', 'mkv'],
    hardware: false,
    usesBitrate: false,
  },
  {
    id: 'hevc_nvenc',
    label: 'H.265（NVIDIA 显卡加速）',
    description: 'HEVC 的体积优势 + 显卡速度',
    containers: ['mp4', 'mkv'],
    hardware: true,
    usesBitrate: true,
  },
  {
    id: 'hevc_qsv',
    label: 'H.265（Intel 核显加速）',
    description: 'HEVC 的体积优势 + Intel 核显速度',
    containers: ['mp4', 'mkv'],
    hardware: true,
    usesBitrate: true,
  },
  {
    id: 'hevc_amf',
    label: 'H.265（AMD 显卡加速）',
    description: 'HEVC 的体积优势 + AMD 显卡速度',
    containers: ['mkv'],
    hardware: true,
    usesBitrate: true,
  },
  {
    id: 'av1',
    label: 'AV1（软编码）',
    description: '最新一代编码，体积最小，但编码很慢、老设备播不动',
    containers: ['mp4', 'mkv', 'webm'],
    hardware: false,
    usesBitrate: false,
  },
  {
    id: 'vp9',
    label: 'VP9',
    description: 'WebM 常用，网页友好',
    containers: ['webm', 'mkv'],
    hardware: false,
    usesBitrate: false,
  },
  {
    id: 'vp8',
    label: 'VP8',
    description: '老版 WebM，兼容性最广的 WebM 编码',
    containers: ['webm'],
    hardware: false,
    usesBitrate: true,
  },
  {
    id: 'mpeg4',
    label: 'MPEG-4 Part 2',
    description: '老设备兼容格式，画质一般，一般无需选择',
    containers: ['mp4', 'mkv'],
    hardware: false,
    usesBitrate: true,
  },
  {
    id: 'gif',
    label: 'GIF 动图',
    description: '自动生成调色板，比 ffmpeg 默认转换画质好很多',
    containers: ['gif'],
    hardware: false,
    usesBitrate: false,
  },
  {
    id: 'copy',
    label: '不重新编码（直通）',
    description: '直接复制原始流，速度极快、画质零损失，但只支持换容器',
    containers: ['mp4', 'mkv', 'webm', 'copy'],
    hardware: false,
    usesBitrate: false,
  },
];

/* ------------------------------------------------------------------ *
 * 音频编码器
 * ------------------------------------------------------------------ */

export const AUDIO_CODECS: { id: string; label: string; description: string }[] = [
  { id: 'aac', label: 'AAC', description: 'MP4 标准音频，兼容性最好' },
  { id: 'mp3', label: 'MP3', description: '最通用的音频格式' },
  { id: 'ac3', label: 'AC-3', description: '家庭影院常用，5.1 声道友好' },
  { id: 'eac3', label: 'E-AC-3', description: 'AC-3 增强版，高码率多声道' },
  { id: 'flac', label: 'FLAC（无损）', description: '完全无损，体积较大' },
  { id: 'opus', label: 'Opus', description: '同码率音质最好，WebM 标配' },
  { id: 'vorbis', label: 'Vorbis', description: 'WebM 常用开源音频' },
  { id: 'copy', label: '不重新编码（直通）', description: '复制原始音轨' },
  { id: 'none', label: '不要音轨', description: '输出无声视频' },
];

/* ------------------------------------------------------------------ *
 * 质量档位
 * ------------------------------------------------------------------ */

export const QUALITY_PRESETS: (QualityPreset & {
  /** CRF（软编码）/ CQ（硬件编码）取值 */
  value: number;
  /** usesBitrate 编码器使用的目标码率 kbps（按 1080p 基准，会随分辨率缩放） */
  bitrateKbps: number;
  /** 音频码率 kbps */
  audioBitrateKbps: number;
})[] = [
  {
    id: 'lossless-archive',
    label: '存档级',
    description: '几乎看不出损失，文件最大，适合收藏母带',
    value: 16,
    bitrateKbps: 16000,
    audioBitrateKbps: 320,
  },
  {
    id: 'high',
    label: '高画质',
    description: '画质优先，体积约为原片 60%-90%',
    value: 20,
    bitrateKbps: 8000,
    audioBitrateKbps: 256,
  },
  {
    id: 'balanced',
    label: '均衡（推荐）',
    description: '画质与体积的平衡点，日常使用首选',
    value: 23,
    bitrateKbps: 5000,
    audioBitrateKbps: 192,
  },
  {
    id: 'small',
    label: '小体积',
    description: '明显压缩，适合微信/邮件发送',
    value: 28,
    bitrateKbps: 2500,
    audioBitrateKbps: 128,
  },
  {
    id: 'tiny',
    label: '极小体积',
    description: '画质损失可见，仅用于极限压缩场景',
    value: 34,
    bitrateKbps: 1200,
    audioBitrateKbps: 96,
  },
];

/* ------------------------------------------------------------------ *
 * 分辨率 / 帧率档位
 * ------------------------------------------------------------------ */

export const RESOLUTION_PRESETS: {
  id: string;
  label: string;
  /** 目标高度；null 表示保持原分辨率 */
  height: number | null;
  /** 一句话说明 */
  description: string;
}[] = [
  { id: 'source', label: '保持原分辨率', height: null, description: '不缩放，画质无损' },
  { id: '2160p', label: '4K (2160p)', height: 2160, description: '3840×2160' },
  { id: '1440p', label: '2K (1440p)', height: 1440, description: '2560×1440' },
  { id: '1080p', label: '1080p 全高清', height: 1080, description: '1920×1080' },
  { id: '720p', label: '720p 高清', height: 720, description: '1280×720' },
  { id: '480p', label: '480p 标清', height: 480, description: '854×480' },
  { id: '360p', label: '360p 小窗', height: 360, description: '640×360' },
];

export const FPS_PRESETS: { id: string; label: string; value: number | null; description: string }[] = [
  { id: 'source', label: '保持原帧率', value: null, description: '不改变帧率' },
  { id: '60', label: '60 fps', value: 60, description: '高帧率，适合游戏录像' },
  { id: '30', label: '30 fps', value: 30, description: '通用帧率' },
  { id: '24', label: '24 fps', value: 24, description: '电影感' },
  { id: '15', label: '15 fps', value: 15, description: '大幅减小体积，画面略卡' },
];

/* ------------------------------------------------------------------ *
 * 转换预设
 * ------------------------------------------------------------------ */

export const CONVERSION_PRESETS: ConversionPreset[] = [
  {
    id: 'mp4-compatible',
    group: 'common',
    label: 'MP4 通用兼容',
    description: '转成 MP4（H.264 + AAC），手机、电视、剪辑软件都能识别',
    container: 'mp4',
    videoCodecId: 'h264',
    audioCodecId: 'aac',
    qualityId: 'balanced',
    resolutionId: 'source',
    tip: '最稳的选择，遇到「设备不支持」时优先用它',
  },
  {
    id: 'mp4-1080p',
    group: 'common',
    label: 'MP4 1080p 压缩',
    description: '压到 1080p，体积明显变小，适合发送与归档',
    container: 'mp4',
    videoCodecId: 'h264',
    audioCodecId: 'aac',
    qualityId: 'small',
    resolutionId: '1080p',
    tip: '源分辨率低于 1080p 时不会放大，只会保持原样',
  },
  {
    id: 'mp4-hevc',
    group: 'compress',
    label: 'H.265 小体积（MP4）',
    description: 'HEVC 编码，同画质体积约为 H.264 的 60%',
    container: 'mp4',
    videoCodecId: 'hevc',
    audioCodecId: 'aac',
    qualityId: 'balanced',
    resolutionId: 'source',
    tip: '部分老设备（如旧安卓电视）可能不支持 H.265',
  },
  {
    id: 'webm-web',
    group: 'common',
    label: 'WebM 网页视频',
    description: 'VP9 + Opus，网页嵌入友好，体积小',
    container: 'webm',
    videoCodecId: 'vp9',
    audioCodecId: 'opus',
    qualityId: 'balanced',
    resolutionId: 'source',
    tip: '编码速度较慢，长视频请耐心等待',
  },
  {
    id: 'mkv-archive',
    group: 'advanced',
    label: 'MKV 收藏（多音轨 + 字幕）',
    description: 'MKV 容器，保留所有音轨与字幕，适合影片归档',
    container: 'mkv',
    videoCodecId: 'h264',
    audioCodecId: 'copy',
    qualityId: 'high',
    resolutionId: 'source',
    tip: '音轨与字幕直通，不重新编码',
  },
  {
    id: 'remux-copy',
    group: 'advanced',
    label: '极速换壳（不重编码）',
    description: '只更换容器格式，几秒完成，画质与原片完全一致',
    container: 'mp4',
    videoCodecId: 'copy',
    audioCodecId: 'copy',
    qualityId: 'high',
    resolutionId: 'source',
    tip: '源编码与目标容器不兼容时会自动失败并提示，此时请改用其他预设',
  },
  {
    id: 'audio-mp3',
    group: 'audio',
    label: '导出 MP3 音频',
    description: '只保留声音，转成通用 MP3',
    container: 'mp3',
    videoCodecId: null,
    audioCodecId: 'mp3',
    qualityId: 'high',
    resolutionId: 'source',
    tip: '常用于从 MV / 讲座视频里提取音频',
  },
  {
    id: 'audio-m4a',
    group: 'audio',
    label: '导出 M4A 音频',
    description: 'AAC 编码，同码率下音质优于 MP3',
    container: 'm4a',
    videoCodecId: null,
    audioCodecId: 'aac',
    qualityId: 'high',
    resolutionId: 'source',
    tip: null,
  },
  {
    id: 'gif-motion',
    group: 'advanced',
    label: 'GIF 动图',
    description: '生成动图，自动调色板，画质优于 ffmpeg 默认输出',
    container: 'gif',
    videoCodecId: 'gif',
    audioCodecId: 'none',
    qualityId: 'balanced',
    resolutionId: '480p',
    tip: '建议先用「裁剪」截取 3-6 秒片段，否则生成的文件会非常大',
  },
];

export function findPreset(id: string): ConversionPreset | undefined {
  return CONVERSION_PRESETS.find((p) => p.id === id);
}

export function findQuality(id: string) {
  return QUALITY_PRESETS.find((q) => q.id === id) ?? QUALITY_PRESETS[2];
}

export function findResolution(id: string) {
  return RESOLUTION_PRESETS.find((r) => r.id === id) ?? RESOLUTION_PRESETS[0];
}

export function findFps(id: string) {
  return FPS_PRESETS.find((f) => f.id === id) ?? FPS_PRESETS[0];
}

export function findVideoCodec(id: string): VideoCodecOption | undefined {
  return VIDEO_CODECS.find((c) => c.id === id);
}
