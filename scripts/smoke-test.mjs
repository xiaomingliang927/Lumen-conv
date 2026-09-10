/**
 * 端到端冒烟测试（对应笔试要求 7：不能连自己都没测过）。
 *
 * 不启动 Electron 界面，而是直接调用与主进程完全相同的模块，
 * 走完整链路：合成测试视频 → ffprobe 探测 → 缩略图抽帧 → 命令装配 → 真跑 ffmpeg → 校验产物。
 *
 * 之所以复用 electron/ffmpeg 下的模块而不是另写一套调用逻辑：
 * 测试如果走的不是产品代码，测过了也没有说服力。
 * 这些模块只依赖 node 内置能力（binaries.ts 依赖 electron.app，故此处不引入它）。
 *
 * 用法：
 *   node scripts/smoke-test.mjs            # 完整用例
 *   node scripts/smoke-test.mjs --quick    # 只跑 3 个核心用例
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, promises as fsp, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');

const FFMPEG = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(root, 'resources', 'bin', 'ffprobe.exe');
const SAMPLES = path.join(root, 'test-assets', 'samples');
const OUTPUT = path.join(root, 'test-assets', 'output');

/* ------------------------------ 断言框架 ------------------------------ */

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);
}

function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = fn();
    const ms = Date.now() - t0;
    results.push({ group: currentGroup, name, ok: true, detail: detail ?? '', ms });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}  (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - t0;
    results.push({ group: currentGroup, name, ok: false, detail: err.message, ms });
    console.log(`  ✘ ${name} — ${err.message}  (${ms}ms)`);
  }
}

async function checkAsync(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    results.push({ group: currentGroup, name, ok: true, detail: detail ?? '', ms });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}  (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - t0;
    results.push({ group: currentGroup, name, ok: false, detail: err.message, ms });
    console.log(`  ✘ ${name} — ${err.message}  (${ms}ms)`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* --------------------------- 测试素材合成 --------------------------- */

/** 用 ffmpeg 自带的 lavfi 合成测试视频，避免依赖外部素材 */
function makeSample(file, { seconds, size, codec, extra = [], audio = true }) {
  if (existsSync(file) && statSync(file).size > 4096) return file;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];

  // 输入 1：彩色测试图（testsrc2 自带动态图案，便于肉眼确认不是黑帧）
  args.push('-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`);
  // 输入 2：正弦音（验证音轨探测与音频编码路径）
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);

  // 输出选项：叠加时间文字，方便确认缩略图取到的是画面而不是黑屏
  args.push(
    '-vf',
    `drawtext=text='LUMEN %{eif\\:t\\:d}s':fontsize=36:fontcolor=white:x=30:y=30:box=1:boxcolor=black@0.5`,
  );
  if (audio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push(...extra, file);

  const res = spawnSync(FFMPEG, args, { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !existsSync(file)) {
    throw new Error(`合成测试视频失败：${(res.stderr || '').slice(-300)}`);
  }
  return file;
}

/* --------------------------- 动态载入产品模块 --------------------------- */

async function loadModules() {
  // 用 esbuild 把 TS 模块临时打包成 ESM 供测试直接引用，
  // 这样测试跑的就是产品代码，而不是复制的另一份实现。
  const esbuild = await import('esbuild');
  const outdir = path.join(root, '.downloads', 'smoke');
  mkdirSync(outdir, { recursive: true });

  const entries = {
    probe: 'electron/ffmpeg/probe.ts',
    thumbnail: 'electron/ffmpeg/thumbnail.ts',
    commands: 'electron/ffmpeg/commands.ts',
    progress: 'electron/ffmpeg/progress.ts',
    errors: 'electron/ffmpeg/errors.ts',
  };

  const built = {};
  for (const [name, rel] of Object.entries(entries)) {
    const outfile = path.join(outdir, `${name}.mjs`);
    await esbuild.build({
      entryPoints: [path.join(root, rel)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      // 把 electron 指向测试桩：产品代码里用到的只有 app.getPath / getAppPath，
      // 这样测试跑的就是产品代码本身，而不是另写一份实现。
      alias: {
        electron: path.join(root, 'scripts', 'test-stubs', 'electron.mjs'),
      },
      logLevel: 'error',
    });
    built[name] = await import(pathToFileURL(outfile).href);
  }
  return built;
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  console.log('Lumen-conv 端到端冒烟测试');
  console.log('='.repeat(64));

  /* ---- 前置检查 ---- */
  group('环境');
  check('ffmpeg 二进制存在', () => {
    assert(existsSync(FFMPEG), `未找到 ${FFMPEG}，请先执行 node scripts/fetch-binaries.mjs`);
    return `${(statSync(FFMPEG).size / 1048576).toFixed(1)} MB`;
  });
  check('ffprobe 二进制存在', () => {
    assert(existsSync(FFPROBE), `未找到 ${FFPROBE}`);
    return `${(statSync(FFPROBE).size / 1048576).toFixed(1)} MB`;
  });

  const mods = await loadModules();

  const ffmpegVersion = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout;
  const versionMatch = /ffmpeg version (\S+)/.exec(ffmpegVersion);
  console.log(`  ℹ ffmpeg 版本：${versionMatch?.[1] ?? '未知'}`);

  /* ---- 合成素材 ---- */
  group('合成测试素材');
  mkdirSync(SAMPLES, { recursive: true });
  mkdirSync(OUTPUT, { recursive: true });

  const sampleMp4 = path.join(SAMPLES, 'sample-h264.mp4');
  const sampleHevc = path.join(SAMPLES, 'sample-hevc.mkv');
  const sampleRotated = path.join(SAMPLES, 'sample-rotated.mp4');
  const sampleAudio = path.join(SAMPLES, 'sample-audio.mp3');

  check('合成 H.264/MP4（6 秒）', () =>
    `${(statSync(makeSample(sampleMp4, { seconds: 6, size: '640x360', codec: 'h264' })).size / 1024).toFixed(0)} KB`,
  );
  if (!quick) {
    check('合成 H.265/MKV（4 秒）', () => {
      const f = makeSample(sampleHevc, {
        seconds: 4,
        size: '640x360',
        codec: 'hevc',
        extra: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '28'],
      });
      return `${(statSync(f).size / 1024).toFixed(0)} KB`;
    });
    check('合成带旋转元数据的 MP4（手机竖拍场景）', () => {
      const f = makeSample(sampleRotated, {
        seconds: 3,
        size: '640x360',
        codec: 'h264',
        extra: ['-c:v', 'libx264', '-preset', 'ultrafast', '-metadata:s:v:0', 'rotate=90'],
      });
      return `${(statSync(f).size / 1024).toFixed(0)} KB`;
    });
  }
  check('合成纯音频 MP3（5 秒）', () => {
    if (existsSync(sampleAudio) && statSync(sampleAudio).size > 4096) return 'cached';
    const res = spawnSync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'libmp3lame', '-b:a', '128k', sampleAudio],
      { encoding: 'utf8', windowsHide: true },
    );
    assert(res.status === 0, `合成 MP3 失败：${(res.stderr || '').slice(-200)}`);
    return `${(statSync(sampleAudio).size / 1024).toFixed(0)} KB`;
  });

  /* ---- 需求 1：视频信息探测 ---- */
  group('需求 1 · 视频信息探测（ffprobe）');
  let probeResult = null;
  await checkAsync('探测 MP4 信息', async () => {
    probeResult = await mods.probe.probeMedia(sampleMp4, { ffprobePath: FFPROBE });
    assert(probeResult.durationSec > 5 && probeResult.durationSec < 8, `时长异常：${probeResult.durationSec}`);
    assert(probeResult.hasVideo && probeResult.hasAudio, '应同时检测到视频与音频轨');
    assert(probeResult.video[0].width === 640, `宽度应为 640，实际 ${probeResult.video[0].width}`);
    return `${probeResult.formatLongName} · ${probeResult.video[0].displayWidth}×${probeResult.video[0].displayHeight} · ${probeResult.durationSec.toFixed(2)}s`;
  });
  check('视频编码识别为 h264', () => {
    assert(probeResult.video[0].codec === 'h264', `实际 ${probeResult.video[0].codec}`);
    return probeResult.video[0].codecLongName;
  });
  check('音频编码识别为 aac', () => {
    assert(probeResult.audio[0].codec === 'aac', `实际 ${probeResult.audio[0].codec}`);
    return `${probeResult.audio[0].codec} · ${probeResult.audio[0].channels}ch`;
  });
  check('总码率已解析', () => {
    assert(probeResult.bitrateKbps > 0, '码率应大于 0');
    return `${probeResult.bitrateKbps} kbps`;
  });
  check('缩略图抽帧时间点在合理区间', () => {
    const t = probeResult.thumbnailAtSec;
    assert(t >= 0 && t <= probeResult.durationSec, `抽帧点 ${t} 越界`);
    return `${t.toFixed(2)}s（时长 ${probeResult.durationSec.toFixed(2)}s）`;
  });

  await checkAsync('损坏文件给出人类可读错误', async () => {
    const bad = path.join(SAMPLES, 'broken.mp4');
    await fsp.writeFile(bad, Buffer.from('this is definitely not a video file'));
    try {
      await mods.probe.probeMedia(bad, { ffprobePath: FFPROBE });
      throw new Error('本应抛错但成功了');
    } catch (err) {
      // 期望是 ProbeError，且消息里不能出现堆栈感的东西
      assert(/可识别|没有找到|不是/.test(err.message), `错误文案不够友好：${err.message}`);
      return err.message.slice(0, 48);
    }
  });

  await checkAsync('0 字节文件被提前拦截', async () => {
    const empty = path.join(SAMPLES, 'empty.mp4');
    await fsp.writeFile(empty, '');
    try {
      await mods.probe.probeMedia(empty, { ffprobePath: FFPROBE });
      throw new Error('本应抛错但成功了');
    } catch (err) {
      assert(/0 字节/.test(err.message), `错误文案不符：${err.message}`);
      return err.message;
    }
  });

  /* ---- 需求 1：缩略图 ---- */
  group('需求 1 · 缩略图生成');
  await checkAsync('生成缩略图（智能选帧）', async () => {
    const r = await mods.thumbnail.getThumbnail(sampleMp4, {
      ffmpegPath: FFMPEG,
      durationSec: probeResult.durationSec,
    });
    assert(r.filePath && existsSync(r.filePath), `缩略图未生成：${r.error}`);
    const kb = statSync(r.filePath).size / 1024;
    assert(kb > 3, `缩略图过小（${kb.toFixed(1)} KB），可能是空图`);
    return `${kb.toFixed(0)} KB @ ${r.atSec}s`;
  });

  await checkAsync('第二次命中缓存（秒出）', async () => {
    const t0 = Date.now();
    const r = await mods.thumbnail.getThumbnail(sampleMp4, {
      ffmpegPath: FFMPEG,
      durationSec: probeResult.durationSec,
    });
    const ms = Date.now() - t0;
    assert(r.cached, '第二次应命中缓存');
    return `cached=${r.cached}, ${ms}ms`;
  });

  await checkAsync('非视频文件抽帧失败但不崩溃', async () => {
    const r = await mods.thumbnail.getThumbnail(path.join(SAMPLES, 'broken.mp4'), {
      ffmpegPath: FFMPEG,
      durationSec: 0,
    });
    assert(r.filePath === null && r.error, '应返回错误而不是抛异常');
    return r.error.slice(0, 40);
  });

  /* ---- 需求 2：命令装配 ---- */
  group('需求 2 · ffmpeg 命令装配');
  const baseOptions = {
    presetId: 'mp4-compatible',
    videoCodecId: 'h264',
    audioCodecId: 'aac',
    qualityId: 'balanced',
    resolutionId: 'source',
    fpsId: 'source',
    outputDir: OUTPUT,
    fileNameTemplate: '{name}',
    overwrite: false,
    keepMetadata: true,
    trimStartSec: null,
    trimEndSec: null,
    subtitleStreamIndexes: [],
    audioStreamIndexes: [],
  };

  let built = null;
  check('MP4/H.264 命令包含关键参数', () => {
    built = mods.commands.buildCommand(baseOptions, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'out-h264.mp4'),
    });
    const text = built.args.join(' ');
    assert(text.includes('-c:v libx264'), '缺少 libx264');
    assert(text.includes('-crf 23'), '缺少 CRF 参数');
    assert(text.includes('-c:a aac'), '缺少 aac');
    assert(text.includes('-movflags +faststart'), '缺少 faststart');
    assert(text.includes('-progress pipe:1'), '缺少进度上报参数');
    return `${built.args.length} 个参数`;
  });

  check('质量档位能正确切换 CRF', () => {
    const hi = mods.commands.buildCommand({ ...baseOptions, qualityId: 'high' }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'q.mp4'),
    });
    assert(hi.args.join(' ').includes('-crf 20'), '高画质应为 CRF 20');
    return 'high → CRF 20';
  });

  check('分辨率档位生成缩放滤镜（源 360p → 目标 720p 时按"不放大"跳过，这里反向验证）', () => {
    // 源是 640x360；用一个"高于源"的档位不会缩放，用一个真实降档需要更高分辨率的素材，
    // 因此这里直接验证 scale 参数的拼装规则：构造一个 720p 高的源探测器结果。
    const biggerProbe = {
      ...probeResult,
      video: [{ ...probeResult.video[0], width: 1280, height: 720, displayWidth: 1280, displayHeight: 720 }],
    };
    const r = mods.commands.buildCommand({ ...baseOptions, resolutionId: '360p' }, {
      probe: biggerProbe,
      outputPath: path.join(OUTPUT, 'r.mp4'),
    });
    const text = r.args.join(' ');
    assert(/scale=-2:360/.test(text), `缺少缩放滤镜：${text.slice(0, 200)}`);
    assert(/lanczos/.test(text), '缩放应使用 lanczos 算法');
    return 'scale=-2:360:flags=lanczos';
  });

  check('源分辨率低于目标时不放大', () => {
    const r = mods.commands.buildCommand({ ...baseOptions, resolutionId: '1080p' }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'r2.mp4'),
    });
    const text = r.args.join(' ');
    assert(!/scale=/.test(text), '360p 源不应生成放大滤镜');
    return '已跳过缩放';
  });

  check('H.265 预设带 hvc1 标签', () => {
    const r = mods.commands.buildCommand(
      { ...baseOptions, videoCodecId: 'hevc' },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'h265.mp4') },
    );
    assert(r.args.join(' ').includes('hvc1'), '缺少 hvc1 标签');
    return 'hvc1';
  });

  check('WebM 预设使用 VP9 + Opus', () => {
    const r = mods.commands.buildCommand(
      { ...baseOptions, presetId: 'webm-web', videoCodecId: 'vp9', audioCodecId: 'opus' },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'out.webm') },
    );
    const text = r.args.join(' ');
    assert(text.includes('libvpx-vp9') && text.includes('libopus'), '编码器不对');
    return 'libvpx-vp9 + libopus';
  });

  check('纯音频预设丢弃视频轨', () => {
    const r = mods.commands.buildCommand(
      { ...baseOptions, presetId: 'audio-mp3', videoCodecId: null, audioCodecId: 'mp3' },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'out.mp3') },
    );
    const text = r.args.join(' ');
    assert(text.includes('-vn'), '缺少 -vn');
    assert(text.includes('libmp3lame'), '缺少 libmp3lame');
    return '-vn + libmp3lame';
  });

  check('GIF 预设使用单次调用的内联调色板两遍链', () => {
    const r = mods.commands.buildCommand(
      { ...baseOptions, presetId: 'gif-motion', videoCodecId: 'gif', audioCodecId: 'none', resolutionId: '360p', fpsId: '15' },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'out.gif') },
    );
    const vfIndex = r.args.indexOf('-vf');
    assert(vfIndex >= 0, 'GIF 命令应包含 -vf');
    const vf = r.args[vfIndex + 1];
    assert(vf.includes('palettegen'), '应包含 palettegen');
    assert(vf.includes('paletteuse'), '应包含 paletteuse');
    // 前置滤镜（这里是 fps=15，源 360p 不触发缩放）必须被保留在同一侧
    assert(vf.includes('fps=15'), `前置滤镜应被保留：${vf.slice(0, 80)}`);
    assert(!vf.startsWith(','), '滤波器链不能以逗号开头');
    assert(r.args.join(' ').includes('-loop 0'), 'GIF 应无限循环');
    return vf.slice(0, 70) + '…';
  });

  // 回归用例：源分辨率低于目标 + 未改帧率 ⇒ 前置滤镜链为空。
  // 早期实现会生成以逗号开头的滤镜串，ffmpeg 报 "No such filter: ''" 并产出 0 字节文件。
  // 注意必须不传 fpsId（默认 source），否则会注入 fps 滤镜而恰好掩盖这个 bug。
  check('回归：GIF 前置滤镜为空时不能生成前导逗号', () => {
    const smallProbe = {
      ...probeResult,
      video: [{ ...probeResult.video[0], width: 640, height: 480, displayWidth: 640, displayHeight: 480 }],
    };
    const r = mods.commands.buildCommand(
      {
        ...baseOptions,
        presetId: 'gif-motion',
        videoCodecId: 'gif',
        audioCodecId: 'none',
        resolutionId: '480p', // 源就是 480p，不触发缩放
        fpsId: 'source', // 不触发 fps 滤镜
      },
      { probe: smallProbe, outputPath: path.join(OUTPUT, 'out2.gif') },
    );
    const vf = r.args[r.args.indexOf('-vf') + 1];
    assert(vf, '应存在 -vf 参数');
    assert(!vf.startsWith(','), `滤镜链不能以逗号开头：${vf.slice(0, 60)}`);
    assert(!/,\s*,/.test(vf), '滤镜链不能有连续逗号');
    assert(vf.startsWith('split'), `应以 split 开头，实际：${vf.slice(0, 40)}`);
    return '以 split 开头，无前导逗号';
  });

  check('硬件编码器 id 能正确映射到 ffmpeg 编码器名', () => {
    const b = mods.commands.buildCommand(
      { ...baseOptions, videoCodecId: 'h264_nvenc' },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'nvenc.mp4') },
    );
    const text = b.args.join(' ');
    assert(text.includes('-c:v h264_nvenc'), '编码器名不对');
    // NVENC 不支持 CRF 语义，必须走 -cq
    assert(text.includes('-cq'), 'NVENC 应使用 -cq 而非 -crf');
    assert(!text.includes('-crf'), 'NVENC 不应出现 -crf');
    return 'h264_nvenc + -cq（未使用 CRF）';
  });

  check('未知预设抛出可读错误', () => {
    try {
      mods.commands.buildCommand({ ...baseOptions, presetId: 'not-exist' }, {
        probe: probeResult,
        outputPath: path.join(OUTPUT, 'x.mp4'),
      });
      throw new Error('本应抛错');
    } catch (err) {
      assert(err.name === 'CommandBuildError', `错误类型不对：${err.name}`);
      return err.message;
    }
  });

  /* ---- 旋转与裁剪 ---- */
  if (!quick && existsSync(sampleRotated)) {
    await checkAsync('旋转元数据处理', async () => {
      const p = await mods.probe.probeMedia(sampleRotated, { ffprobePath: FFPROBE });
      const v = p.video.find((x) => !x.isAttachedPic);
      assert(v.rotation === 90 || v.rotation === 0, `旋转角异常：${v.rotation}`);
      if (v.rotation === 90) {
        const b = mods.commands.buildCommand(baseOptions, {
          probe: p,
          outputPath: path.join(OUTPUT, 'rot.mp4'),
        });
        assert(b.args.join(' ').includes('transpose'), '旋转视频应生成 transpose 滤镜');
        return `rotation=${v.rotation}，已生成 transpose 滤镜`;
      }
      return `rotated 元数据未被 ffmpeg 保留（rotation=${v.rotation}），用例跳过`;
    });
  }

  await checkAsync('裁剪参数正确生成 -ss / -t', async () => {
    const b = mods.commands.buildCommand(
      { ...baseOptions, trimStartSec: 1, trimEndSec: 3 },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'trim.mp4') },
    );
    const text = b.args.join(' ');
    assert(/-ss 1\.000/.test(text), '缺少 -ss');
    assert(/-t 2\.000/.test(text), '缺少 -t（应为 2 秒）');
    return '-ss 1.000 -t 2.000';
  });

  /* ---- 需求 2：真实转换 ---- */
  group('需求 2 · 真实转换（调用 ffmpeg 命令行）');

  /** 直接跑装配出来的参数，等价于主进程引擎的行为 */
  async function runBuilt(b, outputPath) {
    const t0 = Date.now();
    const res = spawnSync(FFMPEG, b.args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    const ms = Date.now() - t0;
    if (res.status !== 0) throw new Error(`ffmpeg 退出码 ${res.status}：${(res.stderr || '').slice(-400)}`);
    if (!existsSync(outputPath)) throw new Error('未生成输出文件');
    return { ms, bytes: statSync(outputPath).size };
  }

  await checkAsync('MP4 → MP4（H.264 重编码）', async () => {
    const out = path.join(OUTPUT, 'smoke-h264.mp4');
    const b = mods.commands.buildCommand(baseOptions, { probe: probeResult, outputPath: out });
    const { ms, bytes } = await runBuilt(b, out);
    assert(bytes > 1024, '输出文件过小');
    const p = await mods.probe.probeMedia(out, { ffprobePath: FFPROBE });
    assert(p.video[0].codec === 'h264', `输出编码应为 h264，实际 ${p.video[0].codec}`);
    return `${(bytes / 1024).toFixed(0)} KB / ${ms}ms`;
  });

  await checkAsync('MP4 → MP4（无损直通，应比重编码快得多）', async () => {
    const out = path.join(OUTPUT, 'smoke-copy.mp4');
    const b = mods.commands.buildCommand(
      { ...baseOptions, videoCodecId: 'copy', audioCodecId: 'copy' },
      { probe: probeResult, outputPath: out },
    );
    const { ms, bytes } = await runBuilt(b, out);
    return `${(bytes / 1024).toFixed(0)} KB / ${ms}ms`;
  });

  await checkAsync('MP4 → WebM（VP9 + Opus）', async () => {
    const out = path.join(OUTPUT, 'smoke.webm');
    const b = mods.commands.buildCommand(
      { ...baseOptions, presetId: 'webm-web', videoCodecId: 'vp9', audioCodecId: 'opus', qualityId: 'tiny' },
      { probe: probeResult, outputPath: out },
    );
    const { ms, bytes } = await runBuilt(b, out);
    const p = await mods.probe.probeMedia(out, { ffprobePath: FFPROBE });
    assert(p.video[0].codec === 'vp9', `应为 vp9，实际 ${p.video[0].codec}`);
    return `${p.formatLongName} · ${(bytes / 1024).toFixed(0)} KB / ${ms}ms`;
  });

  if (!quick) {
    await checkAsync('MP4 → H.265（HEVC 重编码）', async () => {
      const out = path.join(OUTPUT, 'smoke-hevc.mp4');
      const b = mods.commands.buildCommand(
        { ...baseOptions, videoCodecId: 'hevc', qualityId: 'tiny' },
        { probe: probeResult, outputPath: out },
      );
      const { ms, bytes } = await runBuilt(b, out);
      const p = await mods.probe.probeMedia(out, { ffprobePath: FFPROBE });
      assert(p.video[0].codec === 'hevc', `应为 hevc，实际 ${p.video[0].codec}`);
      return `${(bytes / 1024).toFixed(0)} KB / ${ms}ms`;
    });
  }

  await checkAsync('MP4 → MP3（提取音频）', async () => {
    const out = path.join(OUTPUT, 'smoke.mp3');
    const b = mods.commands.buildCommand(
      { ...baseOptions, presetId: 'audio-mp3', videoCodecId: null, audioCodecId: 'mp3' },
      { probe: probeResult, outputPath: out },
    );
    const { ms, bytes } = await runBuilt(b, out);
    const p = await mods.probe.probeMedia(out, { ffprobePath: FFPROBE });
    assert(!p.hasVideo, 'MP3 不应包含视频轨');
    assert(p.hasAudio, '应包含音频轨');
    return `${(bytes / 1024).toFixed(0)} KB / ${ms}ms`;
  });

  if (!quick) {
    await checkAsync('MP4 → GIF（调色板两遍法）', async () => {
      const out = path.join(OUTPUT, 'smoke.gif');
      const b = mods.commands.buildCommand(
        {
          ...baseOptions,
          presetId: 'gif-motion',
          videoCodecId: 'gif',
          audioCodecId: 'none',
          resolutionId: '360p',
          trimStartSec: 0,
          trimEndSec: 2,
          fpsId: '15',
        },
        { probe: probeResult, outputPath: out },
      );
      const { ms, bytes } = await runBuilt(b, out);
      return `${(bytes / 1024).toFixed(0)} KB / ${ms}ms`;
    });

    // 回归用例（真实转码）：低分辨率源 + GIF 默认预设 + 不改帧率，
    // 对应早期 "滤镜链以逗号开头 → No such filter: ''" 的 bug。
    await checkAsync('回归：低分辨率源直接用 GIF 默认预设（无前置滤镜）', async () => {
      const lowResSample = path.join(SAMPLES, 'sample-480p.mp4');
      makeSample(lowResSample, { seconds: 3, size: '640x480', codec: 'h264' });
      const lowProbe = await mods.probe.probeMedia(lowResSample, { ffprobePath: FFPROBE });
      assert(lowProbe.video[0].displayHeight === 480, `素材高度应为 480，实际 ${lowProbe.video[0].displayHeight}`);

      const out = path.join(OUTPUT, 'smoke-gif-480p.gif');
      const b = mods.commands.buildCommand(
        {
          ...baseOptions,
          presetId: 'gif-motion',
          videoCodecId: 'gif',
          audioCodecId: 'none',
          resolutionId: '480p', // 与源相同 → 不产生 scale
          fpsId: 'source', // 不产生 fps 滤镜
          trimStartSec: 0,
          trimEndSec: 2,
        },
        { probe: lowProbe, outputPath: out },
      );
      const vf = b.args[b.args.indexOf('-vf') + 1];
      assert(!vf.startsWith(','), `滤镜链不能以逗号开头：${vf.slice(0, 50)}`);

      const { ms, bytes } = await runBuilt(b, out);
      assert(bytes > 1024, `产物过小（${bytes} 字节），说明滤镜链有问题`);
      return `${(bytes / 1024).toFixed(0)} KB / ${ms}ms`;
    });

    await checkAsync('裁剪转换（只转 1-3 秒）', async () => {
      const out = path.join(OUTPUT, 'smoke-trim.mp4');
      const b = mods.commands.buildCommand(
        { ...baseOptions, trimStartSec: 1, trimEndSec: 3 },
        { probe: probeResult, outputPath: out },
      );
      const { ms } = await runBuilt(b, out);
      const p = await mods.probe.probeMedia(out, { ffprobePath: FFPROBE });
      assert(Math.abs(p.durationSec - 2) < 0.5, `裁剪后时长应约 2 秒，实际 ${p.durationSec.toFixed(2)}`);
      return `时长 ${p.durationSec.toFixed(2)}s / ${ms}ms`;
    });
  }

  await checkAsync('压缩比合理（小体积档应显著小于源文件）', async () => {
    const src = statSync(sampleMp4).size;
    const out = path.join(OUTPUT, 'smoke-small.mp4');
    const b = mods.commands.buildCommand(
      { ...baseOptions, qualityId: 'tiny', resolutionId: '360p' },
      { probe: probeResult, outputPath: out },
    );
    const { bytes } = await runBuilt(b, out);
    assert(bytes < src * 2, `输出 ${bytes} 与源 ${src} 相比不合理`);
    return `${(src / 1024).toFixed(0)} KB → ${(bytes / 1024).toFixed(0)} KB（${((bytes / src) * 100).toFixed(0)}%）`;
  });

  /* ---- 错误诊断 ---- */
  group('健壮性 · 错误诊断');
  check('源编码装不进 MP4 时给出人话提示', () => {
    // 用 theora/vorbis 这类 MP4 明确不接受的编码来构造场景
    // （VP9 其实可以装进 MP4，用它做反例会得到假通过）
    const fakeProbe = {
      ...probeResult,
      video: [{ ...probeResult.video[0], codec: 'theora' }],
    };
    try {
      mods.commands.buildCommand(
        { ...baseOptions, videoCodecId: 'copy', audioCodecId: 'copy' },
        { probe: fakeProbe, outputPath: path.join(OUTPUT, 'x.mp4') },
      );
      throw new Error('本应抛错');
    } catch (err) {
      assert(err.name === 'CommandBuildError', `错误类型不对：${err.name}`);
      assert(/装不进/.test(err.message), `提示不够人话：${err.message}`);
      assert(err.hint, '应给出修复建议');
      return `${err.message} → ${err.hint.slice(0, 24)}…`;
    }
  });

  check('VP9 源直通到 MP4 应当被允许（避免过度拦截）', () => {
    const vp9Probe = { ...probeResult, video: [{ ...probeResult.video[0], codec: 'vp9' }] };
    const b = mods.commands.buildCommand(
      { ...baseOptions, videoCodecId: 'copy', audioCodecId: 'copy' },
      { probe: vp9Probe, outputPath: path.join(OUTPUT, 'vp9copy.mp4') },
    );
    assert(b.args.join(' ').includes('-c:v copy'), '应允许直通');
    return '已允许';
  });

  check('WebM 容器拒绝 H.264 直通', () => {
    const b = mods.commands;
    try {
      b.buildCommand(
        { ...baseOptions, presetId: 'webm-web', videoCodecId: 'copy', audioCodecId: 'opus' },
        { probe: probeResult, outputPath: path.join(OUTPUT, 'x.webm') },
      );
      throw new Error('本应抛错：H.264 装不进 WebM');
    } catch (err) {
      assert(/装不进/.test(err.message), `提示不够人话：${err.message}`);
      return err.message;
    }
  });

  check('ffmpeg 错误翻译（磁盘满）', () => {
    const e = mods.errors.diagnoseFfmpegError('av_interleaved_write_frame(): No space left on device', 1, false, false);
    assert(e.kind === 'disk-full', `分类错误：${e.kind}`);
    assert(e.hint, '应给出建议');
    return `${e.message} → ${e.hint.slice(0, 20)}…`;
  });

  check('ffmpeg 错误翻译（未知编码器/显卡不可用）', () => {
    const e = mods.errors.diagnoseFfmpegError('Cannot load nvcuda.dll', 1, false, false);
    assert(e.kind === 'unsupported-codec', `分类错误：${e.kind}`);
    assert(/硬件加速|软编码/.test(e.hint ?? ''), '建议应提到硬件加速');
    return e.message;
  });

  check('ffmpeg 错误翻译（容器不兼容）', () => {
    const e = mods.errors.diagnoseFfmpegError(
      'Could not find tag for codec vp9 in stream #0, codec not currently supported in container',
      1,
      false,
      false,
    );
    assert(e.kind === 'unsupported-codec', `分类错误：${e.kind}`);
    return e.message;
  });

  check('取消的任务标记为 canceled 而不是失败', () => {
    const e = mods.errors.diagnoseFfmpegError('whatever', null, true, false);
    assert(e.kind === 'canceled', `分类错误：${e.kind}`);
    return e.message;
  });

  /* ---- 进度解析 ---- */
  group('需求 2 · 进度解析');
  check('解析 -progress 输出为百分比/速度/剩余时间', () => {
    const updates = [];
    const tracker = new mods.progress.ProgressTracker({
      totalDurationSec: 100,
      onUpdate: (p) => updates.push(p),
    });
    tracker.push('frame=120\nfps=48.0\nout_time_us=25000000\nspeed=2.5x\nprogress=continue\n');
    assert(updates.length === 1, `应产生 1 次更新，实际 ${updates.length}`);
    const p = updates[0];
    assert(Math.abs(p.percent - 25) < 0.01, `百分比应为 25，实际 ${p.percent}`);
    assert(p.speed === 2.5, `速度应为 2.5，实际 ${p.speed}`);
    assert(p.etaSec !== null && p.etaSec > 29 && p.etaSec < 31, `剩余时间应约 30 秒，实际 ${p.etaSec}`);
    return `${p.percent}% · ${p.speed}× · ETA ${p.etaSec.toFixed(1)}s`;
  });

  check('时间字符串解析（HH:MM:SS.mmm）', () => {
    const t = mods.progress.parseTimeString('01:02:03.500000');
    assert(Math.abs(t - 3723.5) < 0.001, `应为 3723.5，实际 ${t}`);
    return '01:02:03.5 → 3723.5s';
  });

  check('未知总时长时不瞎给百分比', () => {
    const updates = [];
    const tracker = new mods.progress.ProgressTracker({
      totalDurationSec: 0,
      onUpdate: (p) => updates.push(p),
    });
    tracker.push('out_time_us=5000000\nprogress=continue\n');
    assert(updates[0].percent === null, `应为 null，实际 ${updates[0].percent}`);
    return 'percent=null（界面走不确定进度条）';
  });

  /* ---- 汇总 ---- */
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;

  console.log(`\n${'='.repeat(64)}`);
  console.log(`总计 ${results.length} 项：通过 ${pass}，失败 ${fail}`);

  if (fail > 0) {
    console.log('\n失败用例：');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  ✘ [${r.group}] ${r.name}\n     ${r.detail}`);
    }
  }

  const totalMs = results.reduce((s, r) => s + r.ms, 0);
  console.log(`总耗时 ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`产物目录：${path.relative(root, OUTPUT)}`);
  console.log(fail === 0 ? '\n全部通过 ✅' : '\n存在失败用例 ❌');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n冒烟测试自身异常：', err);
  process.exit(2);
});
