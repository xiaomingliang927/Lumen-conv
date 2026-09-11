/**
 * 转换前兼容性预检。
 *
 * 目标：让用户在**点下按钮之前**就知道"这样转出来可能用不了"，
 * 而不是白等二十分钟才发现播不了。
 *
 * 检查分三级：
 *   block —— 基本一定失败（例如源编码装不进目标容器），必须处理
 *   warn  —— 可能有问题（例如给老电视转 H.265），给建议
 *   info  —— 只是提醒（例如 HDR 会被转成 SDR），不需要处理
 *
 * 每个问题都尽量给出 **fix**（可直接套用的选项补丁），让用户一键修好，
 * 而不是自己回去改一堆下拉框。
 */

import type {
  CompatibilityIssue,
  ConversionOptions,
  MediaProbeResult,
} from './types';
import { CONTAINERS } from './presets';
import { codecFamily, findDevice } from './use-cases';

export interface CheckContext {
  probe: MediaProbeResult;
  options: ConversionOptions;
  /** 分辨率档位 → 目标高度（null 表示保持原样） */
  targetHeight: number | null;
  /** 音轨码率（kbps），用于体积核算 */
  audioBitrateKbps: number;
}

/** 音频编码器的可读名，用于提示文案 */
const AUDIO_LABEL: Record<string, string> = {
  aac: 'AAC',
  mp3: 'MP3',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  flac: 'FLAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  copy: '原音轨',
  none: '无音频',
};

const VIDEO_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'H.265',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg4: 'MPEG-4',
  gif: 'GIF',
  copy: '原视频',
};

function videoLabel(codecId: string): string {
  const fam = codecFamily(codecId);
  return VIDEO_LABEL[fam] ?? fam.toUpperCase();
}

/**
 * 主检查函数。返回按严重程度排序的问题列表（越严重越靠前）。
 * 空数组 = 可以放心转。
 */
export function checkCompatibility(ctx: CheckContext): CompatibilityIssue[] {
  const { probe, options } = ctx;
  const issues: CompatibilityIssue[] = [];
  const device = findDevice(options.deviceId);
  const containerDef = CONTAINERS[options.presetId ? containerOf(options.presetId) : 'mp4'];

  const vCodec = options.videoCodecId;
  const aCodec = options.audioCodecId;
  const vFamily = codecFamily(vCodec);
  const aFamily = codecFamily(aCodec);
  const isAudioOnly = containerDef.videoCodecs.length === 0;
  const isRemux = vFamily === 'copy';

  /* ---------- 1. 设备维度 ---------- */

  if (device && device.id !== 'any') {
    if (!isAudioOnly && vCodec && vFamily !== 'copy' && !device.videoCodecs.includes(vFamily)) {
      // 给一个"最接近的可用编码"作为一键修复
      const better = device.videoCodecs.includes('h264') ? 'h264' : device.videoCodecs[0];
      issues.push({
        level: 'warn',
        message: `${device.label} 通常播不了 ${videoLabel(vCodec)}`,
        suggestion: `建议改用 ${videoLabel(better)}。${device.note}`,
        fix: better ? { videoCodecId: better } : null,
      });
    }

    if (probe.hasAudio && aCodec !== 'none' && aFamily !== 'copy' && !device.audioCodecs.includes(aFamily)) {
      issues.push({
        level: 'warn',
        message: `${device.label} 可能不支持 ${AUDIO_LABEL[aFamily] ?? aFamily} 音频`,
        suggestion: '建议改用 AAC（兼容性最好）',
        fix: { audioCodecId: 'aac' },
      });
    }

    if (probe.video.some((v) => v.isHdr) && !device.supportsHdr) {
      issues.push({
        level: 'info',
        message: '源视频是 HDR，而该设备不支持 HDR',
        suggestion: '转换时会自动做色调映射转成普通画面（颜色会与 HDR 原片略有差别）',
        fix: null,
      });
    }

    if (probe.video.some((v) => v.bitDepth >= 10) && !device.supports10Bit) {
      issues.push({
        level: 'info',
        message: '源视频是 10bit 色彩，该设备可能只支持 8bit',
        suggestion: '转换时会输出 8bit 色彩（肉眼几乎看不出差别）',
        fix: null,
      });
    }
  }

  /* ---------- 2. 换壳（直通）可行性 ---------- */

  if (isRemux) {
    const srcVideo = probe.video.find((v) => !v.isAttachedPic);
    if (srcVideo && !isCodecAllowed(srcVideo.codec, containerDef.id)) {
      issues.push({
        level: 'block',
        message: `源视频是 ${srcVideo.codec.toUpperCase()}，装不进 ${containerDef.label} 容器`,
        suggestion: '改用会重新编码的用途（例如「发微信 / QQ」），或把输出换成 MKV',
        fix: { videoCodecId: 'h264' },
      });
    } else if (srcVideo) {
      issues.push({
        level: 'info',
        message: '这是「只换容器」模式：不重新编码，几秒完成且画质零损失',
        suggestion: `但输出体积与原片基本一致${
          options.sizeLimitMb ? '，无法压到目标体积' : ''
        }。想变小请改用其它用途`,
        fix: null,
      });
    }
  }

  /* ---------- 3. 体积上限可行性 ---------- */

  if (options.sizeLimitMb && options.sizeLimitMb > 0 && probe.durationSec > 0) {
    const totalKbps = (options.sizeLimitMb * 8 * 1024) / probe.durationSec;
    const audioKbps = aCodec === 'none' ? 0 : ctx.audioBitrateKbps;

    if (isRemux) {
      // 直通模式下没法压体积，上面的 info 已经说过了
    } else if (totalKbps <= audioKbps + 50) {
      issues.push({
        level: 'block',
        message: `目标 ${options.sizeLimitMb} MB 对这段 ${fmtDur(probe.durationSec)} 的视频来说太小了`,
        suggestion:
          audioKbps > 0
            ? `光是保留音频就要占掉约 ${Math.round(audioKbps / 8 * probe.durationSec / 1024)} MB。请把目标调大，或改成「只要声音」`
            : '请把目标体积调大',
        fix: null,
      });
    } else {
      const videoKbps = totalKbps - audioKbps;
      // 经验值：H.264 在 1080p 下低于约 1200kbps 就会出现可见块状
      const perPixel = videoKbps / Math.max(1, (ctx.targetHeight ?? srcHeight(probe)) * 1.78);
      if (perPixel < 0.55) {
        const suggestedHeight = Math.max(360, Math.round(Math.sqrt((videoKbps * 1000) / 0.9 / 1.78 / 1.78 / 1)));
        issues.push({
          level: 'warn',
          message: `这个体积下码率只有约 ${Math.round(videoKbps)} kbps，画质会明显下降`,
          suggestion: `想兼顾体积与观感，建议同时把分辨率降到 ${
            suggestedHeight >= 720 ? '720p' : '480p'
          }（码率不足时降分辨率比硬压更耐看）`,
          fix: suggestedHeight >= 720 ? { resolutionId: '720p' } : { resolutionId: '480p' },
        });
      } else {
        issues.push({
          level: 'info',
          message: `已按目标体积反推码率：约 ${Math.round(videoKbps)} kbps 视频 + ${audioKbps} kbps 音频`,
          suggestion: '会用两遍编码精确命中，耗时约为普通转换的两倍',
          fix: null,
        });
      }
    }
  }

  /* ---------- 4. 画质档位与容器/编码器的常规校验（与主进程侧一致，提前提示） ---------- */

  if (!isAudioOnly && vCodec && vFamily !== 'copy' && !containerDef.videoCodecs.includes(vCodec)) {
    issues.push({
      level: 'block',
      message: `${containerDef.label} 容器不支持 ${videoLabel(vCodec)}`,
      suggestion: '请在「专业参数」里换一个编码器，或改回推荐用途',
      fix: { videoCodecId: 'h264' },
    });
  }

  if (probe.hasAudio && aCodec !== 'none' && aFamily !== 'copy' && !containerDef.audioCodecs.includes(aCodec)) {
    issues.push({
      level: 'block',
      message: `${containerDef.label} 容器不支持 ${AUDIO_LABEL[aFamily] ?? aFamily} 音频`,
      suggestion: '建议改用 AAC',
      fix: { audioCodecId: 'aac' },
    });
  }

  const order: Record<CompatibilityIssue['level'], number> = { block: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}

/* ------------------------------ 工具 ------------------------------ */

function srcHeight(probe: MediaProbeResult): number {
  const v = probe.video.find((x) => !x.isAttachedPic);
  if (!v) return 1080;
  return v.rotation === 90 || v.rotation === 270 ? v.width : v.height;
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/** 由预设 id 取容器（与 commands.ts 的 presetContainerOf 同源，这里做一份只读映射避免循环依赖） */
function containerOf(presetId: string): keyof typeof CONTAINERS {
  // 直接查 CONVERSION_PRESETS 会引入 presets.ts 的完整依赖；
  // 这里用一个轻量前缀映射即可，两者不一致时 checkCompatibility 会退化为"不检查"而非误报
  const map: Record<string, keyof typeof CONTAINERS> = {
    'mp4-compatible': 'mp4',
    'mp4-1080p': 'mp4',
    'mp4-hevc': 'mp4',
    'webm-web': 'webm',
    'mkv-archive': 'mkv',
    'remux-copy': 'mp4',
    'audio-mp3': 'mp3',
    'audio-m4a': 'm4a',
    'gif-motion': 'gif',
  };
  return map[presetId] ?? 'mp4';
}

function isCodecAllowed(codec: string, container: string): boolean {
  const c = codec.toLowerCase();
  switch (container) {
    case 'mp4':
      return ['h264', 'hevc', 'h265', 'mpeg4', 'av1', 'vp9', 'mjpeg', 'mpeg2video'].includes(c);
    case 'webm':
      return ['vp8', 'vp9', 'av1'].includes(c);
    default:
      return true;
  }
}
