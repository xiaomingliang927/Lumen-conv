/**
 * 转换任务引擎：队列调度、并发控制、进度上报、取消、重试。
 *
 * 设计要点：
 * - 所有任务状态只有主进程持有，渲染进程是纯投影（收到 job:updated 就重绘）。
 *   这样即使刷新界面 / 切换标签页，任务照跑不误。
 * - 并发数可配（默认 2）。ffmpeg 是 CPU/GPU 密集型，盲目并发会让总耗时变长。
 * - 取消必须杀进程树，且要清理半成品文件 —— 否则用户会看到一堆 0 字节的 .mp4。
 * - 「文件已存在」不静默覆盖，而是下一个任务直接失败并说明原因；
 *   自动改名是更贴近直觉的行为，所以默认就自动改名。
 */
import { EventEmitter } from 'node:events';
import { existsSync, promises as fsp, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ConversionOptions,
  CreateJobRequest,
  CreateJobResult,
  MediaJob,
  MediaProbeResult,
} from '../../shared/types';
import { CONTAINERS, findPreset } from '../../shared/presets';
import { buildCommand, CommandBuildError } from './commands';
import { diagnoseFfmpegError, estimateOutputBytes } from './errors';
import { ProgressTracker, formatDuration } from './progress';
import { runProcess, type RunningProcess } from './process';
import { probeMedia } from './probe';

/** 同时运行的最大任务数上限（防止用户把并发调到把机器拖死） */
const MAX_CONCURRENCY = 4;
/** 单个任务的最长运行时间：24 小时（超长视频也够用，纯属兜底） */
const JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** 历史记录上限，超过后丢弃最老的已完成任务 */
const MAX_HISTORY = 300;

interface InternalJob {
  job: MediaJob;
  options: ConversionOptions;
  probe: MediaProbeResult;
  process: RunningProcess | null;
}

export interface EngineEvents {
  updated: [MediaJob];
  log: [{ jobId: string; line: string }];
}

export class ConversionEngine extends EventEmitter {
  private readonly jobs = new Map<string, InternalJob>();
  private queue: string[] = [];
  private concurrency = 2;
  private ffmpegPath: string | null = null;
  private ffprobePath: string | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  setFfmpegPath(p: string | null): void {
    this.ffmpegPath = p;
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(n) || 1));
    this.pump();
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  list(): MediaJob[] {
    return [...this.jobs.values()]
      .map((j) => j.job)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(jobId: string): MediaJob | undefined {
    return this.jobs.get(jobId)?.job;
  }

  private runningCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.job.state === 'running' || (j.job.state === 'queued' && j.process)) n++;
    }
    return n;
  }

  /* ----------------------------- 入队 ----------------------------- */

  async createJobs(requests: CreateJobRequest[]): Promise<CreateJobResult[]> {
    const results: CreateJobResult[] = [];
    for (const req of requests) {
      results.push(await this.createJob(req));
    }
    return results;
  }

  private async createJob(req: CreateJobRequest): Promise<CreateJobResult> {
    let probe: MediaProbeResult;
    try {
      probe = await probeMedia(req.sourcePath, { ffprobePath: this.requireFfprobe() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { job: null, error: message };
    }

    const preset = findPreset(req.options.presetId);
    if (!preset) {
      return { job: null, error: `未知的输出格式：${req.options.presetId}` };
    }

    /* ---- 输出路径 ---- */
    const outputPath = await this.resolveOutputPath(probe, req.options, this.extensionFor(req.options.presetId));

    /* ---- 装配命令行 ---- */
    let built;
    try {
      built = buildCommand(req.options, { probe, outputPath });
    } catch (err) {
      const message = err instanceof CommandBuildError ? err.message : `参数有误：${String(err)}`;
      const hint = err instanceof CommandBuildError && err.hint ? `（${err.hint}）` : '';
      return { job: null, error: `${message}${hint}` };
    }

    /* ---- 磁盘空间预检 ---- */
    const estimate = estimateOutputBytes(
      built.estimatedBitrateKbps,
      (req.options.trimEndSec ?? probe.durationSec) - (req.options.trimStartSec ?? 0),
    );
    if (estimate !== null) {
      const free = await freeSpaceOf(path.dirname(outputPath));
      if (free !== null && free < estimate * 1.15) {
        return {
          job: null,
          error:
            `磁盘剩余空间不足：预计需要 ${formatBytes(estimate)}，` +
            `${path.parse(outputPath).root} 仅剩 ${formatBytes(free)}。` +
            '请清理空间或换一个输出目录。',
        };
      }
    }

    const id = randomUUID();
    const now = Date.now();
    const job: MediaJob = {
      id,
      sourcePath: probe.path,
      sourceName: probe.fileName,
      outputPath,
      sourceSizeBytes: probe.sizeBytes,
      sourceDurationSec: probe.durationSec,
      presetId: preset.id,
      presetLabel: preset.label,
      command: '',
      state: 'queued',
      progress: null,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      outputSizeBytes: null,
      createdAtLabel: new Date(now).toLocaleString('zh-CN', { hour12: false }),
    };

    const internal: InternalJob = {
      job,
      options: req.options,
      probe,
      process: null,
    };
    // command 文本在真正启动时才补 bin 前缀，这里先放参数文本方便预览
    job.command = built.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

    this.jobs.set(id, internal);
    this.queue.push(id);
    this.trimHistory();
    this.emitUpdate(internal);
    this.pump();

    return { job: { ...job }, error: null };
  }

  /* ----------------------------- 调度 ----------------------------- */

  /*
   * 队列级暂停（2026-09 新增，见 DECISIONS.md D-023）。
   *
   * 语义刻意定成"**不再启动新任务**，已经在跑的那个继续跑完"：
   *   · ffmpeg 不支持断点续传，硬停一个跑到一半的任务只能从头再来 ——
   *     那叫"取消"，不叫"暂停"，用户会白等前面的时间；
   *   · 真正想立刻腾出 CPU 的用户，可以再对那个任务点「取消」，
   *     两个动作分开、各自名副其实。
   * 暂停状态会持久化在引擎里，恢复时自动 pump。
   */
  private paused = false;

  pauseQueue(): boolean {
    this.paused = true;
    return this.paused;
  }

  resumeQueue(): boolean {
    this.paused = false;
    this.pump();
    return this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * 调整排队中任务的位置（重排）。
   *
   * 只动 `queue` 数组，不碰正在运行的任务 —— 正在跑的任务改顺序没有意义，
   * 而"把某个任务提到最前"在批量转换里非常常用（先转我要的那条）。
   * @param direction 'up' | 'down' | 'top'
   */
  moveJob(jobId: string, direction: 'up' | 'down' | 'top'): boolean {
    const at = this.queue.indexOf(jobId);
    if (at < 0) return false;
    const next = [...this.queue];
    next.splice(at, 1);
    if (direction === 'top') {
      next.unshift(jobId);
    } else if (direction === 'up') {
      next.splice(Math.max(0, at - 1), 0, jobId);
    } else {
      next.splice(Math.min(next.length, at + 1), 0, jobId);
    }
    this.queue = next;
    // 队列顺序变了要通知界面（否则按钮点了没反应）
    for (const id of this.queue) {
      const internal = this.jobs.get(id);
      if (internal) this.emitUpdate(internal);
    }
    return true;
  }

  /** 排队中的任务 id（按当前顺序）；界面用它渲染"第几位"与重排按钮的可用性 */
  queuedIds(): string[] {
    return [...this.queue];
  }

  private pump(): void {
    // 暂停时不启动新任务；恢复时 resumeQueue() 会再调一次 pump
    if (this.paused) return;
    while (this.runningCount() < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const internal = this.jobs.get(id);
      if (!internal || internal.job.state !== 'queued') continue;
      void this.run(internal);
    }
  }

  private async run(internal: InternalJob): Promise<void> {
    const { job } = internal;
    if (!this.ffmpegPath) {
      this.fail(internal, {
        message: '找不到 ffmpeg，无法开始转换',
        kind: 'ffmpeg-missing',
        rawLog: '',
        hint: '请到「设置」里指定 ffmpeg 可执行文件路径，或重新安装本应用。',
      });
      return;
    }

    job.state = 'running';
    job.startedAt = Date.now();
    this.emitUpdate(internal);

    let lastError: ReturnType<typeof diagnoseFfmpegError> | null = null;

    // 在 try 外声明：finally 里要靠它清理两遍编码的统计日志
    let built: ReturnType<typeof buildCommand> | undefined;

    try {
      built = buildCommand(internal.options, { probe: internal.probe, outputPath: job.outputPath });

      /* ---- 前置步骤（两遍编码的第一遍） ---- */
      /*
       * 两遍编码的第一遍是纯分析，没有可用的进度百分比（它不产出文件），
       * 所以这里只上报"正在分析"的日志，进度条在主命令阶段才真正动。
       * 由于第一遍耗时接近整个编码的一半，界面上会让进度条停在 0% 较久，
       * 因此额外发一条说明，避免用户以为是卡住了。
       */
      if (built.prePasses.length > 0) {
        this.emitLog(
          internal,
          `▶ 开始${built.prePasses.length} 个前置步骤（第一遍分析约占总耗时的一半，期间进度不会明显变化）`,
        );
        for (const pass of built.prePasses) {
          this.emitLog(internal, `▶ ${pass.label}`);
          this.emitLog(internal, formatCommand(this.ffmpegPath, pass.args));
          const res = await runProcess(this.ffmpegPath, pass.args, {
            timeoutMs: JOB_TIMEOUT_MS,
            onStderrLine: (line) => this.emitLog(internal, line),
          }).done;
          if (res.canceled) {
            await this.cleanupPartial(job.outputPath);
            job.state = 'canceled';
            job.finishedAt = Date.now();
            this.emitLog(internal, '任务已取消');
            this.emitUpdate(internal);
            await this.cleanupPassLog(built.passLogPrefix);
            return;
          }
          if (res.code !== 0 || res.spawnError) {
            throw new Error(res.stderr || res.spawnError || `${pass.label} 失败`);
          }
        }
        this.emitLog(internal, '✔ 第一遍分析完成，开始正式编码');
      }

      /* ---- 主命令 ---- */
      // GIF 的调色板两遍流程已经内联在单条命令的 split 滤镜链里。
      const mainArgs = built.args;

      this.emitLog(internal, formatCommand(this.ffmpegPath, mainArgs));

      const tracker = new ProgressTracker({
        totalDurationSec: effectiveDuration(internal.probe.durationSec, internal.options),
        trimStartSec: internal.options.trimStartSec ?? 0,
        trimEndSec: internal.options.trimEndSec ?? null,
        onUpdate: (progress) => {
          job.progress = progress;
          this.emitUpdate(internal);
        },
      });

      const running = runProcess(this.ffmpegPath, mainArgs, {
        timeoutMs: JOB_TIMEOUT_MS,
        onStdoutLine: (line) => tracker.push(`${line}\n`),
        onStderrLine: (line) => this.emitLog(internal, line),
      });
      internal.process = running;
      this.emitUpdate(internal);

      const result = await running.done;
      internal.process = null;

      if (result.canceled) {
        await this.cleanupPartial(job.outputPath);
        job.state = 'canceled';
        job.finishedAt = Date.now();
        this.emitLog(internal, '任务已取消，已清理未完成的输出文件');
        this.emitUpdate(internal);
        return;
      }

      if (result.code !== 0 || result.spawnError) {
        lastError = diagnoseFfmpegError(
          result.stderr || (result.spawnError ?? ''),
          result.code,
          false,
          result.timedOut,
        );
        throw new Error('ffmpeg 非零退出');
      }

      // 产出校验：ffmpeg 退出码为 0 但文件不存在/为 0 字节的情况确实存在
      const outStat = await safeStat(job.outputPath);
      if (!outStat || outStat.size === 0) {
        lastError = {
          message: '转换结束后没有生成有效文件',
          kind: 'unknown',
          rawLog: result.stderr.slice(-4000),
          hint: '请检查输出目录是否有写入权限，或换一个输出目录后重试。',
        };
        throw new Error('输出文件无效');
      }

      // 输出远小于预估（< 5%）通常意味着只转了开头就结束了
      const estimate = estimateOutputBytes(
        built.estimatedBitrateKbps,
        effectiveDuration(internal.probe.durationSec, internal.options),
      );
      if (estimate !== null && estimate > 1024 * 1024 && outStat.size < estimate * 0.05) {
        this.emitLog(
          internal,
          `⚠ 输出文件明显小于预期（${formatBytes(outStat.size)}，预期约 ${formatBytes(estimate)}），请播放确认内容完整`,
        );
      }

      job.state = 'done';
      job.outputSizeBytes = outStat.size;
      job.finishedAt = Date.now();
      job.progress = {
        percent: 100,
        processedSec: effectiveDuration(internal.probe.durationSec, internal.options),
        processedText: formatDuration(effectiveDuration(internal.probe.durationSec, internal.options)),
        etaSec: 0,
        speed: job.progress?.speed ?? null,
        frame: job.progress?.frame ?? null,
        outBytes: outStat.size,
        raw: job.progress?.raw ?? {},
      };
      this.emitLog(internal, `✔ 转换完成：${job.outputPath}（${formatBytes(outStat.size)}）`);

      // 目标体积模式下明确告诉用户有没有命中（命中率是用户最关心的事）
      if (built.targetSizeMb) {
        const targetBytes = built.targetSizeMb * 1024 * 1024;
        const diffPct = ((outStat.size - targetBytes) / targetBytes) * 100;
        this.emitLog(
          internal,
          diffPct <= 0
            ? `✔ 体积命中目标：${formatBytes(outStat.size)} ≤ ${built.targetSizeMb} MB`
            : `⚠ 略超目标 ${diffPct.toFixed(1)}%：${formatBytes(outStat.size)} vs ${built.targetSizeMb} MB`,
        );
      }
      this.emitUpdate(internal);
    } catch (err) {
      if (job.state === 'canceled') return;
      const fallback = diagnoseFfmpegError(String(err), null, false, false);
      this.fail(internal, lastError ?? fallback);
    } finally {
      // 两遍编码的统计日志（.log / .log.mbtree）必须清理，否则输出目录会留垃圾
      await this.cleanupPassLog(built?.passLogPrefix ?? null);
      this.pump();
    }
  }

  /**
   * 清理两遍编码产生的统计日志。
   * ffmpeg 会生成 `<prefix>-0.log` 与 `<prefix>-0.log.mbtree`，名字里带序号，
   * 所以不能只删一个固定文件名，要按前缀匹配。
   */
  private async cleanupPassLog(prefix: string | null): Promise<void> {
    if (!prefix) return;
    const dir = path.dirname(prefix);
    const base = path.basename(prefix);
    try {
      for (const name of await fsp.readdir(dir)) {
        if (name.startsWith(base)) await fsp.rm(path.join(dir, name), { force: true });
      }
    } catch {
      /* 目录不存在或权限不足都不影响主流程 */
    }
  }

  private fail(internal: InternalJob, error: ReturnType<typeof diagnoseFfmpegError>): void {
    internal.job.state = 'failed';
    internal.job.error = error;
    internal.job.finishedAt = Date.now();
    this.emitLog(internal, `✘ ${error.message}`);
    this.emitUpdate(internal);
  }

  /* ----------------------------- 操作 ----------------------------- */

  cancel(jobId: string): boolean {
    const internal = this.jobs.get(jobId);
    if (!internal) return false;
    const { job } = internal;

    if (job.state === 'queued') {
      job.state = 'canceled';
      job.finishedAt = Date.now();
      this.queue = this.queue.filter((id) => id !== jobId);
      this.emitUpdate(internal);
      return true;
    }
    if (job.state === 'running' && internal.process) {
      internal.process.cancel();
      this.emitLog(internal, '正在停止 ffmpeg 进程…');
      return true;
    }
    return false;
  }

  async retry(jobId: string): Promise<MediaJob | null> {
    const internal = this.jobs.get(jobId);
    if (!internal) return null;
    if (internal.job.state === 'running' || internal.job.state === 'queued') return internal.job;

    // 重试时若原输出文件已被占用/已存在，重新算一个可用路径
    const preset = findPreset(internal.options.presetId);
    if (preset) {
      internal.job.outputPath = await this.resolveOutputPath(
        internal.probe,
        internal.options,
        this.extensionFor(internal.options.presetId),
        true,
      );
    }
    internal.job.state = 'queued';
    internal.job.error = null;
    internal.job.progress = null;
    internal.job.startedAt = null;
    internal.job.finishedAt = null;
    internal.job.outputSizeBytes = null;
    this.queue.push(jobId);
    this.emitUpdate(internal);
    this.pump();
    return { ...internal.job };
  }

  async remove(jobId: string): Promise<boolean> {
    const internal = this.jobs.get(jobId);
    if (!internal) return false;
    if (internal.job.state === 'running') this.cancel(jobId);
    this.jobs.delete(jobId);
    this.queue = this.queue.filter((id) => id !== jobId);
    return true;
  }

  clearFinished(): number {
    let removed = 0;
    for (const [id, internal] of this.jobs) {
      const s = internal.job.state;
      if (s === 'done' || s === 'failed' || s === 'canceled') {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  cancelAll(): number {
    let n = 0;
    for (const [id, internal] of this.jobs) {
      if (internal.job.state === 'running' || internal.job.state === 'queued') {
        if (this.cancel(id)) n++;
      }
    }
    return n;
  }

  /* ----------------------------- 工具 ----------------------------- */

  /** 预设 → 输出扩展名 */
  private extensionFor(presetId: string): string {
    const preset = findPreset(presetId);
    const ext = preset ? CONTAINERS[preset.container].extension : '';
    return ext || 'mp4';
  }

  private async resolveOutputPath(
    probe: MediaProbeResult,
    options: ConversionOptions,
    extension: string,
    forceUnique = false,
  ): Promise<string> {
    const dir = options.outputDir ?? path.dirname(probe.path);
    const rendered = renderTemplate(options.fileNameTemplate, {
      name: path.basename(probe.fileName, path.extname(probe.fileName)),
      preset: findPreset(options.presetId)?.label ?? options.presetId,
      date: new Date().toISOString().slice(0, 10),
      index: '',
    });
    const safeName = sanitizeFileName(rendered) || 'output';
    const target = path.join(dir, `${safeName}.${extension}`);

    if (forceUnique || !existsSync(target)) return target;

    // 自动改名，避免覆盖用户已有文件
    for (let i = 1; i <= 999; i++) {
      const candidate = path.join(dir, `${safeName} (${i}).${extension}`);
      if (!existsSync(candidate)) return candidate;
    }
    return path.join(dir, `${safeName} (${Date.now()}).${extension}`);
  }

  private requireFfprobe(): string {
    const p = this.ffprobePath;
    if (!p) throw new Error('找不到 ffprobe，无法读取视频信息。请到「设置」里指定路径。');
    return p;
  }

  setFfprobePath(p: string | null): void {
    this.ffprobePath = p;
  }

  /** 取消时清理半成品输出（否则用户会看到一堆 0 字节文件） */
  private async cleanupPartial(outputPath: string): Promise<void> {
    try {
      const st = await safeStat(outputPath);
      if (st) await fsp.unlink(outputPath);
    } catch {
      /* 忽略：文件可能已被 ffmpeg 删除 */
    }
  }

  private trimHistory(): void {
    if (this.jobs.size <= MAX_HISTORY) return;
    const finished = [...this.jobs.values()]
      .filter((j) => j.job.state === 'done' || j.job.state === 'failed' || j.job.state === 'canceled')
      .sort((a, b) => a.job.createdAt - b.job.createdAt);
    let toRemove = this.jobs.size - MAX_HISTORY;
    for (const j of finished) {
      if (toRemove <= 0) break;
      this.jobs.delete(j.job.id);
      toRemove--;
    }
  }

  private emitUpdate(internal: InternalJob): void {
    this.emit('updated', { ...internal.job });
  }

  private emitLog(internal: InternalJob, line: string): void {
    this.emit('log', { jobId: internal.job.id, line });
  }
}

/* ----------------------------- 纯函数工具 ----------------------------- */

/** 有效时长（考虑裁剪） */
function effectiveDuration(total: number, options: ConversionOptions): number {
  const start = options.trimStartSec ?? 0;
  const end = options.trimEndSec ?? total;
  return Math.max(0, end - start);
}

export function renderTemplate(
  template: string,
  vars: { name: string; preset: string; date: string; index: string },
): string {
  return template
    .replace(/\{name\}/g, vars.name)
    .replace(/\{preset\}/g, vars.preset)
    .replace(/\{date\}/g, vars.date)
    .replace(/\{index\}/g, vars.index);
}

/** 去掉 Windows 文件名里的非法字符，避免用户输入模板后转换直接失败 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
    .trim();
}

function formatCommand(bin: string, args: string[]): string {
  const quoted = [bin, ...args].map((a) => (/[\s"&|<>^()]/.test(a) ? `"${a}"` : a));
  return `> ${quoted.join(' ')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

async function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * 目标目录所在磁盘剩余空间。
 * 用 fs.statfs（Node 18.15+）实现，跨平台且不需要调用 wmic/powershell。
 */
export async function freeSpaceOf(dir: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}
