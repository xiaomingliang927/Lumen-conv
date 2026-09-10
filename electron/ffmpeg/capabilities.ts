/**
 * 运行环境能力探测：ffmpeg 版本、可用编码器、硬件加速可用性。
 *
 * 为什么值得单独做：
 * - 硬件编码器（NVENC/QSV/AMF）在 ffmpeg 的 `-encoders` 列表里**总是存在**，
 *   即使机器上没有对应显卡。只看列表会把用户带进坑里：选了「显卡加速」，
 *   转换一开始就报 "Cannot load nvcuda.dll"。
 *   所以这里对每个硬件编码器真的跑一次 0.2 秒的空转编码来验证。
 * - 探测结果缓存到内存 + 磁盘，二次启动秒开。
 */
import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import type { EncoderAvailability, SystemCapabilities } from '../../shared/types';
import { VIDEO_CODECS } from '../../shared/presets';
import { cacheDir } from './binaries';
import { exec } from './process';

const FFMPEG_TIMEOUT_MS = 20_000;
const HW_PROBE_TIMEOUT_MS = 15_000;
/** 硬件探测结果缓存有效期：24 小时（换显卡/装驱动后能自动刷新） */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedProbe {
  probedAt: number;
  ffmpegPath: string;
  version: string | null;
  encoders: EncoderAvailability[];
}

let memoryCache: SystemCapabilities | null = null;

function cacheFile(): string {
  return cacheDir('capabilities.json');
}

async function readDiskCache(ffmpegPath: string): Promise<CachedProbe | null> {
  try {
    const raw = await fsp.readFile(cacheFile(), 'utf8');
    const parsed = JSON.parse(raw) as CachedProbe;
    if (parsed.ffmpegPath !== ffmpegPath) return null;
    if (Date.now() - parsed.probedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDiskCache(data: CachedProbe): Promise<void> {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    await fsp.writeFile(cacheFile(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* 缓存写失败不影响功能 */
  }
}

/** 取 ffmpeg 版本号（第一行形如 `ffmpeg version 6.1.1-full_build ...`） */
async function readVersion(ffmpegPath: string): Promise<{ version: string | null; raw: string }> {
  const res = await exec(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: FFMPEG_TIMEOUT_MS });
  const text = res.stdout || res.stderr;
  const m = /ffmpeg version (\S+)/.exec(text);
  return { version: m ? m[1] : null, raw: text };
}

/**
 * 真实试跑一次编码来验证硬件编码器是否可用。
 * 用 lavfi 合成 0.2 秒黑帧，成本极低（正常 <300ms）。
 */
async function testEncoder(ffmpegPath: string, encoder: string): Promise<{ ok: boolean; reason: string | null }> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x240:r=30:d=0.2',
    '-frames:v',
    '6',
    '-c:v',
    encoder,
    '-f',
    'null',
    '-',
  ];
  const res = await exec(ffmpegPath, args, { timeoutMs: HW_PROBE_TIMEOUT_MS });
  if (res.spawnError) return { ok: false, reason: res.spawnError };
  if (res.timedOut) return { ok: false, reason: '探测超时（驱动可能异常）' };
  if (res.code === 0) return { ok: true, reason: null };

  const stderr = res.stderr.toLowerCase();
  let reason = '该编码器在当前环境不可用';
  if (stderr.includes('cannot load') || stderr.includes('not found') || stderr.includes('no capable devices')) {
    reason = '未检测到对应的显卡或驱动';
  } else if (stderr.includes('cannot open') || stderr.includes('device creation failed')) {
    reason = '显卡被占用或驱动版本过低';
  } else if (stderr.includes('unknown encoder')) {
    reason = '当前 ffmpeg 构建未包含该编码器';
  } else if (stderr.includes('error while opening encoder') || stderr.includes('initialize')) {
    reason = '编码器初始化失败（通常是驱动问题）';
  }
  return { ok: false, reason };
}

/** 查询 ffmpeg 是否编译进了某个编码器 */
function hasEncoderInList(listOutput: string, encoder: string): boolean {
  const re = new RegExp(`^\\s*\\S+\\s+${encoder}\\s`, 'm');
  return re.test(listOutput);
}

export interface ProbeCapabilitiesOptions {
  ffmpegPath: string;
  /** 跳过硬件试跑（快速模式，仅用于启动时先出界面） */
  quick?: boolean;
  forceRefresh?: boolean;
}

export async function probeCapabilities(
  options: ProbeCapabilitiesOptions,
): Promise<SystemCapabilities> {
  const { ffmpegPath, quick = false, forceRefresh = false } = options;

  if (!forceRefresh && memoryCache && memoryCache.ffmpegPath === ffmpegPath && !quick) {
    return memoryCache;
  }

  const diagnostics: string[] = [];
  const { version, raw } = await readVersion(ffmpegPath);
  if (!version) {
    diagnostics.push('无法读取 ffmpeg 版本号，二进制可能损坏或不是 ffmpeg');
  }

  const encList = await exec(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: FFMPEG_TIMEOUT_MS });
  const listText = encList.stdout + encList.stderr;

  const hardwareCodecs = VIDEO_CODECS.filter((c) => c.hardware);

  let hardwareResults: Map<string, { ok: boolean; reason: string | null }>;

  const cached = !forceRefresh ? await readDiskCache(ffmpegPath) : null;
  if (cached && !quick) {
    hardwareResults = new Map(cached.encoders.map((e) => [e.id, { ok: e.available, reason: e.reason }]));
    diagnostics.push('硬件编码器可用性来自缓存（24 小时内有效）');
  } else if (quick) {
    // 快速模式：只查列表，不试跑。UI 先用这个结果渲染，随后再补一次完整探测。
    hardwareResults = new Map(
      hardwareCodecs.map((c) => [
        c.id,
        hasEncoderInList(listText, c.id)
          ? { ok: true, reason: '待验证' }
          : { ok: false, reason: '当前 ffmpeg 构建未包含该编码器' },
      ]),
    );
  } else {
    hardwareResults = new Map();
    // 串行试跑，避免同时占用多个显卡上下文导致互相干扰
    for (const codec of hardwareCodecs) {
      if (!hasEncoderInList(listText, codec.id)) {
        hardwareResults.set(codec.id, { ok: false, reason: '当前 ffmpeg 构建未包含该编码器' });
        continue;
      }
      hardwareResults.set(codec.id, await testEncoder(ffmpegPath, codec.id));
    }
  }

  const encoders: EncoderAvailability[] = [
    ...VIDEO_CODECS.filter((c) => !c.hardware && c.id !== 'copy').map((c) => ({
      id: c.id,
      label: c.label,
      kind: 'software' as const,
      available: hasEncoderInList(listText, softwareEncoderName(c.id)),
      reason: hasEncoderInList(listText, softwareEncoderName(c.id))
        ? null
        : `当前 ffmpeg 构建未包含 ${softwareEncoderName(c.id)}`,
    })),
    ...hardwareCodecs.map((c) => {
      const r = hardwareResults.get(c.id) ?? { ok: false, reason: '未探测' };
      return {
        id: c.id,
        label: c.label,
        kind: hardwareKind(c.id),
        available: r.ok,
        reason: r.reason,
      };
    }),
  ];

  const unavailableHw = encoders.filter((e) => e.kind !== 'software' && !e.available);
  if (unavailableHw.length > 0 && !quick) {
    diagnostics.push(
      `${unavailableHw.length} 个硬件编码器不可用：` +
        unavailableHw.map((e) => `${e.id}（${e.reason ?? '未知原因'}）`).join('、'),
    );
  }

  const capabilities: SystemCapabilities = {
    ffmpegPath,
    ffprobePath: null,
    ffmpegVersion: version,
    encoders,
    probedAt: Date.now(),
    ready: Boolean(version),
    diagnostics,
  };

  if (!quick) {
    memoryCache = capabilities;
    await writeDiskCache({
      probedAt: capabilities.probedAt,
      ffmpegPath,
      version,
      encoders,
    });
  }

  // 把构建信息塞进诊断，排查跨平台问题时很有用
  const configLine = raw.split(/\r?\n/).find((l) => l.startsWith('configuration:'));
  if (configLine && !configLine.includes('--enable-libx264')) {
    diagnostics.push('警告：该 ffmpeg 构建未启用 libx264，H.264 软编码将不可用');
  }

  return capabilities;
}

function softwareEncoderName(codecId: string): string {
  switch (codecId) {
    case 'h264':
      return 'libx264';
    case 'hevc':
      return 'libx265';
    case 'av1':
      return 'libsvtav1';
    case 'vp9':
      return 'libvpx-vp9';
    case 'vp8':
      return 'libvpx';
    case 'mpeg4':
      return 'mpeg4';
    case 'gif':
      return 'gif';
    default:
      return codecId;
  }
}

function hardwareKind(codecId: string): 'nvidia' | 'intel' | 'amd' {
  if (codecId.endsWith('_nvenc')) return 'nvidia';
  if (codecId.endsWith('_qsv')) return 'intel';
  return 'amd';
}

/** 让渲染进程拿到硬件加速是否真的可用，用于默认勾选 */
export function pickBestVideoCodec(caps: SystemCapabilities, preferred: 'h264' | 'hevc'): string {
  const hwCandidates =
    preferred === 'h264' ? ['h264_nvenc', 'h264_qsv', 'h264_amf'] : ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'];
  for (const id of hwCandidates) {
    const e = caps.encoders.find((x) => x.id === id);
    if (e?.available) return id;
  }
  return preferred;
}

export function invalidateCapabilities(): void {
  memoryCache = null;
}

/** 清掉磁盘缓存（设置里改 ffmpeg 路径或用户手动刷新时调用） */
export async function clearCapabilityCache(): Promise<void> {
  invalidateCapabilities();
  const f = cacheFile();
  if (existsSync(f)) {
    try {
      await fsp.unlink(f);
    } catch {
      /* 忽略 */
    }
  }
}
