/**
 * ffmpeg / ffprobe 二进制定位。
 *
 * 三种来源，优先级从高到低：
 *  1) 用户在「设置」里手动指定的路径（最高优先级，便于排错与替换自编译版本）
 *  2) 随应用分发的二进制
 *     - 开发态：node_modules/ffmpeg-static、node_modules/ffprobe-static
 *     - 打包态：process.resourcesPath/bin/ffmpeg.exe（见 package.json 的 extraResources）
 *  3) 系统 PATH 中的 ffmpeg（用户自己装过的）
 *
 * 注意：打包后 asar 内的 .exe 无法直接执行，必须通过 extraResources 释放到
 * resources/bin 下，这里刻意不走 asarUnpack 路径，避免 __dirname 被替换成 app.asar 的问题。
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ResolvedBinary {
  path: string | null;
  /** 来源说明，展示在设置页与诊断信息里 */
  source: 'custom' | 'bundled' | 'system' | 'missing';
  /** 候选路径与存在性，用于排错 */
  candidates: { path: string; exists: boolean; origin: string }[];
}

const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * 随应用分发的二进制候选路径。
 *
 * 目录布局（开发态与打包态统一）：
 *   开发态：<项目根>/resources/bin/ffmpeg.exe
 *   打包态：<安装目录>/resources/bin/ffmpeg.exe   （由 electron-builder 的 extraResources 释放）
 *
 * 二进制由 scripts/fetch-binaries.mjs 统一获取，不依赖任何 npm 包的 postinstall
 * （原因见 docs/DECISIONS.md D-004：ffmpeg-static 的 postinstall 需要访问 github.com，
 * 在部分网络环境下会超时甚至完全不通，导致"装完了但用不了"）。
 */
function bundledCandidates(kind: 'ffmpeg' | 'ffprobe'): string[] {
  const list: string[] = [];

  // 打包态：process.resourcesPath 指向 <安装目录>/resources
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, 'bin', `${kind}${EXE}`));
  }
  // 开发态：app.getAppPath() 是项目根
  try {
    list.push(path.join(app.getAppPath(), 'resources', 'bin', `${kind}${EXE}`));
  } catch {
    /* app 未就绪时忽略 */
  }

  return list;
}

/** 在 PATH 中查找 */
function findOnPath(binary: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const abs = path.join(dir, `${binary}${EXE}`);
    try {
      if (existsSync(abs)) return abs;
    } catch {
      /* 忽略无权限目录 */
    }
  }
  return null;
}

export function resolveBinary(
  kind: 'ffmpeg' | 'ffprobe',
  customPath: string | null,
): ResolvedBinary {
  const candidates: ResolvedBinary['candidates'] = [];

  if (customPath) {
    const exists = existsSync(customPath);
    candidates.push({ path: customPath, exists, origin: '用户指定' });
    if (exists) return { path: customPath, source: 'custom', candidates };
  }

  for (const p of bundledCandidates(kind)) {
    const exists = existsSync(p);
    candidates.push({ path: p, exists, origin: '随应用分发' });
    if (exists) return { path: p, source: 'bundled', candidates };
  }

  const onPath = findOnPath(kind);
  candidates.push({ path: onPath ?? `(PATH 中的 ${kind})`, exists: Boolean(onPath), origin: '系统 PATH' });
  if (onPath) return { path: onPath, source: 'system', candidates };

  return { path: null, source: 'missing', candidates };
}

/** 当前生效的二进制路径缓存（设置变更时由 settings 模块调用 invalidate 失效） */
let cache: { ffmpeg: ResolvedBinary; ffprobe: ResolvedBinary; key: string } | null = null;

export function getBinaries(custom: { ffmpegPath: string | null; ffprobePath: string | null }): {
  ffmpeg: ResolvedBinary;
  ffprobe: ResolvedBinary;
} {
  const key = `${custom.ffmpegPath ?? ''}|${custom.ffprobePath ?? ''}`;
  if (cache && cache.key === key) return { ffmpeg: cache.ffmpeg, ffprobe: cache.ffprobe };
  const ffmpeg = resolveBinary('ffmpeg', custom.ffmpegPath);
  const ffprobe = resolveBinary('ffprobe', custom.ffprobePath);
  cache = { ffmpeg, ffprobe, key };
  return { ffmpeg, ffprobe };
}

export function invalidateBinaryCache(): void {
  cache = null;
}

/** 应用私有缓存目录：缩略图、临时调色板文件等 */
export function cacheDir(...parts: string[]): string {
  return path.join(app.getPath('userData'), 'cache', ...parts);
}
