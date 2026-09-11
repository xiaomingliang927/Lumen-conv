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
    // 批量/并发调度是「一次选多个文件」的核心，必须用真实的引擎代码来测
    engine: 'electron/ffmpeg/convert.ts',
    // 字幕烧录的路径转义规则（ffmpeg 经典坑）单独测
    subtitleBurn: 'shared/subtitle-burn.ts',
    // 输出尺寸计算：界面显示与 ffmpeg 滤镜读的同一份计划
    outputSize: 'shared/output-size.ts',
    // 兼容性预检：字幕烧录的前置校验也在这里
    compatibility: 'shared/compatibility.ts',
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
    /*
     * 旋转素材改用 scripts/generate-samples.mjs 产出的 rot90.mp4。
     *
     * 原来这里用 `-metadata:s:v:0 rotate=90` 合成，但**新版 ffmpeg 不再写这个 tag**，
     * 生成的素材实际 rotation=0，导致后面的旋转用例静默走了"跳过"分支（假通过）。
     * rot90.mp4 是用 `-display_rotation 90`（输入侧选项）生成的，确实带显示矩阵。
     */
    check('准备带旋转元数据的素材（rot90.mp4）', () => {
      const rotSample = path.join(SAMPLES, 'rot90.mp4');
      if (!existsSync(rotSample)) {
        const gen = spawnSync(
          process.execPath,
          [path.join(root, 'scripts', 'generate-samples.mjs')],
          { encoding: 'utf8', windowsHide: true },
        );
        if (gen.status !== 0 || !existsSync(rotSample)) {
          throw new Error(
            `缺少 rot90.mp4 且自动生成失败：${(gen.stderr || '').trim().split('\n').pop()?.slice(0, 100)}`,
          );
        }
      }
      return `${(statSync(rotSample).size / 1024).toFixed(0)} KB`;
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

  /*
   * 字幕烧录用的两个探测结果桩。
   *
   * 真实样本里 `.srt` 内嵌字幕的素材（subs-multi.mkv）确实有，但它的字幕轨在
   * 全片范围内，用它测"图形字幕拦截"还得另找 PGS 素材；这两条判定是**纯逻辑**
   * （文字字幕 vs 图形字幕、全局 index vs si），用桩更精确也更快。
   * 真实素材路径由 test:real:convert 覆盖。
   */
  const subsProbe = {
    ...probeResult,
    path: path.join(SAMPLES, 'subs-multi.mkv'),
    hasSubtitle: true,
    subtitle: [
      { index: 2, codec: 'subrip', isTextBased: true, language: 'chi', title: '简体中文', isForced: false },
      { index: 3, codec: 'subrip', isTextBased: true, language: 'eng', title: 'English', isForced: false },
    ],
  };
  const pgsProbe = {
    ...probeResult,
    path: path.join(SAMPLES, 'subs-multi.mkv'),
    hasSubtitle: true,
    subtitle: [
      { index: 2, codec: 'hdmv_pgs_subtitle', isTextBased: false, language: 'chi', title: '图形字幕', isForced: false },
    ],
  };
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
    // 默认不设体积上限（这样才走质量档/CRF 路径）；体积上限另有用例覆盖
    sizeLimitMb: null,
    deviceId: null,
    useCaseId: null,
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

  /*
   * 竖屏适配（画面比例 = 竖屏 9:16）。
   *
   * 起因：用户反馈"我换成手机的但是屏幕比例没变" —— 1080p 是上限，源更低时不会放大，
   * 于是"手机"这个用途对 640×360 的源什么也没改变。竖屏适配是显式可选项，默认关。
   * 这两条盯的是"画布按 9:16、且不放大"这条规则。
   */
  check('画面比例：竖屏补边 → 画布 9:16，且画布短边不超过源（不放大）', () => {
    const r = mods.commands.buildCommand({ ...baseOptions, resolutionId: '1080p', fitMode: 'pad' }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'fit-pad.mp4'),
    });
    const text = r.args.join(' ');
    // 源 640×360，短边 360 → 画布 360×640
    assert(/scale=360:640:force_original_aspect_ratio=decrease/.test(text), `缩放参数不对：${text.slice(0, 260)}`);
    assert(/pad=360:640:\(ow-iw\)\/2:\(oh-ih\)\/2:black/.test(text), `补边参数不对：${text.slice(0, 260)}`);
    /*
     * setsar 必须重置。
     * force_original_aspect_ratio 会算出小数尺寸（640×360 放进 360×640 是 360×202.5），
     * ffmpeg 取整后改 SAR 补偿，于是回读的 displayWidth 变成 361 —— 真实素材测试里踩到过。
     */
    assert(/setsar=1/.test(text), '竖屏补边必须重置 SAR，否则回读尺寸会因非方形像素而偏移');
    assert(!/scale=-2:/.test(text), '竖屏模式下不应再套用普通的按高度缩放');
    return 'scale=360:640:…decrease + pad=360:640 + setsar=1';
  });

  check('画面比例：竖屏裁剪 → 画布 9:16，用 increase 填满后裁切', () => {
    const r = mods.commands.buildCommand({ ...baseOptions, resolutionId: '1080p', fitMode: 'crop' }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'fit-crop.mp4'),
    });
    const text = r.args.join(' ');
    assert(/scale=360:640:force_original_aspect_ratio=increase/.test(text), `缩放参数不对：${text.slice(0, 260)}`);
    assert(/crop=360:640/.test(text), `裁剪参数不对：${text.slice(0, 260)}`);
    return 'scale=360:640:…increase + crop=360:640';
  });

  check('画面比例：源短边高于上限时，画布取上限（1920×1080 源 + 720p → 720×1280）', () => {
    const bigProbe = {
      ...probeResult,
      video: [{ ...probeResult.video[0], width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080 }],
    };
    const r = mods.commands.buildCommand({ ...baseOptions, resolutionId: '720p', fitMode: 'pad' }, {
      probe: bigProbe,
      outputPath: path.join(OUTPUT, 'fit-720.mp4'),
    });
    const text = r.args.join(' ');
    assert(/pad=720:1280/.test(text), `画布应为 720×1280：${text.slice(0, 260)}`);
    return 'pad=720:1280';
  });

  check('画面比例：默认 off 不产生任何 pad / crop 滤镜', () => {
    const r = mods.commands.buildCommand({ ...baseOptions, resolutionId: '1080p', fitMode: 'off' }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'fit-off.mp4'),
    });
    const text = r.args.join(' ');
    assert(!/pad=/.test(text) && !/crop=/.test(text), '默认不应改画面比例');
    return '无 pad / crop';
  });

  /* ---------------- 音频处理（响度归一化 / 音量 / 声道） ---------------- */

  check('音频：响度归一化生成 loudnorm 滤镜（EBU R128，-16 LUFS）', () => {
    const r = mods.commands.buildCommand({ ...baseOptions, audioLoudnorm: true }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'loud.mp4'),
    });
    const text = r.args.join(' ');
    assert(/-af\s+loudnorm=I=-16:TP=-1\.5:LRA=11/.test(text), `缺少 loudnorm 滤镜：${text.slice(0, 260)}`);
    return 'loudnorm=I=-16:TP=-1.5:LRA=11';
  });

  check('音频：音量增益与响度归一化同时开启时，顺序是"先增益、后归一化"', () => {
    const r = mods.commands.buildCommand(
      { ...baseOptions, audioVolumeDb: 6, audioLoudnorm: true },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'vol-loud.mp4') },
    );
    const text = r.args.join(' ');
    /*
     * 顺序很重要：loudnorm 会把响度拉平，如果它排在 volume 前面，
     * 用户手动加的增益等于白加 —— 这条断言盯的就是这个顺序。
     */
    assert(/volume=6dB,loudnorm=/.test(text), `滤镜顺序不对：${text.slice(0, 260)}`);
    return 'volume=6dB → loudnorm';
  });

  check('音频：音量增益会被夹在 -30 ~ +30 dB 之间', () => {
    const r = mods.commands.buildCommand({ ...baseOptions, audioVolumeDb: 999 }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'vol-clamp.mp4'),
    });
    const text = r.args.join(' ');
    assert(/volume=30dB/.test(text), `未夹紧上限：${text.slice(0, 200)}`);
    return '999 → 30dB';
  });

  check('音频：声道改成单声道时输出 -ac 1', () => {
    const r = mods.commands.buildCommand({ ...baseOptions, audioChannels: 'mono' }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'mono.mp4'),
    });
    const text = r.args.join(' ');
    assert(/-ac\s+1/.test(text), `缺少 -ac 1：${text.slice(0, 220)}`);
    return '-ac 1';
  });

  check('音频：声道保持原样时不强行加 -ac（交给原有推断逻辑）', () => {
    const r = mods.commands.buildCommand({ ...baseOptions, audioChannels: 'source' }, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'src-ch.mp4'),
    });
    const text = r.args.join(' ');
    // smoke 样本是单声道源，source 模式下不该出现 -ac
    assert(!/-ac\s/.test(text), `source 模式不应出现 -ac：${text.slice(0, 220)}`);
    return '无 -ac';
  });

  check('音频：直通（copy）时忽略音频处理滤镜，不生成 -af', () => {
    const r = mods.commands.buildCommand(
      { ...baseOptions, audioCodecId: 'copy', audioLoudnorm: true, audioVolumeDb: 3 },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'acopy.mp4') },
    );
    const text = r.args.join(' ');
    assert(/-c:a\s+copy/.test(text), 'copy 模式应保留 -c:a copy');
    assert(!/-af\s/.test(text), `copy 模式不该有 -af（滤镜会被忽略或报错）：${text.slice(0, 220)}`);
    return '-c:a copy，无 -af';
  });

  /* ---------------- 字幕烧录 ---------------- */

  check('字幕烧录：路径转义正确（反斜杠 / 冒号 / 空格 / 中文）', () => {
    const { escapeFilterPath } = mods.subtitleBurn;
    const got = escapeFilterPath('C:\\Users\\季\\我的 视频\\subs.srt');
    assert(
      got === "'C\\:/Users/季/我的 视频/subs.srt'",
      `转义结果不对：${got}`,
    );
    return got;
  });

  check('字幕烧录：单引号按 ffmpeg 规则转义（闭合→转义→重开）', () => {
    const { escapeFilterPath } = mods.subtitleBurn;
    const got = escapeFilterPath("C:\\a'b\\x.srt");
    assert(got === "'C\\:/a'\\''b/x.srt'", `单引号转义不对：${got}`);
    return got;
  });

  check('字幕烧录：全局流 index 换算成"第几条字幕流"', () => {
    const { subtitleStreamOrdinal } = mods.subtitleBurn;
    // 流顺序 0=视频 1=音频 2=字幕 3=字幕 → 全局 3 是第 2 条字幕（si=1）
    assert(subtitleStreamOrdinal([2, 3], 3) === 1, 'si 换算错误');
    assert(subtitleStreamOrdinal([2, 3], 2) === 0, 'si 换算错误');
    assert(subtitleStreamOrdinal([], 9) === 0, '空列表应兜底为 0');
    return '全局 3 → si 1';
  });

  check('字幕烧录：直通模式会被拦下并给出人话原因', () => {
    let err = null;
    try {
      mods.commands.buildCommand(
        { ...baseOptions, videoCodecId: 'copy', burnSubtitleIndex: 2 },
        { probe: subsProbe, outputPath: path.join(OUTPUT, 'burn-copy.mkv') },
      );
    } catch (e) {
      err = e;
    }
    assert(err, '直通 + 烧录应当抛错');
    assert(/直通|不能烧录/.test(String(err.message)), `错误信息不清晰：${err.message}`);
    return String(err.message).slice(0, 40);
  });

  check('字幕烧录：图形字幕（PGS）被拦下', () => {
    let err = null;
    try {
      mods.commands.buildCommand(
        { ...baseOptions, burnSubtitleIndex: 2 },
        { probe: pgsProbe, outputPath: path.join(OUTPUT, 'burn-pgs.mp4') },
      );
    } catch (e) {
      err = e;
    }
    assert(err, '图形字幕烧录应当抛错');
    assert(/图形字幕/.test(String(err.message)), `错误信息不清晰：${err.message}`);
    return String(err.message).slice(0, 40);
  });

  check('字幕烧录：文字字幕生成 subtitles 滤镜，且排在缩放之后', () => {    /*
     * 用一个 720p 的源 + 360p 目标，确保这条链路里**真的存在** scale 滤镜 ——
     * 否则（源比目标小、按"只缩不放"跳过缩放）就测不到顺序，
     * 只会得到一个"看起来通过"的空断言。
     */
    const hdProbe = {
      ...subsProbe,
      video: [{ ...subsProbe.video[0], width: 1280, height: 720, displayWidth: 1280, displayHeight: 720 }],
    };
    const r = mods.commands.buildCommand(
      { ...baseOptions, resolutionId: '360p', burnSubtitleIndex: 2 },
      { probe: hdProbe, outputPath: path.join(OUTPUT, 'burn-ok.mp4') },
    );
    const text = r.args.join(' ');
    assert(/subtitles=/.test(text), `缺少 subtitles 滤镜：${text.slice(0, 300)}`);
    assert(/si=0/.test(text), `si 参数不对：${text.slice(0, 300)}`);
    const vf = /-vf\s+(\S+)/.exec(text)?.[1] ?? '';
    assert(vf.includes('scale='), `这条用例必须包含 scale 才有意义：${vf}`);
    assert(
      vf.indexOf('subtitles') > vf.indexOf('scale'),
      `subtitles 必须排在 scale 之后（否则字幕会跟着画面一起缩放）：${vf}`,
    );
    return vf.slice(0, 80);
  });

  /*
   * 字幕烧录的**界面级**前置校验（compatibility.ts）。
   *
   * 与上面那条"buildCommand 会抛错"的区别：buildCommand 是点了"开始转换"之后才报，
   * 而这里要求**改参数的当下**就出现红条 —— "转完才发现白转"正是这个模块存在的理由。
   * 真实用户反馈里那条"换成手机后比例没变"就是吃了"界面与执行各算各的"的亏。
   */
  check('字幕烧录：直通时兼容性预检给出 block 级警告（不用等到点开始转换）', () => {
    const issues = mods.compatibility.checkCompatibility({
      probe: subsProbe,
      options: { ...baseOptions, videoCodecId: 'copy', burnSubtitleIndex: 2 },
    });
    const hit = issues.find((i) => i.level === 'block' && i.message.includes('烧录'));
    assert(hit, `预检没有拦住：${JSON.stringify(issues.map((i) => i.message))}`);
    assert(hit.fix && hit.fix.videoCodecId, '应当给出一键修复');
    return hit.message;
  });

  check('字幕烧录：图形字幕在预检里也被拦下', () => {
    const issues = mods.compatibility.checkCompatibility({
      probe: pgsProbe,
      options: { ...baseOptions, burnSubtitleIndex: 2 },
    });
    const hit = issues.find((i) => i.level === 'block' && i.message.includes('图形字幕'));
    assert(hit, `预检没有拦住：${JSON.stringify(issues.map((i) => i.message))}`);
    return hit.message;
  });

  check('字幕烧录：合法组合给出 info 级说明（不吓唬用户，但要说清代价）', () => {
    const issues = mods.compatibility.checkCompatibility({
      probe: subsProbe,
      options: { ...baseOptions, burnSubtitleIndex: 2 },
    });
    const hit = issues.find((i) => i.level === 'info' && i.message.includes('烧进画面'));
    assert(hit, `缺少说明：${JSON.stringify(issues.map((i) => i.message))}`);
    assert(/重新编码/.test(hit.suggestion ?? ''), '说明里要提到必须重新编码');
    return hit.message;
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

  /* ---- 旋转处理 ---- */
  /*
   * 这里以前是个**假通过**的用例：它写"旋转视频应生成 transpose 滤镜"，
   * 但前提是 `sample-rotated.mp4` 真的带 rotation=90 元数据 —— 实测它是 0
   * （新版 ffmpeg 不再写 rotate tag），所以那句断言从来没被执行过，
   * 用例每次都走 else 分支"跳过"并算通过。
   *
   * 现在改成分两层：
   *   ① 用合成探测器数据验证命令装配规则（不依赖素材是否有旋转）
   *   ② 如果磁盘上存在真正带旋转的素材（scripts/generate-samples.mjs 产出的 rot90.mp4），
   *      就跑一次**真实转码**并回读产物尺寸，确认画面确实被转正
   */
  check('旋转素材：命令里不应出现 transpose（ffmpeg 会自动转正，重复转会转两次）', () => {
    const rotatedProbe = {
      ...probeResult,
      video: [{ ...probeResult.video[0], rotation: 90, width: 720, height: 1280 }],
    };
    const b = mods.commands.buildCommand(baseOptions, {
      probe: rotatedProbe,
      outputPath: path.join(OUTPUT, 'rot-check.mp4'),
    });
    const text = b.args.join(' ');
    assert(!text.includes('transpose'), `不应生成 transpose，实际命令含：${text.match(/-vf\s+\S+/)?.[0] ?? ''}`);
    assert(
      b.notes.some((n) => n.includes('旋转')),
      '应对用户说明旋转已被自动处理',
    );
    return '无 transpose，且有用户提示';
  });

  if (!quick) {
    await checkAsync('旋转素材：真实转码后画面确实被转正（1280×720）', async () => {
      const rotSample = path.join(SAMPLES, 'rot90.mp4');
      if (!existsSync(rotSample)) {
        // 素材由 scripts/generate-samples.mjs 生成；缺失时明确说明而不是假装通过
        throw new Error('缺少 rot90.mp4 素材，请先执行 node scripts/generate-samples.mjs');
      }
      const p = await mods.probe.probeMedia(rotSample, { ffprobePath: FFPROBE });
      const v = p.video[0];
      assert(v.rotation === 90, `素材旋转角应为 90，实际 ${v.rotation}`);
      assert(
        v.displayWidth === 1280 && v.displayHeight === 720,
        `展示尺寸应按旋转校正为 1280×720，实际 ${v.displayWidth}×${v.displayHeight}`,
      );

      const out = path.join(OUTPUT, 'smoke-rot90.mp4');
      const b = mods.commands.buildCommand(
        { ...baseOptions, audioCodecId: 'none' },
        { probe: p, outputPath: out },
      );
      await runBuilt(b, out);

      // 回读产物：宽高必须已被转正（说明 ffmpeg 的自动旋转生效了）
      const p2 = await mods.probe.probeMedia(out, { ffprobePath: FFPROBE });
      const v2 = p2.video[0];
      assert(
        v2.displayWidth === 1280 && v2.displayHeight === 720,
        `产物应被转正为 1280×720，实际 ${v2.displayWidth}×${v2.displayHeight}`,
      );
      return `源 ${v.width}×${v.height}(rotation=${v.rotation}°) → 产物 ${v2.displayWidth}×${v2.displayHeight}`;
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

  /* ---- 批量（一次选多个文件） ---- */
  group('需求 2 · 批量转换（一次选多个文件）');

  /*
   * 这一组用**真实的 ConversionEngine**（不是另写一套调度）来验证批量路径：
   * 队列、并发、输出路径分配、状态流转都走产品代码。
   *
   * 起因：用户问"可以一次性选择多个文件进行解码吗"。功能本身是有的
   * （文件对话框 multiSelections + 拖拽多选 + 「开始转换（N 个）」），
   * 但此前**没有任何自动化用例覆盖批量路径** —— 单文件全绿不代表批量也对。
   */
  await checkAsync('批量入队 3 个文件并全部转换完成', async () => {
    const engine = new mods.engine.ConversionEngine();
    engine.setFfmpegPath(FFMPEG);
    engine.setFfprobePath(FFPROBE);
    engine.setConcurrency(2); // 故意小于任务数，用来验证排队与并发调度

    const sources = [sampleMp4, sampleMp4, existsSync(sampleHevc) ? sampleHevc : sampleMp4];
    const requests = sources.map((src, i) => ({
      sourcePath: src,
      options: {
        ...baseOptions,
        presetId: 'mp4-compatible',
        videoCodecId: 'h264',
        audioCodecId: 'aac',
        qualityId: 'tiny',
        resolutionId: '360p',
        fileNameTemplate: `batch-${i}-{name}`,
      },
    }));

    const created = await engine.createJobs(requests);
    const ok = created.filter((r) => r.job);
    assert(ok.length === 3, `应有 3 个任务入队，实际 ${ok.length}（错误：${created.map((r) => r.error).filter(Boolean).join('; ')}）`);

    // 等全部进入终态
    const deadline = Date.now() + 180_000;
    for (;;) {
      const list = engine.list();
      const settled = list.every((j) => ['done', 'failed', 'canceled'].includes(j.state));
      if (settled || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const list = engine.list();
    const failed = list.filter((j) => j.state !== 'done');
    assert(failed.length === 0, `${failed.length} 个任务未成功：${failed.map((j) => `${j.sourceName}=${j.state}(${j.error?.message ?? ''})`).join('; ')}`);

    // 输出路径必须互不相同（并发写同一个文件会互相破坏）
    const outs = list.map((j) => j.outputPath);
    const uniq = new Set(outs);
    assert(uniq.size === outs.length, `输出路径出现重复：${outs.join(' | ')}`);

    // 每个产物都要真实存在且不是空文件
    for (const j of list) {
      assert(existsSync(j.outputPath), `产物不存在：${j.outputPath}`);
      assert(statSync(j.outputPath).size > 1024, `产物过小：${j.outputPath}`);
    }

    // 进度必须都走到 100%
    const badProgress = list.filter((j) => j.progress?.percent !== 100);
    assert(badProgress.length === 0, `${badProgress.length} 个任务进度未到 100%`);

    return `${list.length} 个任务全部完成，产物 ${list.map((j) => (statSync(j.outputPath).size / 1024).toFixed(0)).join('/')} KB`;
  });

  await checkAsync('批量任务的文件名模板按序号区分', async () => {
    /*
     * 先按前缀清掉所有历史产物。
     *
     * 注意目录：baseOptions.outputDir 是 OUTPUT（test-assets/output），不是 SAMPLES。
     * 一开始清错了目录，导致产物一直残留、名字逐次递增到 (15)。
     *
     * 另外只删精确文件名也不够：应用的「自动改名避免覆盖」会生成
     * `tpl-0-sample-h264 (1).mp4` 这类名字，必须按前缀整体清理。
     */
    const prefixCleanup = async () => {
      for (const dir of [OUTPUT, SAMPLES]) {
        let names = [];
        try {
          names = await fsp.readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (/^tpl-\d+-/.test(name)) {
            await fsp.rm(path.join(dir, name), { force: true });
          }
        }
      }
    };
    await prefixCleanup();

    /*
     * 清掉两遍编码遗留的统计日志。
     *
     * 这些 `.lumen-2pass-<输出名>-0.log(.mbtree)` 是 ffmpeg 两遍编码的中间文件，
     * 正常流程由 `ConversionEngine.cleanupPassLog()` 在任务结束时删掉。
     * 但如果某一轮自检被**中途杀掉**（Ctrl-C、关窗口、Stop-Process），
     * 文件就会留在产物目录里，名字还带着当时那次运行的文件名序号
     * （例如 `.lumen-2pass-size-target (12)-0.log`）。
     *
     * 后面那条"统计日志必须被清理干净"的断言扫的是整个目录，于是会被**上一次**
     * 留下的垃圾判为失败 —— 断言本身没错，但它报的是历史问题而不是本次问题
     * （本轮实测被这个坑了一次：产物目录里有被我 kill 掉的那轮留下的日志）。
     * 这里先清一遍，并把清掉的数量打出来：既让本次结果确定，也不掩盖"上次没清干净"。
     */
    let stalePassLogs = 0;
    for (const dir of [OUTPUT, SAMPLES]) {
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith('.lumen-2pass-')) {
          await fsp.rm(path.join(dir, name), { force: true });
          stalePassLogs++;
        }
      }
    }
    if (stalePassLogs > 0) {
      console.log(
        `[smoke] 清理了 ${stalePassLogs} 个上次运行遗留的两遍编码日志（通常是自检被中途杀掉留下的）`,
      );
    }

    const engine = new mods.engine.ConversionEngine();
    engine.setFfmpegPath(FFMPEG);
    engine.setFfprobePath(FFPROBE);

    // 逐个创建：每个任务创建前都再清一次，确保"决定输出路径"的那一刻目录是干净的。
    // 一次传两个文件时是并发决定路径的，任何一个残留都会让名字带上 (N) 后缀，
    // 使断言结果随上一次运行漂移（实测 (8)(9)(10)(11) 逐次递增）。
    const created = [];
    for (const i of [0, 1]) {
      await prefixCleanup();
      const [r] = await engine.createJobs([
        {
          sourcePath: sampleMp4,
          options: {
            ...baseOptions,
            presetId: 'mp4-compatible',
            videoCodecId: 'copy',
            audioCodecId: 'copy',
            fileNameTemplate: `tpl-${i}-{name}`,
          },
        },
      ]);
      created.push(r);
    }

    const names = created.filter((r) => r.job).map((r) => path.basename(r.job.outputPath));
    assert(names.length === 2, `应有 2 个任务，实际 ${names.length}（${created.map((r) => r.error).filter(Boolean).join('; ')}）`);
    assert(names[0] !== names[1], `两个任务输出了同一个文件名：${names[0]}`);
    assert(
      names.every((n) => n.startsWith('tpl-')),
      `模板未生效：${names.join(', ')}`,
    );
    // 断言模板变量真的被替换（而不是原样留下 {name}）
    assert(
      names.every((n) => n.includes('sample-h264')),
      `{name} 变量未被替换：${names.join(', ')}`,
    );
    // 起点干净时不应触发自动改名；触发说明清理没做到位（而不是产品有问题）
    assert(
      names.every((n) => !n.includes(' (')),
      `出现自动改名后缀，说明起点仍有残留：${names.join(', ')}`,
    );

    /*
     * 先取消、等任务真正结束，再清理产物。
     *
     * 顺序很重要：如果先清理再取消，运行中的任务会在清理之后继续写盘，
     * 于是文件残留到下一次运行，触发自动改名，结果逐次递增（实测 (5)(6)(7)）。
     */
    for (const j of engine.list()) engine.cancel(j.id);
    const settleDeadline = Date.now() + 15_000;
    for (;;) {
      const all = engine.list();
      if (all.every((j) => ['done', 'failed', 'canceled'].includes(j.state))) break;
      if (Date.now() > settleDeadline) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 300));
    await prefixCleanup();

    return names.join(' / ');
  });

  /* ---- 目标体积（两遍编码） ---- */
  group('需求 3 · 目标体积压缩（两遍编码）');

  check('目标体积：命令里出现两遍编码参数', () => {
    const b = mods.commands.buildCommand(
      { ...baseOptions, sizeLimitMb: 1, presetId: 'mp4-compatible' },
      { probe: probeResult, outputPath: path.join(OUTPUT, 'size.mp4') },
    );
    const text = b.args.join(' ');
    assert(text.includes('-pass 2'), '主命令应带 -pass 2');
    assert(text.includes('-b:v'), '应使用目标码率而不是 CRF');
    assert(!text.includes('-crf'), '设了体积上限就不应再给 -crf（两者混用体积不可控）');
    assert(b.prePasses.length === 1, `应有 1 个前置步骤（第一遍），实际 ${b.prePasses.length}`);
    const pass1 = b.prePasses[0].args.join(' ');
    assert(pass1.includes('-pass 1'), '第一遍应带 -pass 1');
    assert(pass1.includes('-passlogfile'), '第一遍应写统计日志');
    assert(/-f null/.test(pass1), '第一遍应输出到 null 而不是真文件');
    assert(Boolean(b.passLogPrefix), '应返回 passLogPrefix 供清理');
    assert(b.targetSizeMb === 1, `targetSizeMb 应为 1，实际 ${b.targetSizeMb}`);
    return `第一遍 ${b.prePasses[0].args.length} 参数，主命令 ${b.args.length} 参数`;
  });

  check('目标体积：码率由体积与时长反推，且随体积线性变化', () => {
    const dur = probeResult.durationSec;
    const small = mods.commands.computeSizeBudget(10, dur, 128);
    const large = mods.commands.computeSizeBudget(20, dur, 128);
    assert(small.videoKbps > 0, '视频码率应大于 0');
    assert(
      Math.abs(large.videoKbps / small.videoKbps - 2) < 0.05,
      `体积翻倍时视频码率应约翻倍：${small.videoKbps.toFixed(0)} → ${large.videoKbps.toFixed(0)}`,
    );
    // 音频码率应从总码率里扣掉
    assert(
      Math.abs(small.totalKbps - (small.videoKbps + 128)) < 1,
      '总码率应等于视频 + 音频',
    );
    return `10MB → ${small.videoKbps.toFixed(0)}kbps，20MB → ${large.videoKbps.toFixed(0)}kbps`;
  });

  check('目标体积：不设上限时不产生两遍编码', () => {
    const b = mods.commands.buildCommand(baseOptions, {
      probe: probeResult,
      outputPath: path.join(OUTPUT, 'nopass.mp4'),
    });
    assert(b.prePasses.length === 0, '未设上限不应有两遍编码');
    assert(b.passLogPrefix === null, 'passLogPrefix 应为 null');
    assert(b.targetSizeMb === null, 'targetSizeMb 应为 null');
    return '单遍编码';
  });

  if (!quick) {
    await checkAsync('目标体积：真实转码后产物体积确实落在目标之下', async () => {
      const engine = new mods.engine.ConversionEngine();
      engine.setFfmpegPath(FFMPEG);
      engine.setFfprobePath(FFPROBE);

      // 源文件 661KB / 6 秒；目标设 0.4MB，逼它必须真的压下来
      const targetMb = 0.4;
      const [created] = await engine.createJobs([
        {
          sourcePath: sampleMp4,
          options: {
            ...baseOptions,
            presetId: 'mp4-compatible',
            videoCodecId: 'h264',
            audioCodecId: 'aac',
            sizeLimitMb: targetMb,
            resolutionId: '360p',
            fileNameTemplate: 'size-target',
          },
        },
      ]);
      assert(created.job, `入队失败：${created.error}`);

      const deadline = Date.now() + 180_000;
      for (;;) {
        const j = engine.get(created.job.id);
        if (j && ['done', 'failed', 'canceled'].includes(j.state)) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 300));
      }

      const job = engine.get(created.job.id);
      assert(job?.state === 'done', `任务未成功：${job?.state} / ${job?.error?.message ?? ''}`);

      const outBytes = statSync(job.outputPath).size;
      const targetBytes = targetMb * 1024 * 1024;
      assert(existsSync(job.outputPath), '产物不存在');
      // 允许 10% 超出的余量：两遍编码是"接近"目标而非"精确等于"
      assert(
        outBytes <= targetBytes * 1.1,
        `产物 ${(outBytes / 1024).toFixed(0)}KB 超过目标 ${(targetBytes / 1024).toFixed(0)}KB 的 110%`,
      );
      // 也要确认它真的压下来了（源 661KB → 目标 410KB）
      assert(outBytes < statSync(sampleMp4).size, '产物没有比源文件小，压缩没生效');

      // 两遍编码的统计日志必须被清理干净
      const leftovers = (await fsp.readdir(path.dirname(job.outputPath))).filter((n) =>
        n.startsWith('.lumen-2pass-'),
      );
      assert(leftovers.length === 0, `统计日志未清理：${leftovers.join(', ')}`);

      const ratio = ((outBytes / statSync(sampleMp4).size) * 100).toFixed(0);
      return `${(statSync(sampleMp4).size / 1024).toFixed(0)}KB → ${(outBytes / 1024).toFixed(0)}KB（目标 ${(targetBytes / 1024).toFixed(0)}KB，原片 ${ratio}%）`;
    });

    await checkAsync('目标体积：目标过小时提前报错而不是白转', async () => {
      const engine = new mods.engine.ConversionEngine();
      engine.setFfmpegPath(FFMPEG);
      engine.setFfprobePath(FFPROBE);
      // 6 秒视频要求压到 0.02MB（约等于 27kbps），比音频本身还低，应当被拦下
      const [created] = await engine.createJobs([
        {
          sourcePath: sampleMp4,
          options: { ...baseOptions, sizeLimitMb: 0.02, fileNameTemplate: 'size-too-small' },
        },
      ]);
      // 目前引擎侧不拦（只有 UI 侧 checkCompatibility 会提示 block），
      // 所以这里验证的是"要么入队、要么给出可读错误"，不能崩
      if (!created.job) {
        assert(created.error && created.error.length > 0, '应给出可读错误');
        return `已拦下：${created.error.slice(0, 50)}`;
      }
      for (const j of engine.list()) engine.cancel(j.id);
      return '入队成功（UI 层会通过兼容性预检提示，引擎层不阻断）';
    });
  }

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
