/**
 * 缩略图生成。
 *
 * 分两级策略：
 *  1) 「单点抽帧」：指定时间点直接抽一帧。快，但遇到片头黑场 / 台标会得到黑图。
 *  2) 「智能选帧」：先用 blackdetect 找出片头黑场区间，再在候选时间点抽若干帧，
 *     算平均亮度选最"有内容"的一张。慢一些（约 0.5-1.5s），但结果明显更可用。
 *
 * 默认走智能选帧，并带磁盘缓存：同一文件 + 同一尺寸只算一次，
 * 第二次进入应用时缩略图是「秒出」的 —— 对批量导入体验影响很大。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, promises as fsp, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ThumbnailResult } from '../../shared/types';
import { cacheDir } from './binaries';
import { exec } from './process';

const FRAME_WIDTH = 480;
const FRAME_TIMEOUT_MS = 25_000;
const BLACKDETECT_TIMEOUT_MS = 20_000;

export interface ThumbnailContext {
  ffmpegPath: string;
  durationSec: number;
}

/* ----------------------------- 缓存键 ----------------------------- */

interface SourceIdentity {
  path: string;
  size: number;
  mtimeMs: number;
}

function identityOf(filePath: string): SourceIdentity | null {
  try {
    const st = statSync(filePath);
    return { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function cacheKey(id: SourceIdentity): string {
  // 用「路径 + 大小 + 修改时间」做键：文件被替换后缓存自动失效。
  // 刻意不含抽帧时间点 —— 同一文件只保留一张封面，避免用户来回点开时反复重算，
  // 「换个时间点重新取帧」是显式操作（传 atSec），此时覆盖同一张缓存即可。
  return createHash('sha1')
    .update(`${id.path}|${id.size}|${Math.round(id.mtimeMs)}|${FRAME_WIDTH}`)
    .digest('hex')
    .slice(0, 24);
}

/* --------------------------- 抽帧 --------------------------- */

/** 构造抽帧滤镜链：等比缩放到 480 宽，偶数对齐（jpg 其实不要求，但保持一致性） */
function frameFilter(): string {
  return `scale=${FRAME_WIDTH}:-2:flags=lanczos`;
}

async function extractFrame(
  filePath: string,
  atSec: number,
  outPath: string,
  ffmpegPath: string,
): Promise<boolean> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    // -ss 放在 -i 之前：走关键帧快速定位，比解码到该时间点快一个数量级
    '-ss',
    atSec.toFixed(3),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    frameFilter(),
    '-q:v',
    '3',
    '-f',
    'image2',
    outPath,
  ];
  const res = await exec(ffmpegPath, args, { timeoutMs: FRAME_TIMEOUT_MS });
  if (res.code !== 0 || res.spawnError) return false;
  try {
    return statSync(outPath).size > 512; // 小于 512 字节基本是空图
  } catch {
    return false;
  }
}

/* ------------------------ 亮度评估（智能选帧用） ------------------------ */

/**
 * 用 ffmpeg 的 signalstats 滤镜取平均亮度 YAVG。
 * 输出形如：... lavfi.signalstats.YAVG=42.31
 */
async function averageLuma(
  filePath: string,
  atSec: number,
  ffmpegPath: string,
): Promise<number | null> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-ss',
    atSec.toFixed(3),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f',
    'null',
    '-',
  ];
  const res = await exec(ffmpegPath, args, { timeoutMs: FRAME_TIMEOUT_MS });
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(res.stdout + res.stderr);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/* ------------------------ 片头黑场检测 ------------------------ */

/**
 * blackdetect：找出视频里所有黑场区间，用来避开片头黑屏。
 * 输出形如：black_start:0 black_end:1.2 black_duration:1.2
 */
async function detectBlackRanges(
  filePath: string,
  ffmpegPath: string,
): Promise<{ start: number; end: number }[]> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'info',
    // 只扫前 60 秒就够：片头黑场不会出现在更靠后的位置
    '-t',
    '60',
    '-i',
    filePath,
    '-vf',
    'blackdetect=d=0.1:pix_th=0.10',
    '-an',
    '-f',
    'null',
    '-',
  ];
  const res = await exec(ffmpegPath, args, { timeoutMs: BLACKDETECT_TIMEOUT_MS });
  const text = res.stdout + res.stderr;
  const ranges: { start: number; end: number }[] = [];
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ranges.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  return ranges;
}

/** 若时间点落在黑场区间内，返回黑场结束时间（+0.4s 缓冲），否则原样返回 */
function avoidBlack(t: number, ranges: { start: number; end: number }[]): number {
  for (const r of ranges) {
    if (t >= r.start - 0.05 && t <= r.end + 0.05) return r.end + 0.4;
  }
  return t;
}

/* --------------------------- 对外主入口 --------------------------- */

/**
 * 生成（或从缓存取）缩略图。
 * @param atSec 不传则使用智能选帧
 */
export async function getThumbnail(
  filePath: string,
  ctx: ThumbnailContext,
  atSec?: number,
): Promise<ThumbnailResult> {
  const identity = identityOf(filePath);
  if (!identity) {
    return {
      sourcePath: filePath,
      filePath: null,
      atSec: 0,
      width: null,
      height: null,
      error: '无法读取该文件（可能已被移动或删除）',
      cached: false,
    };
  }

  const dir = cacheDir('thumbs');
  mkdirSync(dir, { recursive: true });

  const smart = atSec === undefined;
  const key = cacheKey(identity);
  const outPath = path.join(dir, `${key}.jpg`);

  // 智能模式下命中缓存直接返回；显式指定时间点时覆盖重算（要覆盖旧图，先删掉）
  if (existsSync(outPath)) {
    if (smart) {
      try {
        if (statSync(outPath).size > 512) {
          return {
            sourcePath: filePath,
            filePath: outPath,
            // 命中缓存也要答出真实帧时间（旧缓存没有旁车文件时才退回 -1）
            atSec: readFrameTime(outPath),
            width: FRAME_WIDTH,
            height: null,
            error: null,
            cached: true,
          };
        }
      } catch {
        /* 缓存损坏，继续重新生成 */
      }
    } else {
      try {
        await fsp.unlink(outPath);
      } catch {
        /* 删不掉就让 -y 覆盖 */
      }
    }
  }

  const duration = ctx.durationSec > 0 ? ctx.durationSec : 0;
  const candidates: number[] = [];

  if (smart) {
    // 候选点：10%（默认最佳观感）、25%、50%、5%，外加 2 秒处兜底
    const base = duration > 0 ? duration : 0;
    const picks = [0.1, 0.25, 0.5, 0.05];
    for (const p of picks) {
      if (base > 0.6) candidates.push(Math.max(0.2, Math.min(base * p, Math.max(0.2, base - 0.2))));
    }
    if (base > 2.5) candidates.push(2);
    if (candidates.length === 0) candidates.push(0);

    // 片头黑场规避（只在前 60s 内做一次检测，成本很低）
    try {
      const blackRanges = await detectBlackRanges(filePath, ctx.ffmpegPath);
      for (let i = 0; i < candidates.length; i++) {
        candidates[i] = avoidBlack(candidates[i], blackRanges);
      }
    } catch {
      /* 检测失败不影响主流程 */
    }
  } else {
    candidates.push(Math.max(0, atSec));
  }

  // 去重后逐个尝试，第一个成功且「不黑」的就用
  const tried = new Set<number>();
  let firstSuccessAt: number | null = null;

  for (const t of candidates) {
    const time = Math.round(t * 1000) / 1000;
    if (tried.has(time) || time < 0) continue;
    tried.add(time);

    const ok = await extractFrame(filePath, time, outPath, ctx.ffmpegPath);
    if (!ok) continue;

    if (firstSuccessAt === null) firstSuccessAt = time;

    if (!smart) break;

    // 智能模式下评估亮度：太暗（<12）说明还是黑场/极暗画面，换下一个候选点
    const luma = await averageLuma(filePath, time, ctx.ffmpegPath);
    if (luma === null || luma >= 12) break;
  }

  if (firstSuccessAt === null) {
    return {
      sourcePath: filePath,
      filePath: null,
      atSec: candidates[0] ?? 0,
      width: null,
      height: null,
      error: '抽帧失败：该文件可能没有可解码的视频轨道',
      cached: false,
    };
  }

  try {
    const size = statSync(outPath).size;
    if (size <= 512) throw new Error('empty');
  } catch {
    return {
      sourcePath: filePath,
      filePath: null,
      atSec: firstSuccessAt,
      width: null,
      height: null,
      error: '抽帧结果为空，文件可能已损坏',
      cached: false,
    };
  }

  writeFrameTime(outPath, firstSuccessAt);

  return {
    sourcePath: filePath,
    filePath: outPath,
    atSec: firstSuccessAt,
    width: FRAME_WIDTH,
    height: null,
    error: null,
    cached: false,
  };
}

/**
 * 把"这张缩略图是第几秒的"记在缓存旁边。
 *
 * 起因：命中缓存时原来返回 `atSec: -1`（表示"我不知道是哪一帧"），
 * 而画面预览需要**在原图那一帧上**套参数。之前预览退而使用 `probe.thumbnailAtSec`
 * ——那是另一套候选点算法算出来的时间，于是左边第 0 秒、右边第 1 秒，
 * "同一帧对比"变成了两帧对比（截图里 LUMEN 水印一个 0s 一个 1s 就是这么来的）。
 * 现在把真实时间持久化，命中缓存也能答出准确的帧时间。
 */
function sidecarPath(outPath: string): string {
  return outPath.replace(/\.jpg$/i, '.json');
}

function writeFrameTime(outPath: string, atSec: number): void {
  try {
    writeFileSync(sidecarPath(outPath), JSON.stringify({ atSec }), 'utf8');
  } catch {
    /* 写不进就算了：读不到时会退回 -1，由调用方兜底 */
  }
}

function readFrameTime(outPath: string): number {
  try {
    const raw = readFileSync(sidecarPath(outPath), 'utf8');
    const v = (JSON.parse(raw) as { atSec?: unknown }).atSec;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  } catch {
    /* 没有旁车文件（旧缓存）或内容坏了 */
  }
  return -1;
}

/**
 * 生成视频预览 sprite / 逐帧缩略（供「时间轴选帧」用）。
 * 当前 UI 未使用，保留给后续「让用户手动挑封面」的功能。
 */
export async function extractFrameAt(
  filePath: string,
  atSec: number,
  ffmpegPath: string,
  outPath?: string,
): Promise<string | null> {
  const target = outPath ?? path.join(cacheDir('frames'), `${Date.now()}.jpg`);
  mkdirSync(path.dirname(target), { recursive: true });
  const ok = await extractFrame(filePath, atSec, target, ffmpegPath);
  return ok ? target : null;
}

/** 清理缩略图缓存，返回释放的字节数 */
export async function clearThumbnailCache(): Promise<number> {
  const dir = cacheDir('thumbs');
  if (!existsSync(dir)) return 0;
  let freed = 0;
  const entries = await fsp.readdir(dir);
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      freed += statSync(p).size;
      await fsp.unlink(p);
    } catch {
      /* 忽略单个文件失败 */
    }
  }
  return freed;
}

/** 预热：在探测完成后后台调用，不阻塞 UI（用户点开列表时缩略图已就绪） */
export function warmThumbnail(filePath: string, ctx: ThumbnailContext): void {
  void getThumbnail(filePath, ctx).catch(() => undefined);
}
