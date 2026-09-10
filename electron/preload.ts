/**
 * 预加载脚本：渲染进程与主进程之间唯一的桥。
 *
 * 安全约束：渲染进程不开 nodeIntegration，只通过这里暴露的白名单方法通信。
 * 所有返回值都包在 { ok, data | error } 里，避免异常跨进程后只剩
 * "Error invoking remote method" 这种没用的信息。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AppSettings,
  ConverterApi,
  CreateJobRequest,
  CreateJobResult,
  FfmpegDetectResult,
  IpcResponse,
  MediaJob,
  MediaProbeResult,
  SystemCapabilities,
  ThumbnailResult,
} from '../shared/types';

async function call<T>(channel: string, ...args: unknown[]): Promise<IpcResponse<T>> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ConverterApi = {
  probe: (p) => call<MediaProbeResult>('media:probe', p),
  pickVideoFiles: () => call<string[]>('dialog:pick-videos').then((r) => (r.ok ? r.data : [])),
  pickOutputDir: () => call<string | null>('dialog:pick-output-dir').then((r) => (r.ok ? r.data : null)),
  pickExecutable: () => call<string | null>('dialog:pick-executable').then((r) => (r.ok ? r.data : null)),
  clearThumbnailCache: () => call<number>('cache:clear-thumbnails'),
  revealInFolder: (p) => ipcRenderer.invoke('shell:reveal', p) as Promise<void>,
  pathsForFiles: (dropped: File[]) => {
    const out: string[] = [];
    for (const f of dropped) {
      try {
        // webUtils 只能在渲染进程同步调用，且必须在 drop 事件本次任务内完成
        const p = webUtils.getPathForFile(f);
        if (p) out.push(p);
      } catch {
        /* 非本地文件（例如从浏览器拖来的虚拟文件）会抛错，忽略即可 */
      }
    }
    return out;
  },
  thumbnail: (p, atSec) => call<ThumbnailResult>('media:thumbnail', p, atSec),
  getCapabilities: (forceRefresh) =>
    call<SystemCapabilities>('capabilities:get', Boolean(forceRefresh)),
  detectFfmpeg: () => call<FfmpegDetectResult>('ffmpeg:detect'),

  getSettings: () => call<AppSettings>('settings:get'),
  saveSettings: (patch) => call<AppSettings>('settings:save', patch),
  resetSettings: () => call<AppSettings>('settings:reset'),

  createJobs: (requests: CreateJobRequest[]) => call<CreateJobResult[]>('jobs:create', requests),
  listJobs: () => call<MediaJob[]>('jobs:list'),
  cancelJob: (id) => call<boolean>('jobs:cancel', id),
  cancelAllJobs: () => call<number>('jobs:cancel-all'),
  retryJob: (id) => call<MediaJob | null>('jobs:retry', id),
  removeJob: (id) => call<boolean>('jobs:remove', id),
  clearFinished: () => call<number>('jobs:clear-finished'),
  openOutput: (id) => call<boolean>('jobs:open-output', id),

  getPresets: () => call<unknown>('presets:get'),

  windowMinimize: () => {
    void ipcRenderer.invoke('window:minimize');
  },
  windowMaximize: () => ipcRenderer.invoke('window:maximize') as Promise<boolean>,
  windowClose: () => {
    void ipcRenderer.invoke('window:close');
  },

  onJobUpdated: (cb) => subscribe<MediaJob>('job:updated', cb),
  onJobLog: (cb) => subscribe<{ jobId: string; line: string }>('job:log', cb),
  onCapabilitiesUpdated: (cb) => subscribe<SystemCapabilities>('capabilities:updated', cb),
};

contextBridge.exposeInMainWorld('converter', api);

/** 让渲染进程知道自己在开发态还是打包态（用于显示调试入口） */
contextBridge.exposeInMainWorld('appEnv', {
  isDev: process.env.LUMEN_DEV === '1',
  platform: process.platform,
});
