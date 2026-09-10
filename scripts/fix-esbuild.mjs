/**
 * 修复 esbuild 的平台二进制与 .bin 垫片。
 *
 * 背景（真实踩坑）：esbuild 的主包只带 JS，真正的可执行文件由
 * 平台子包（@esbuild/win32-x64）提供，再由主包的 postinstall 复制到
 * node_modules/esbuild/bin/。当 npm install 因为网络或权限中断时，
 * 子包已经解包、但复制这一步没执行，于是任何构建都会报：
 *     Error: spawn EPERM  (esbuild/lib/main.js ensureServiceIsRunning)
 * 这个错误看起来像沙箱/权限问题，实际只是二进制不在预期位置。
 *
 * 本脚本把子包里的二进制补到主包预期位置，并生成 node_modules/.bin 垫片，
 * 使 `npx vite` / `npm run build` 能正常工作。可重复执行（幂等）。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');

function log(msg) {
  console.log(`[fix-esbuild] ${msg}`);
}

/* ---------------------- 1. 补 esbuild 可执行文件 ---------------------- */

const esbuildDir = path.join(nm, 'esbuild');
if (!existsSync(esbuildDir)) {
  log('未安装 esbuild，跳过');
  process.exit(0);
}

const exeName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
const binDir = path.join(esbuildDir, 'bin');
const binTarget = path.join(binDir, exeName);

/** 平台包目录名：linux 下可能是 linux-x64 或 linux-x64-musl */
function platformPkgCandidates() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const base = `${process.platform}-${arch}`;
  const list = [base];
  if (process.platform === 'linux') list.push(`${base}-musl`);
  return list;
}

function findPlatformBinary() {
  const scope = path.join(nm, '@esbuild');
  if (!existsSync(scope)) return null;
  for (const pkg of platformPkgCandidates()) {
    const p = path.join(scope, pkg, exeName);
    if (existsSync(p)) return p;
  }
  // 兜底：扫一遍 @esbuild 下的所有平台包
  for (const entry of readdirSync(scope)) {
    const p = path.join(scope, entry, exeName);
    if (existsSync(p)) return p;
  }
  return null;
}

if (existsSync(binTarget)) {
  log(`esbuild 二进制已就位：${path.relative(root, binTarget)}`);
} else {
  const source = findPlatformBinary();
  if (!source) {
    log(`✘ 找不到平台二进制（@esbuild/${platformPkgCandidates()[0]}/${exeName} 缺失）`);
    log('  请执行 node scripts/install.mjs 重新安装依赖。');
    process.exit(1);
  }
  mkdirSync(binDir, { recursive: true });
  copyFileSync(source, binTarget);
  try {
    chmodSync(binTarget, 0o755);
  } catch {
    /* Windows 上不需要 */
  }
  // esbuild 的 JS 通过 path.txt 读取二进制相对路径
  writeFileSync(path.join(esbuildDir, 'path.txt'), path.join('bin', exeName), 'utf8');
  log(`已从 ${path.relative(root, source)} 补齐 esbuild 二进制`);
}

/* ------------------------- 2. 补 .bin 垫片 ------------------------- */

const dotBin = path.join(nm, '.bin');
mkdirSync(dotBin, { recursive: true });

/** 生成 win/posix 两套垫片，直接转发到包的 CLI 入口 */
function makeShim(name, cliRelPath) {
  const cliAbs = path.join(nm, cliRelPath);
  if (!existsSync(cliAbs)) return false;

  const cmd = `@ECHO off\r\nSETLOCAL\r\nnode "%~dp0\\..\\${cliRelPath.replace(/\//g, '\\')}" %*\r\n`;
  const ps1 = `#!/usr/bin/env pwsh\nnode "$PSScriptRoot/../${cliRelPath}" $args\n`;
  const sh = `#!/bin/sh\nnode "$(dirname "$0")/../${cliRelPath}" "$@"\n`;

  writeFileSync(path.join(dotBin, `${name}.cmd`), cmd, 'utf8');
  writeFileSync(path.join(dotBin, name), sh, 'utf8');
  writeFileSync(path.join(dotBin, `${name}.ps1`), ps1, 'utf8');
  try {
    chmodSync(path.join(dotBin, name), 0o755);
  } catch {
    /* Windows */
  }
  return true;
}

const shims = [
  ['esbuild', 'esbuild/bin/esbuild'],
  ['vite', 'vite/bin/vite.js'],
  ['tsc', 'typescript/bin/tsc'],
  ['vue-tsc', 'vue-tsc/bin/vue-tsc.js'],
  ['electron', 'electron/cli.js'],
  ['electron-builder', 'electron-builder/cli.js'],
  ['concurrently', 'concurrently/dist/bin/concurrently.js'],
];

const made = [];
for (const [name, rel] of shims) {
  if (makeShim(name, rel)) made.push(name);
}
log(`已生成垫片：${made.join(', ')}`);

/* ------------------------- 3. 自检 ------------------------- */

try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(binTarget, ['--version'], { encoding: 'utf8', windowsHide: true });
  log(`esbuild 自检通过：v${out.trim()}`);
} catch (err) {
  log(`✘ esbuild 自检失败：${err.message}`);
  process.exit(1);
}
