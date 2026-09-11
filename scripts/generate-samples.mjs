/**
 * 生成"模拟真实世界"的测试素材。
 *
 * 为什么需要它：合成的彩条 + 正弦音太干净，暴露不了真实视频的问题
 * （旋转元数据、软字幕、多音轨与 5.1 声道、可变帧率、中文文件名、边界尺寸）。
 * 这些素材被 scripts/probe-real.mjs 使用。
 *
 * 全部素材只依赖 ffmpeg 自带能力（lavfi 合成 + srt 字幕），无需外部下载。
 *
 * 用法：node scripts/generate-samples.mjs [--force]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const SAMPLES = path.join(root, 'test-assets', 'samples');
const force = process.argv.includes('--force');

if (!existsSync(FFMPEG)) {
  console.error('[samples] 找不到 ffmpeg，请先执行 node scripts/fetch-binaries.mjs');
  process.exit(1);
}
mkdirSync(SAMPLES, { recursive: true });

/** 跑一次 ffmpeg，返回是否成功 */
function ffmpeg(args) {
  const res = spawnSync(FFMPEG, args, { encoding: 'utf8', windowsHide: true });
  return { ok: res.status === 0, stderr: res.stderr ?? '' };
}

/**
 * 生成一个素材。
 * @param name    文件名
 * @param steps   一个或多个 ffmpeg 步骤；每步返回参数数组（不含 -y 等公共项）
 * @param label   说明，打印用
 */
function make(name, steps, label) {
  const out = path.join(SAMPLES, name);
  if (!force && existsSync(out) && statSync(out).size > 1024) {
    console.log(`  · ${name.padEnd(24)} 已存在（跳过；加 --force 重建）`);
    return;
  }
  for (const [i, step] of steps.entries()) {
    const { ok, stderr } = ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', ...step]);
    if (!ok) {
      console.error(
        `  ✘ ${name.padEnd(24)} 第 ${i + 1} 步失败：${(stderr.trim().split('\n').pop() ?? '').slice(0, 110)}`,
      );
      return;
    }
  }
  console.log(`  ✔ ${name.padEnd(24)} ${(statSync(out).size / 1024).toFixed(0)} KB  ${label}`);
}

const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

console.log('\n生成模拟真实世界的测试素材 …\n');

/* 1. 手机竖拍 + 显示矩阵旋转 90°（验证「自动转正」的关键素材） */
{
  const tmp = path.join(SAMPLES, '_tmp-portrait.mp4');
  const out = path.join(SAMPLES, 'rot90.mp4');
  if (force || !existsSync(out) || statSync(out).size < 1024) {
    const a = ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=5',
      ...H264, '-crf', '30', '-c:a', 'aac', '-shortest', tmp,
    ]);
    if (!a.ok) {
      console.error(`  ✘ rot90.mp4 第一步失败：${a.stderr.trim().split('\n').pop()?.slice(0, 110)}`);
    } else {
      // -display_rotation 是**输入侧**选项，必须放在 -i 之前
      const b = ffmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-display_rotation', '90', '-i', tmp, '-c', 'copy', out,
      ]);
      rmSync(tmp, { force: true });
      if (b.ok) console.log(`  ✔ ${'rot90.mp4'.padEnd(24)} ${(statSync(out).size / 1024).toFixed(0)} KB  显示矩阵旋转 90°，验证自动转正`);
      else console.error(`  ✘ rot90.mp4 第二步失败：${b.stderr.trim().split('\n').pop()?.slice(0, 110)}`);
    }
  } else {
    console.log(`  · ${'rot90.mp4'.padEnd(24)} 已存在（跳过；加 --force 重建）`);
  }
}

/* 2. 可变帧率录屏 */
make(
  'vfr-screen.mp4',
  [
    [
      '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=60:duration=6',
      '-vf', "select='not(mod(n\\,3))',setpts=N/20/TB", '-fps_mode', 'vfr',
      ...H264, '-crf', '30', '-an', path.join(SAMPLES, 'vfr-screen.mp4'),
    ],
  ],
  '可变帧率，验证 VFR 处理',
);

/* 3. 文件名含中文与空格 */
make(
  '我的 测试 视频.mp4',
  [
    [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      ...H264, '-crf', '30', '-c:a', 'aac', '-shortest', path.join(SAMPLES, '我的 测试 视频.mp4'),
    ],
  ],
  '中文 + 空格文件名',
);

/* 4. 两条软字幕（chi / eng） */
{
  const srtChi = path.join(SAMPLES, '_chi.srt');
  const srtEng = path.join(SAMPLES, '_eng.srt');
  writeFileSync(
    srtChi,
    '1\n00:00:00,500 --> 00:00:03,000\n第一行中文字幕\n\n2\n00:00:03,200 --> 00:00:06,000\n第二行中文字幕\n',
    'utf8',
  );
  writeFileSync(
    srtEng,
    '1\n00:00:00,500 --> 00:00:03,000\nFirst English subtitle\n\n2\n00:00:03,200 --> 00:00:06,000\nSecond English subtitle\n',
    'utf8',
  );
  make(
    'subs-multi.mkv',
    [
      [
        '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=25:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-i', srtChi, '-i', srtEng,
        '-map', '0:v', '-map', '1:a', '-map', '2', '-map', '3',
        ...H264, '-crf', '30', '-c:a', 'aac', '-c:s', 'srt',
        '-metadata:s:s:0', 'language=chi', '-metadata:s:s:1', 'language=eng',
        path.join(SAMPLES, 'subs-multi.mkv'),
      ],
    ],
    '两条软字幕，验证字幕保留',
  );
  rmSync(srtChi, { force: true });
  rmSync(srtEng, { force: true });
}

/* 5. 两条音轨 + 5.1 声道
 * 注意：-ac 必须按流指定（-ac:a:0 / -ac:a:1）。写成 -ac 6 … -ac 2 时后面的会覆盖前面的，
 * 结果第一条音轨也变成 2 声道 —— 这个坑我在造素材时真实踩到过，断言因此误报。 */
make(
  'multi-audio.mkv',
  [
    [
      '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=24:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      ...H264, '-crf', '30',
      '-c:a:0', 'ac3', '-ac:a:0', '6', '-b:a:0', '384k',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English 5.1',
      '-c:a:1', 'aac', '-ac:a:1', '2', '-b:a:1', '128k',
      '-metadata:s:a:1', 'language=chi', '-metadata:s:a:1', 'title=国语立体声',
      path.join(SAMPLES, 'multi-audio.mkv'),
    ],
  ],
  '两条音轨（含 5.1），验证声道与音轨选择',
);

/* 6. 超短视频（边界） */
make(
  'very-short.mp4',
  [
    [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=0.8',
      ...H264, '-crf', '30', '-an', path.join(SAMPLES, 'very-short.mp4'),
    ],
  ],
  '0.8 秒，验证时长边界',
);

/* 7. 4K（验证缩放与大尺寸缩略图） */
make(
  'uhd-4k.mp4',
  [
    [
      '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=24:duration=3',
      ...H264, '-crf', '34', '-an', path.join(SAMPLES, 'uhd-4k.mp4'),
    ],
  ],
  '3840×2160，验证缩放',
);

console.log('\n完成。素材目录：test-assets/samples/\n');
