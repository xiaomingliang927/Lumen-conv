/**
 * ffprobe 封装：把 JSON 探测结果转成 UI 友好的结构化数据。
 *
 * 工程取舍：
 * - 只透传「人类看得懂」的字段，原始 JSON 不往渲染进程扔，避免 UI 层做格式判断。
 * - 用 -show_format -show_streams -show_chapters 一次拿到全部信息，减少进程启动次数
 *   （Windows 上 ffprobe 冷启动约 100-200ms，省一次就是省一次）。
 * - 损坏文件要让 ffprobe 尽量吐信息而不是直接失败，所以不加 -v error，
 *   而是用 -v quiet 之外的最小日志级别，并在解析失败时给出人类可读原因。
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type {
  AudioStreamInfo,
  ChapterInfo,
  MediaProbeResult,
  SubtitleStreamInfo,
  VideoStreamInfo,
} from '../../shared/types';
import { exec } from './process';

const PROBE_TIMEOUT_MS = 30_000;

export class ProbeError extends Error {
  constructor(
    message: string,
    readonly kind: 'ffprobe-missing' | 'invalid-input' | 'permission' | 'unknown',
    readonly rawLog: string,
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

/* --------------------------- 原始 JSON 的最小类型 --------------------------- */

interface RawStream {
  index: number;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  coded_width?: number;
  coded_height?: number;
  sample_aspect_ratio?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  duration?: string;
  color_transfer?: string;
  color_primaries?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

interface RawChapter {
  id?: number;
  start_time?: string;
  end_time?: string;
  tags?: Record<string, string>;
}

interface RawProbe {
  streams?: RawStream[];
  chapters?: RawChapter[];
  format?: {
    filename?: string;
    format_name?: string;
    format_long_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

/* ------------------------------ 小工具函数 ------------------------------ */

/** 把 "30000/1001" 这类分数解析成数字，失败返回 0 */
function parseFraction(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/** 容器名 → 人类可读短名 */
function prettyFormatName(raw: string | undefined, ext: string): string {
  if (!raw) return ext.toUpperCase();
  const parts = raw.split(',');
  // 注意：ffprobe 对 WebM 返回的是 "matroska,webm"（WebM 本就是 Matroska 的子集），
  // 直接取第一段会把 WebM 显示成 Matroska，所以这里做一次优先级挑选。
  const priority = ['webm', 'matroska', 'mov', 'mpegts', 'flv', 'ogg', 'asf', 'gif', 'image2'];
  const first =
    priority.find((p) => parts.includes(p)) ?? parts[0];
  const map: Record<string, string> = {
    mov: 'MP4 / QuickTime',
    matroska: 'Matroska (MKV)',
    webm: 'WebM',
    avi: 'AVI',
    mpegts: 'MPEG-TS',
    flv: 'FLV',
    gif: 'GIF',
    mp3: 'MP3',
    wav: 'WAV',
    flac: 'FLAC',
    ogg: 'Ogg',
    asf: 'WMV / ASF',
    '3gp': '3GP',
    mxf: 'MXF',
    image2: '图片序列',
  };
  return map[first] ?? raw;
}

/** 文字型字幕编码：可以直接转成 srt/ass 软字幕 */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
  'eia_608',
  'hdmv_text_subtitle',
]);

/** HDR 判定：PQ / HLG 传输特性，或 10bit 以上 BT.2020 */
function isHdrStream(s: RawStream): boolean {
  const transfer = s.color_transfer?.toLowerCase();
  if (transfer === 'smpte2084' || transfer === 'arib-std-b67') return true;
  const primaries = s.color_primaries?.toLowerCase();
  const depth = Number(s.bits_per_raw_sample ?? 0);
  if (primaries === 'bt2020' && depth >= 10) return true;
  return false;
}

/** 从流里取旋转角度（新版 ffprobe 放在 side_data_list，老版本放在 tags.rotate） */
function readRotation(s: RawStream): number {
  const side = s.side_data_list?.find((d) => typeof d.rotation === 'number');
  if (side && typeof side.rotation === 'number') {
    return ((Math.round(side.rotation) % 360) + 360) % 360;
  }
  const tag = s.tags?.rotate ?? s.tags?.ROTATE;
  if (tag && !Number.isNaN(Number(tag))) {
    return ((Math.round(Number(tag)) % 360) + 360) % 360;
  }
  return 0;
}

/**
 * 展示尺寸：把 sample_aspect_ratio（非方形像素，常见于 DVD / 老手机视频）
 * 和旋转角都算进去，否则 UI 上会显示成压扁的比例。
 */
function displaySize(
  width: number,
  height: number,
  sar: string | undefined,
  rotation: number,
): { w: number; h: number } {
  let w = width;
  let h = height;
  if (sar) {
    const [sn, sd] = sar.split(':').map(Number);
    if (Number.isFinite(sn) && Number.isFinite(sd) && sn > 0 && sd > 0 && sn !== sd) {
      w = Math.round((width * sn) / sd);
    }
  }
  if (rotation === 90 || rotation === 270) [w, h] = [h, w];
  return { w, h };
}

/* ------------------------------ 主流程 ------------------------------ */

export interface ProbeContext {
  ffprobePath: string;
}

export async function probeMedia(filePath: string, ctx: ProbeContext): Promise<MediaProbeResult> {
  let sizeBytes = 0;
  try {
    const st = statSync(filePath);
    if (st.isDirectory()) {
      throw new ProbeError('这是一个文件夹，不是视频文件', 'invalid-input', '');
    }
    sizeBytes = st.size;
  } catch (err) {
    if (err instanceof ProbeError) throw err;
    throw new ProbeError(
      `读取文件失败：${(err as Error).message}`,
      'permission',
      String((err as Error).message),
    );
  }

  if (sizeBytes === 0) {
    throw new ProbeError('文件大小为 0 字节，可能下载未完成或已损坏', 'invalid-input', '');
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-i',
    filePath,
  ];

  const result = await exec(ctx.ffprobePath, args, { timeoutMs: PROBE_TIMEOUT_MS });

  if (result.spawnError) {
    throw new ProbeError(
      `无法启动 ffprobe：${result.spawnError}`,
      'ffprobe-missing',
      result.spawnError,
    );
  }
  if (result.timedOut) {
    throw new ProbeError('探测超时（文件可能损坏或位于无响应的网络位置）', 'invalid-input', result.stderr);
  }

  let raw: RawProbe;
  try {
    raw = JSON.parse(result.stdout) as RawProbe;
  } catch {
    // ffprobe 在完全无法识别时可能不输出 JSON
    const tail = result.stderr.trim().split(/\r?\n/).slice(-3).join(' / ');
    throw new ProbeError(
      `不是可识别的音视频文件${tail ? `（${tail}）` : ''}`,
      'invalid-input',
      result.stderr,
    );
  }

  const streams = raw.streams ?? [];
  if (streams.length === 0) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-2).join(' / ');
    throw new ProbeError(
      `文件里没有找到任何音视频轨道${tail ? `（${tail}）` : ''}`,
      'invalid-input',
      result.stderr,
    );
  }

  const format = raw.format ?? {};
  const durationFromFormat = Number(format.duration ?? 0);
  const ext = path.extname(filePath).replace('.', '').toLowerCase();

  /* ---- 视频流 ---- */
  const video: VideoStreamInfo[] = streams
    .filter((s) => s.codec_type === 'video')
    .map((s) => {
      const rotation = readRotation(s);
      const { w, h } = displaySize(s.width ?? 0, s.height ?? 0, s.sample_aspect_ratio, rotation);
      const avgFps = parseFraction(s.avg_frame_rate);
      const rFps = parseFraction(s.r_frame_rate);
      return {
        index: s.index,
        codec: s.codec_name ?? 'unknown',
        codecLongName: s.codec_long_name ?? s.codec_name ?? '未知编码',
        profile: s.profile ?? '',
        width: s.width ?? 0,
        height: s.height ?? 0,
        displayWidth: w,
        displayHeight: h,
        rotation,
        fps: rFps,
        avgFps: avgFps || rFps,
        bitrateKbps: s.bit_rate ? Math.round(Number(s.bit_rate) / 1000) : null,
        pixFmt: s.pix_fmt ?? '',
        bitDepth: Number(s.bits_per_raw_sample ?? (s.pix_fmt?.includes('10') ? 10 : 8)) || 8,
        colorTransfer: s.color_transfer ?? null,
        isHdr: isHdrStream(s),
        isAttachedPic: (s.disposition?.attached_pic ?? 0) === 1,
        durationSec: s.duration ? Number(s.duration) : null,
        language: s.tags?.language ?? null,
        title: s.tags?.title ?? null,
      };
    });

  /* ---- 音频流 ---- */
  const audio: AudioStreamInfo[] = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      codecLongName: s.codec_long_name ?? s.codec_name ?? '未知编码',
      profile: s.profile ?? '',
      channels: s.channels ?? 0,
      channelLayout: s.channel_layout ?? '',
      sampleRate: Number(s.sample_rate ?? 0),
      bitrateKbps: s.bit_rate ? Math.round(Number(s.bit_rate) / 1000) : null,
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      isDefault: (s.disposition?.default ?? 0) === 1,
    }));

  /* ---- 字幕流 ---- */
  const subtitle: SubtitleStreamInfo[] = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      isDefault: (s.disposition?.default ?? 0) === 1,
      isForced: (s.disposition?.forced ?? 0) === 1,
      isTextBased: TEXT_SUBTITLE_CODECS.has((s.codec_name ?? '').toLowerCase()),
    }));

  /* ---- 章节 ---- */
  const chapters: ChapterInfo[] = (raw.chapters ?? []).map((c, i) => ({
    index: c.id ?? i,
    startSec: Number(c.start_time ?? 0),
    endSec: Number(c.end_time ?? 0),
    title: c.tags?.title ?? null,
  }));

  const durationSec = durationFromFormat > 0 ? durationFromFormat : maxStreamDuration(streams);

  // 容器级元数据：过滤掉 ffprobe 自动填的技术字段，只留作者写的
  const tags: Record<string, string> = {};
  const skipTags = new Set(['encoder', 'handler_name', 'vendor_id', 'major_brand', 'minor_version', 'compatible_brands', 'creation_time']);
  for (const [k, v] of Object.entries(format.tags ?? {})) {
    if (!skipTags.has(k.toLowerCase()) && v) tags[k] = v;
  }

  const realVideo = video.filter((v) => !v.isAttachedPic);
  // 缩略图抽帧点：默认取 10% 处但至少 1 秒，最多 30 秒 —— 兼顾「跳过片头」与「短视频」
  const thumbnailAtSec = clampThumbnailTime(durationSec);

  return {
    path: filePath,
    fileName: path.basename(filePath),
    formatName: format.format_name ?? '',
    formatLongName: prettyFormatName(format.format_name, ext),
    extension: ext,
    durationSec,
    sizeBytes,
    bitrateKbps: format.bit_rate ? Math.round(Number(format.bit_rate) / 1000) : null,
    hasVideo: realVideo.length > 0,
    hasAudio: audio.length > 0,
    hasSubtitle: subtitle.length > 0,
    video,
    audio,
    subtitle,
    chapters,
    tags,
    thumbnailAtSec,
  };
}

function maxStreamDuration(streams: RawStream[]): number {
  let max = 0;
  for (const s of streams) {
    const d = Number(s.duration ?? 0);
    if (Number.isFinite(d) && d > max) max = d;
  }
  return max;
}

/**
 * 抽帧时间点：取时长的 10%，下限 1 秒（跳过片头黑场/台标），
 * 上限 30 秒（长视频不必等到中段），短视频则退化为 0 秒。
 */
export function clampThumbnailTime(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const tenPercent = durationSec * 0.1;
  if (durationSec <= 1) return 0;
  return Math.min(Math.max(tenPercent, 1), Math.min(30, durationSec * 0.5));
}
