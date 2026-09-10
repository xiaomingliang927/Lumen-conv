/**
 * 渲染进程全局类型声明：把 preload 暴露的 API 挂到 window 上，让 TS 认识它。
 */
import type { ConverterApi } from '@shared/types';

declare global {
  interface Window {
    converter: ConverterApi;
    appEnv: { isDev: boolean; platform: string };
  }
}

export {};
