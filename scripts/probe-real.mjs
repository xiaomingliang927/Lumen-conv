/**
 * 真实素材端到端验证。
 *
 * 与 scripts/smoke-test.mjs 的分工：
 *   smoke-test  用合成的彩条/正弦音，画面干净、无旋转、无字幕、无多音轨 —— 快、稳、覆盖主流程；
 *   本脚本      专门用**模拟真实世界**的素材跑探测 + 转换 + 产物回读，
 *               用来暴露"干净素材测不出来"的问题（这也是用户反馈逼出来的教训）。
 *
 * 素材清单（生成方式见 test-assets/generate-samples.mjs）：
 *   rot90.mp4          显示矩阵旋转 90° → 验证「自动转正」
 *   vfr-screen.mp4     可变帧率录屏
 *   我的 测试 视频.mp4  文件名含中文与空格
 *   subs-multi.mkv     两条软字幕（chi/eng）
 *   multi-audio.mkv    两条音轨（5.1 AC3 + 立体声 AAC）
 *   very-short.mp4     0.8 秒，测边界
 *   uhd-4k.mp4         3840×2160，测缩放
 *   sample-audio.mp3   纯音频
 *   broken.mp4 / empty.mp4  损坏与空文件
 *
 * 用法：
 *   node scripts/probe-real.mjs            只探测 + 行为检查
 *   node scripts/probe-real.mjs --convert  额外跑一遍真实转换矩阵
 */
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fsp, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(root, 'resources', 'bin', 'ffprobe.exe');
const SAMPLES = path.join(root, 'test-assets', 'samples');
const OUTPUT = path.join(root, 'test-assets', 'output-real');
const outdir = path.join(root, '.tmp-probe');
const doConvert = process.argv.includes('--convert');

async function loadModules() {
  await fsp.mkdir(outdir, { recursive: true });
  const built = {};
  for (const [name, rel] of Object.entries({
    probe: 'electron/ffmpeg/probe.ts',
    thumbnail: 'electron/ffmpeg/thumbnail.ts',
    commands: 'electron/ffmpeg/commands.ts',
  })) {
    const outfile = path.join(outdir, `${name}.mjs`);
    await build({
      entryPoints: [path.join(root, rel)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      alias: { electron: path.join(root, 'scripts', 'test-stubs', 'electron.mjs') },
      logLevel: 'error',
    });
    built[name] = await import(pathToFileURL(outfile).href);
  }
  return built;
}

const mods = await loadModules();
await fsp.mkdir(OUTPUT, { recursive: true });

/** 探测用的完整选项（真实素材默认值） */
const baseOptions = {
  presetId: 'mp4-compatible',
  videoCodecId: 'h264',
  audioCodecId: 'aac',
  qualityId: 'tiny',
  resolutionId: 'source',
  fpsId: 'source',
  sizeLimitMb: null,
  deviceId: null,
  useCaseId: null,
  outputDir: OUTPUT,
  fileNameTemplate: 'out-{name}',
  overwrite: false,
  keepMetadata: true,
  trimStartSec: null,
  trimEndSec: null,
  subtitleStreamIndexes: [],
  audioStreamIndexes: [],
};

const files = [
  'rot90.mp4',
  'vfr-screen.mp4',
  '我的 测试 视频.mp4',
  'subs-multi.mkv',
  'multi-audio.mkv',
  'very-short.mp4',
  'uhd-4k.mp4',
  'sample-hevc.mkv',
  'sample-audio.mp3',
  'broken.mp4',
  'empty.mp4',
];

/* ------------------------------ 探测 ------------------------------ */

console.log('\n=== 探测（ffprobe → 结构化信息 + 缩略图） ===\n');
const probes = new Map();

for (const name of files) {
  const p = path.join(SAMPLES, name);
  if (!existsSync(p)) {
    console.log(`  ${name.padEnd(22)} 素材不存在`);
    continue;
  }
  try {
    const probe = await mods.probe.probeMedia(p, { ffprobePath: FFPROBE });
    probes.set(name, probe);
    const v = probe.video.find((x) => !x.isAttachedPic);
    const thumb = await mods.thumbnail.getThumbnail(p, {
      ffmpegPath: FFMPEG,
      durationSec: probe.durationSec,
    });
    const thumbInfo = thumb.filePath
      ? `${(statSync(thumb.filePath).size / 1024).toFixed(0)}KB${thumb.cached ? '(缓存)' : ''}`
      : `失败(${(thumb.error ?? '').slice(0, 22)})`;

    console.log(
      `  ${name.padEnd(22)} ${(probe.durationSec.toFixed(2) + 's').padEnd(8)}` +
        `${(v ? `${v.displayWidth}×${v.displayHeight}` : '无视频').padEnd(12)}` +
        `原始${(v ? `${v.width}×${v.height}` : '—').padEnd(10)}` +
        `旋转${(v ? `${v.rotation}°` : '—').padEnd(6)}` +
        `${probe.audio.length}音${probe.subtitle.length}字`.padEnd(7) +
        `缩略图 ${thumbInfo}`,
    );
  } catch (err) {
    console.log(`  ${name.padEnd(22)} 抛错（预期内）：${err.message.slice(0, 56)}`);
  }
}

/* ------------------------------ 行为检查 ------------------------------ */

console.log('\n=== 关键行为检查 ===\n');
let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const rot = probes.get('rot90.mp4');
if (rot) {
  const v = rot.video[0];
  check(
    '旋转素材：原始尺寸与旋转角都读到了',
    v.rotation === 90 && v.width === 720 && v.height === 1280,
    `${v.width}×${v.height}, rotation=${v.rotation}°`,
  );
  check(
    '旋转素材：展示尺寸已按旋转校正（宽高互换）',
    v.displayWidth === 1280 && v.displayHeight === 720,
    `display=${v.displayWidth}×${v.displayHeight}`,
  );
  const built = mods.commands.buildCommand(baseOptions, {
    probe: rot,
    outputPath: path.join(OUTPUT, 'rot-check.mp4'),
  });
  const text = built.args.join(' ');
  const vf = /-vf\s+(\S+)/.exec(text)?.[1] ?? '';
  /*
   * 关键回归：**不应该**出现 transpose。
   *
   * ffmpeg 默认会自动应用显示矩阵并清除旋转标记，我们再手动转一次等于转两次，
   * 产物会退回竖版（720×1280）且不带旋转元数据，播放器里显示是横躺的。
   * 这个断言的作用是防止以后有人"顺手把 transpose 加回来"。
   */
  check(
    '旋转素材：命令里**没有**多余的 transpose（避免转两次）',
    !text.includes('transpose'),
    vf || '（无 -vf，符合预期）',
  );
  check(
    '旋转素材：给了用户提示说明已自动转正',
    built.notes.some((n) => n.includes('旋转')),
    built.notes.find((n) => n.includes('旋转')) ?? '无提示',
  );
}

const subs = probes.get('subs-multi.mkv');
if (subs) {
  check(
    '字幕素材：识别出 2 条字幕轨',
    subs.subtitle.length === 2,
    subs.subtitle.map((s) => `${s.codec}/${s.language ?? '?'}`).join(', '),
  );
  check(
    '字幕素材：识别为文本型字幕',
    subs.subtitle.every((s) => s.isTextBased),
    subs.subtitle.map((s) => s.codec).join(', '),
  );
}

const multi = probes.get('multi-audio.mkv');
if (multi) {
  check(
    '多音轨素材：识别出 2 条音轨',
    multi.audio.length === 2,
    multi.audio.map((a) => `${a.codec}/${a.channels}ch`).join(', '),
  );
  check(
    '多音轨素材：5.1 声道被正确识别',
    multi.audio.some((a) => a.channels === 6),
    multi.audio.map((a) => `${a.channels}ch`).join(', '),
  );
}

const cn = probes.get('我的 测试 视频.mp4');
check(
  '中文+空格文件名：探测正常',
  Boolean(cn),
  cn ? `${cn.durationSec.toFixed(2)}s ${cn.video[0].width}×${cn.video[0].height}` : '失败',
);

const uhd = probes.get('uhd-4k.mp4');
check('4K 素材：分辨率识别正确', uhd?.video[0].width === 3840, uhd ? `${uhd.video[0].width}×${uhd.video[0].height}` : '失败');

const short = probes.get('very-short.mp4');
check(
  '超短视频（0.8s）：时长识别正确',
  short ? Math.abs(short.durationSec - 0.8) < 0.2 : false,
  short ? `${short.durationSec.toFixed(2)}s` : '失败',
);

const audioOnly = probes.get('sample-audio.mp3');
check(
  '纯音频：判定 hasVideo=false 且音轨可读',
  audioOnly ? !audioOnly.hasVideo && audioOnly.audio.length === 1 : false,
  audioOnly ? audioOnly.audio[0].codec : '失败',
);

check('损坏文件：按预期抛出人类可读错误（未进入结果集）', !probes.has('broken.mp4'), '详见上面探测输出');
check('空文件：按预期抛出人类可读错误（未进入结果集）', !probes.has('empty.mp4'), '详见上面探测输出');

/* ------------------------------ 真实转换矩阵 ------------------------------ */

if (doConvert) {
  console.log('\n=== 真实转换矩阵（每种素材过一遍代表性预设，并回读产物） ===\n');

  const matrix = [
    {
      file: 'rot90.mp4',
      options: { ...baseOptions },
      outFile: 'rot90-to-mp4.mp4',
      expect: '应被转正（产物显示 1280×720）',
      verify: (p) => p.video[0].displayWidth === 1280 && p.video[0].displayHeight === 720,
    },
    {
      file: 'vfr-screen.mp4',
      options: { ...baseOptions, audioCodecId: 'none' },
      outFile: 'vfr-to-mp4.mp4',
      expect: 'VFR 也能正常转出',
      verify: (p) => p.hasVideo,
    },
    {
      file: '我的 测试 视频.mp4',
      options: { ...baseOptions },
      outFile: 'cn-name-to-mp4.mp4',
      expect: '中文/空格路径全程可用',
      verify: (p) => p.hasVideo && p.hasAudio,
    },
    {
      file: 'subs-multi.mkv',
      // 要保留字幕必须显式传入字幕轨索引（默认不保留，避免无意识撑大产物）
      options: { ...baseOptions, presetId: 'mkv-archive' },
      subtitleIndexesFromProbe: true,
      outFile: 'subs-to-mkv.mkv',
      expect: 'MKV 预设 + 勾选字幕 → 保留 2 条',
      verify: (p) => p.subtitle.length === 2,
    },
    {
      file: 'multi-audio.mkv',
      options: { ...baseOptions },
      outFile: 'multiaudio-to-mp4.mp4',
      expect: '默认只取第一条音轨（输出 1 条）',
      verify: (p) => p.audio.length === 1,
    },
    {
      file: 'very-short.mp4',
      options: { ...baseOptions, audioCodecId: 'none' },
      outFile: 'short-to-mp4.mp4',
      expect: '0.8s 短片不报错',
      verify: (p) => p.durationSec > 0.3,
    },
    {
      file: 'uhd-4k.mp4',
      options: { ...baseOptions, audioCodecId: 'none', resolutionId: '1080p' },
      outFile: 'uhd-to-1080p.mp4',
      expect: '4K 缩到 1080p',
      verify: (p) => p.video[0].displayHeight === 1080,
    },
    {
      file: 'sample-hevc.mkv',
      options: { ...baseOptions },
      outFile: 'hevc-to-h264.mp4',
      expect: 'HEVC → H.264',
      verify: (p) => p.video[0].codec === 'h264',
    },
    {
      file: 'sample-audio.mp3',
      options: { ...baseOptions, presetId: 'audio-m4a', videoCodecId: null, audioCodecId: 'aac' },
      outFile: 'audio-to-m4a.m4a',
      expect: 'MP3 → M4A',
      verify: (p) => !p.hasVideo && p.hasAudio,
    },
  ];

  for (const item of matrix) {
    const probe = probes.get(item.file);
    if (!probe) {
      console.log(`  ${item.file.padEnd(22)} 跳过（探测失败）`);
      continue;
    }
    const out = path.join(OUTPUT, item.outFile);
    try {
      await fsp.rm(out, { force: true });
    } catch {
      /* 忽略 */
    }

    // 需要保留字幕的用例：把探测到的字幕轨索引填进去（默认是空数组 = 不保留）
    const options = item.subtitleIndexesFromProbe
      ? { ...item.options, subtitleStreamIndexes: probe.subtitle.map((s) => s.index) }
      : item.options;

    const built = mods.commands.buildCommand(options, { probe, outputPath: out });
    const t0 = Date.now();
    const res = spawnSync(FFMPEG, built.args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    const ms = Date.now() - t0;

    if (res.status !== 0 || !existsSync(out)) {
      fail++;
      const lastLine = (res.stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
      console.log(`  ✘ ${item.file.padEnd(22)} 转换失败：${lastLine.slice(0, 66)}`);
      continue;
    }

    try {
      const p2 = await mods.probe.probeMedia(out, { ffprobePath: FFPROBE });
      const ok = item.verify(p2);
      if (ok) pass++;
      else fail++;
      const v2 = p2.video.find((x) => !x.isAttachedPic);
      console.log(
        `  ${ok ? '✔' : '✘'} ${item.file.padEnd(22)} ` +
          `${(statSync(out).size / 1024).toFixed(0)}KB/${ms}ms ` +
          `${v2 ? `${p2.video[0].displayWidth}×${p2.video[0].displayHeight}` : '无视频'} ` +
          `${p2.audio.length}音${p2.subtitle.length}字  （${item.expect}）`,
      );
    } catch (err) {
      fail++;
      console.log(`  ✘ ${item.file.padEnd(22)} 产物无法回读：${err.message.slice(0, 60)}`);
    }
  }
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
console.log(`产物目录：${path.relative(root, OUTPUT)}${doConvert ? '' : '（未做转换，加 --convert 启用）'}\n`);

await fsp.rm(outdir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
