/**
 * 展示层格式化工具。
 * 原则：所有面向用户的数字都要带单位、能一眼读懂，不把原始数值直接甩到界面上。
 */

export function formatBytes(bytes: number | null | undefined, digits?: number): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const d = digits ?? (value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return `${value.toFixed(d)} ${units[i]}`;
}

/** 秒 → 00:12:34 / 12:34 */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/** 秒 → 1 小时 23 分（用于剩余时间） */
export function formatEta(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '计算中…';
  if (sec < 1) return '即将完成';
  if (sec < 60) return `剩余 ${Math.ceil(sec)} 秒`;
  if (sec < 3600) return `剩余 ${Math.ceil(sec / 60)} 分钟`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `剩余 ${h} 小时 ${m} 分`;
}

export function formatBitrate(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps) || kbps <= 0) return '—';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(kbps >= 10000 ? 1 : 2)} Mbps`;
  return `${kbps} kbps`;
}

export function formatFps(fps: number | null | undefined): string {
  if (!fps || !Number.isFinite(fps) || fps <= 0) return '—';
  // 29.97 / 23.976 这类非整数帧率要保留小数，整数帧率不要显示 .00
  const rounded = Math.round(fps * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded} fps` : `${rounded.toFixed(2)} fps`;
}

export function formatChannels(channels: number, layout?: string): string {
  if (!channels) return '—';
  const names: Record<number, string> = { 1: '单声道', 2: '立体声', 6: '5.1 环绕', 8: '7.1 环绕' };
  const name = names[channels];
  // 有中文名时不再附英文布局名（"单声道 · mono" 是冗余信息）；
  // 只有 ffprobe 报了具体布局且我们没有对应中文名时才附上，用于区分细分声道。
  if (name) return name;
  return layout ? `${channels} 声道 · ${layout}` : `${channels} 声道`;
}

export function formatSampleRate(hz: number): string {
  if (!hz) return '—';
  return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`;
}

/** 速度倍率 → 2.35× */
export function formatSpeed(speed: number | null | undefined): string {
  if (speed === null || speed === undefined || !Number.isFinite(speed) || speed <= 0) return '—';
  return `${speed.toFixed(speed >= 10 ? 1 : 2)}×`;
}

/** 压缩比：输出 / 源，越小越好 */
export function formatRatio(outputBytes: number | null, sourceBytes: number): string {
  if (!outputBytes || !sourceBytes) return '—';
  const pct = (outputBytes / sourceBytes) * 100;
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

/** 用「源大小 + 预估码率」推算产物体积，用于转换前的预期提示 */
export function predictOutputBytes(bitrateKbps: number, durationSec: number): number | null {
  if (!bitrateKbps || bitrateKbps <= 0 || !durationSec || durationSec <= 0) return null;
  return Math.round((bitrateKbps * 1000 * durationSec) / 8);
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx > 0 ? p.slice(0, idx) : p;
}

export function fileExtension(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toUpperCase() : '';
}

/** 从文件名生成一个安全、简洁的输出名 */
export function stripExtension(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

/** 人类可读的相对时间 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/** 状态 → 中文标签 */
export function stateLabel(state: string): string {
  const map: Record<string, string> = {
    queued: '排队中',
    probing: '分析中',
    running: '转换中',
    done: '已完成',
    failed: '失败',
    canceled: '已取消',
  };
  return map[state] ?? state;
}

export function languageName(code: string | null): string {
  if (!code) return '';
  const map: Record<string, string> = {
    chi: '中文',
    zho: '中文',
    eng: '英语',
    jpn: '日语',
    kor: '韩语',
    fra: '法语',
    deu: '德语',
    spa: '西班牙语',
    rus: '俄语',
    und: '未标注',
  };
  return map[code.toLowerCase()] ?? code.toUpperCase();
}
