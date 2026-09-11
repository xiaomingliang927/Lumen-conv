/**
 * 单帧实时预览（「改了参数会变成什么样」）。
 *
 * ------------------------------------------------------------------ *
 * 为什么做这个（2026-09，用户从优化清单里勾选的一项）
 *
 * 在此之前，用户改分辨率/画面比例/裁剪之后**看不到画面会变成什么样**，
 * 只能靠"预计体积"这一个间接信号猜。而这恰恰是桌面端相对网页端最该有的能力：
 * 本地有 ffmpeg，抽一帧、套上同一套滤镜、几百毫秒就能出图。
 *
 * ------------------------------------------------------------------ *
 * 预览**能**反映什么、**不能**反映什么（这个界限必须说清楚）
 *
 * 能：几何类效果 —— 分辨率上限、竖屏补边/裁剪、字幕烧录、HDR 色调映射的有无。
 * 不能：编码质量差异。预览帧是无损 PNG，而正式转换是有损编码（CRF/码率），
 *       "压到 2 Mbps 会不会糊"这种问题预览答不了 —— 那要看「预计体积」。
 *
 * 所以界面上写的是"画面效果预览"，而不是"输出效果预览"。
 * 宁可把能力说小一点，也不要让用户以为它验证了画质。
 *
 * ------------------------------------------------------------------ *
 * 与正式转换的一致性：滤镜链**复用同一批规则**
 *   · 尺寸/比例来自 shared/output-size.ts 的 planOutputSize（与 ffmpeg 转换读同一份）
 *   · 字幕烧录来自 shared/subtitle-burn.ts（同一套转义与 si 换算）
 * 这两处如果各写一份，预览就会和产物对不上 —— 那比没有预览更糟。
 */

import path from 'node:path';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { cacheDir } from './binaries';
import { exec } from './process';
import { findResolution } from '../../shared/presets';
import { planOutputSize, type FitMode } from '../../shared/output-size';
import { burnSubtitleFilter, subtitleStreamOrdinal } from '../../shared/subtitle-burn';
import type { ConversionOptions, MediaProbeResult } from '../../shared/types';

/** 预览图最大宽度：中间栏放大查看时要够清晰（960 宽 ≈ 1080p 源的 0.5 倍） */
const PREVIEW_MAX_WIDTH = 960;
const PREVIEW_TIMEOUT_MS = 20_000;

export interface PreviewResult {
  ok: boolean;
  /** 输出 PNG 的绝对路径；ok=false 时为 null */
  filePath: string | null;
  /** 这次套用了哪些效果（人话，界面直接显示） */
  effects: string[];
  /** 失败原因（人话） */
  error: string | null;
}

/**
 * 拼出预览用的视频滤镜链。
 *
 * 顺序与正式转换保持一致：尺寸/比例 → 字幕 → （预览专用）缩小到显示宽度。
 * 预览专用的缩小放在最后：它只影响这张预览图的像素量，不影响构图。
 */
export function buildPreviewFilters(probe: MediaProbeResult, options: ConversionOptions): {
  filters: string[];
  effects: string[];
} {
  const video = probe.video.find((v) => !v.isAttachedPic) ?? probe.video[0];
  if (!video) return { filters: [], effects: [] };

  const effects: string[] = [];
  const resolution = findResolution(options.resolutionId);
  const plan = planOutputSize(
    { width: video.displayWidth, height: video.displayHeight, rotation: 0 },
    resolution.height,
    (options.fitMode ?? 'off') as FitMode,
  );
  const filters = [...plan.filters];
  if (plan.changes) effects.push(plan.note);
  else effects.push(`尺寸不变（${plan.width}×${plan.height}）`);

  // 字幕烧录：与正式转换同一套转义与 si 换算
  const burnIndex = options.burnSubtitleIndex;
  if (burnIndex !== null && burnIndex !== undefined) {
    const target = probe.subtitle.find((s) => s.index === burnIndex);
    if (target?.isTextBased) {
      filters.push(
        burnSubtitleFilter(
          probe.path,
          subtitleStreamOrdinal(
            probe.subtitle.map((s) => s.index),
            burnIndex,
          ),
        ),
      );
      effects.push(`字幕「${target.title || target.language || `#${target.index}`}」已烧进画面`);
    }
  }

  // 预览专用：等比缩到显示宽度以内。比目标还小的画面不放大（放大只会更糊）
  if (plan.width > PREVIEW_MAX_WIDTH) {
    filters.push(`scale=${PREVIEW_MAX_WIDTH}:-2:flags=lanczos`);
  }

  return { filters, effects };
}

/**
 * 抽取"套用当前参数后"的一帧。
 *
 * -ss 放在 -i 之前走关键帧快速定位（与缩略图同样的取舍）：预览要的是**快**，
 * 不是逐帧精确 —— 而且这里抽的位置就是缩略图用的同一个时间点，
 * 所以左右两张图是**同一帧**，对比才有意义。
 */
export async function renderPreview(
  probe: MediaProbeResult,
  options: ConversionOptions,
  atSec: number,
  ffmpegPath: string,
): Promise<PreviewResult> {
  const video = probe.video.find((v) => !v.isAttachedPic) ?? probe.video[0];
  if (!video) {
    return { ok: false, filePath: null, effects: [], error: '源文件没有视频轨道，无法预览画面' };
  }

  const { filters, effects } = buildPreviewFilters(probe, options);
  /*
   * 目录必须自己建：`cacheDir()` 只拼路径，不创建目录。
   * 不建的话 ffmpeg 会以"无法打开输出文件"失败，而错误信息只说打不开文件，
   * 不看代码根本想不到是目录不存在（实测就是这么空转了一轮，缓存目录里一张图都没有）。
   */
  const dir = cacheDir('previews');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 已存在或权限问题，交给 ffmpeg 报错 */
  }
  const outPath = path.join(dir, `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    Math.max(0, atSec).toFixed(3),
    '-i',
    probe.path,
    '-frames:v',
    '1',
    '-an',
    '-sn',
  ];
  if (filters.length > 0) args.push('-vf', filters.join(','));
  args.push('-f', 'image2', outPath);

  const res = await exec(ffmpegPath, args, { timeoutMs: PREVIEW_TIMEOUT_MS });
  if (res.code !== 0 || res.spawnError) {
    const tail = (res.stderr || res.spawnError || '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    return {
      ok: false,
      filePath: null,
      effects,
      error: tail ? tail.slice(0, 160) : '抽帧失败（该文件可能没有可解码的视频轨道）',
    };
  }

  return { ok: true, filePath: outPath, effects, error: null };
}

/**
 * 清掉过期的预览图。
 *
 * 每次渲染都会生成一个新文件（旧的可能正被界面引用，所以不能在生成时直接覆盖同一个名字）。
 * 不清理的话缓存会无限增长 —— 实测一轮自检就留下 5 张，用户调十分钟参数就是几百张。
 * 策略：保留最近 10 分钟内的，其余删除。正常使用中界面只会引用刚才那一张。
 */
export function sweepPreviewCache(maxAgeMs = 10 * 60 * 1000): number {
  const dir = cacheDir('previews');
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (now - statSync(full).mtimeMs > maxAgeMs) {
          rmSync(full, { force: true });
          removed++;
        }
      } catch {
        /* 单个文件删不掉不影响其它 */
      }
    }
  } catch {
    /* 目录不存在 = 没有可清的 */
  }
  return removed;
}

/** 清空整个预览缓存（设置页的「清理缓存」会一并调用） */
export function clearPreviewCache(): number {
  const dir = cacheDir('previews');
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        rmSync(path.join(dir, name), { force: true });
        removed++;
      } catch {
        /* 忽略单个失败 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return removed;
}
