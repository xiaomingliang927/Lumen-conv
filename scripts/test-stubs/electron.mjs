/**
 * electron 模块桩：仅供 Node 环境下的自动化测试使用（scripts/smoke-test.mjs）。
 *
 * 为什么需要它：产品代码里 electron/ffmpeg/thumbnail.ts → binaries.ts 会 import { app }，
 * 而 Node 直接跑这些模块时没有 electron 运行时。esbuild 打包测试时把
 * 'electron' 别名指向本文件，就能在纯 Node 下复用同一份产品代码，
 * 从而保证「测试跑的是产品代码」而不是另写一份实现。
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandboxRoot = path.join(os.tmpdir(), 'lumen-conv-test');

export const app = {
  getPath(name) {
    const p = path.join(sandboxRoot, name);
    mkdirSync(p, { recursive: true });
    return p;
  },
  getAppPath() {
    return process.cwd();
  },
};

export default { app };
