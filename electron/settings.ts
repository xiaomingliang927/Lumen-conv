/**
 * 设置持久化。
 *
 * 为什么不用 electron-store：这个小项目只需要「读一个 JSON + 合并默认值 + 原子写入」，
 * 自己写 60 行比引一个依赖更可控（也能避免打包时的额外体积与版本兼容问题）。
 */
import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types';

let cache: AppSettings | null = null;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cache = normalize({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    // 首次启动 / 文件损坏：都退回默认值，并写回一份，保证下次能读到
    cache = { ...DEFAULT_SETTINGS };
    await persist(cache);
  }
  return cache;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  const next = normalize({ ...current, ...patch });
  cache = next;
  await persist(next);
  return next;
}

async function persist(settings: AppSettings): Promise<void> {
  try {
    const file = settingsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名：避免断电/崩溃时留下半个 JSON 导致设置全丢
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    console.error('[settings] 保存失败：', err);
  }
}

function normalize(s: AppSettings): AppSettings {
  return {
    ...s,
    concurrency: Math.max(1, Math.min(4, Math.round(Number(s.concurrency) || 1))),
    theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system',
    // 旧版本设置文件里没有这个字段，缺省按「推荐」处理
    appMode: s.appMode === 'custom' ? 'custom' : 'recommended',
    ffmpegPath: validPathOrNull(s.ffmpegPath),
    ffprobePath: validPathOrNull(s.ffprobePath),
    defaultOutputDir: validPathOrNull(s.defaultOutputDir),
  };
}

function validPathOrNull(p: string | null): string | null {
  if (!p || typeof p !== 'string') return null;
  return existsSync(p) ? p : null;
}

/** 清空设置（设置页的「恢复默认」按钮） */
export async function resetSettings(): Promise<AppSettings> {
  cache = { ...DEFAULT_SETTINGS };
  await persist(cache);
  return cache;
}
