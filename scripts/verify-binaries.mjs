/**
 * 校验 ffmpeg / ffprobe 二进制是否就位，并打印它们的版本与关键能力。
 *
 * 只报告、不抛错阻塞安装：缺失时应用仍能启动，
 * 并在「设置 → 运行环境」里提供「手动指定路径」兜底通道。
 */
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const binaries = [
  ['ffmpeg', path.join(root, 'resources', 'bin', 'ffmpeg.exe'), ['-hide_banner', '-version']],
  ['ffprobe', path.join(root, 'resources', 'bin', 'ffprobe.exe'), ['-hide_banner', '-version']],
];

let missing = 0;
console.log('[verify-binaries] 检查随项目分发的 ffmpeg 二进制 …');

for (const [name, abs, args] of binaries) {
  if (!existsSync(abs)) {
    missing++;
    console.warn(`  ✘ ${name.padEnd(8)} 缺失：${path.relative(root, abs)}`);
    continue;
  }
  const mb = (statSync(abs).size / 1024 / 1024).toFixed(1);
  const res = spawnSync(abs, args, { encoding: 'utf8', windowsHide: true });
  const firstLine = (res.stdout || res.stderr || '').split(/\r?\n/)[0]?.trim() ?? '';
  const version = /version\s+(\S+)/.exec(firstLine)?.[1] ?? '未知版本';
  console.log(`  ✔ ${name.padEnd(8)} ${version}  (${mb} MB)`);
}

if (missing > 0) {
  console.warn(
    `\n[verify-binaries] ${missing} 个二进制缺失。\n` +
      '  请执行：node scripts/fetch-binaries.mjs\n' +
      '  或在应用内「设置 → 运行环境」手动指定已有的 ffmpeg 路径。\n',
  );
} else {
  console.log('[verify-binaries] 全部就位。\n');
}
