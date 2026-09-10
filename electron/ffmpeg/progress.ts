/**
 * ffmpeg -progress 输出解析。
 *
 * ffmpeg 在 `-progress pipe:1` 模式下会持续往 stdout 写 key=value 行，
 * 以 `progress=continue` 或 `progress=end` 作为一次上报的结尾。例如：
 *
 *   frame=120
 *   fps=48.0
 *   out_time_us=4000000
 *   out_time_ms=4000000      <- 注意：这个字段名有历史坑，单位其实是微秒
 *   speed=2.35x
 *   progress=continue
 *
 * 「给人用」的关键点：把 out_time 换算成百分比、剩余时间、速度，
 * 而不是把 ffmpeg 的原始字段直接丢给用户看。
 */
import type { ConversionProgress } from '../../shared/types';

export interface ProgressTrackerOptions {
  /** 源视频总时长（秒）。<=0 时无法估算百分比 */
  totalDurationSec: number;
  /** 裁剪起始时间：进度要相对裁剪后的区间计算 */
  trimStartSec?: number;
  /** 裁剪结束时间 */
  trimEndSec?: number | null;
  onUpdate: (progress: ConversionProgress) => void;
}

export class ProgressTracker {
  private buffer = '';
  private readonly startMs: number;
  private lastEmitMs = 0;
  private readonly totalSec: number;

  constructor(private readonly options: ProgressTrackerOptions) {
    const start = options.trimStartSec ?? 0;
    const end = options.trimEndSec ?? options.totalDurationSec;
    this.totalSec = Math.max(0, (end ?? options.totalDurationSec) - start);
    this.startMs = Date.now();
  }

  /** 喂入一段 stdout 原始文本，内部按行缓冲 */
  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    let current: Record<string, string> = {};
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      current[key] = value;
      if (key === 'progress') {
        this.emit(current);
        current = {};
      }
    }
  }

  private emit(raw: Record<string, string>): void {
    // 节流：ffmpeg 默认每 ~0.5s 上报一次，这里再兜一层，
    // 避免两遍编码 / GIF 调色板等场景把 IPC 消息打得过密。
    const now = Date.now();
    if (now - this.lastEmitMs < 400 && raw.progress !== 'end') return;
    this.lastEmitMs = now;

    const outTimeSec = parseOutTime(raw);
    const speed = parseSpeed(raw.speed);
    const frame = raw.frame ? Number(raw.frame) : null;
    const outBytes = raw.total_size ? Number(raw.total_size) : null;

    let percent: number | null = null;
    let etaSec: number | null = null;

    if (this.totalSec > 0 && outTimeSec !== null) {
      percent = Math.max(0, Math.min(100, (outTimeSec / this.totalSec) * 100));
      if (raw.progress === 'end') percent = 100;
      else if (speed && speed > 0.05) {
        const remaining = Math.max(0, this.totalSec - outTimeSec);
        etaSec = remaining / speed;
      } else {
        // 没有 speed 字段时，用实际耗时反推平均速度（对硬件编码器很常见）
        const elapsed = (now - this.startMs) / 1000;
        if (elapsed > 1.5 && outTimeSec > 0.5) {
          const avgSpeed = outTimeSec / elapsed;
          if (avgSpeed > 0.01) etaSec = Math.max(0, this.totalSec - outTimeSec) / avgSpeed;
        }
      }
    }

    this.options.onUpdate({
      percent,
      processedSec: outTimeSec ?? 0,
      processedText: formatDuration(outTimeSec ?? 0),
      etaSec,
      speed,
      frame: Number.isFinite(frame) ? frame : null,
      outBytes: Number.isFinite(outBytes) ? outBytes : null,
      raw,
    });
  }
}

/**
 * out_time_us 是微秒（值本身），out_time_ms 在部分版本里同样以微秒计
 * （这是 ffmpeg 长期存在的一个命名不一致），所以优先用 out_time_us。
 * 实在都没有时退化为解析 out_time=00:00:04.000000 这种时间串。
 */
function parseOutTime(raw: Record<string, string>): number | null {
  const us = raw.out_time_us ?? raw.out_time_ms;
  if (us !== undefined && us !== 'N/A') {
    const n = Number(us);
    if (Number.isFinite(n)) return n / 1_000_000;
  }
  const t = raw.out_time;
  if (t && t !== 'N/A') return parseTimeString(t);
  return null;
}

/** 解析 "00:01:23.456000" / "01:23.456" 形式的时间串 */
export function parseTimeString(value: string): number | null {
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!m) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  return h * 3600 + min * 60 + sec;
}

function parseSpeed(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(/x$/i, ''));
  return Number.isFinite(n) ? n : null;
}

/** 秒 → "HH:MM:SS" 或 "MM:SS" */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/** 秒 → "1 小时 23 分" 这种自然语言，用于 ETA */
export function formatEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '计算中';
  if (sec < 1) return '即将完成';
  if (sec < 60) return `约 ${Math.ceil(sec)} 秒`;
  if (sec < 3600) return `约 ${Math.ceil(sec / 60)} 分钟`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `约 ${h} 小时 ${m} 分`;
}
