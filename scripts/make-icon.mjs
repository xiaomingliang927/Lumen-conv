/**
 * 应用图标生成脚本：build/icon.ico + build/icon.png
 *
 * 为什么用脚本生成而不是放一张现成图片：
 *   不用引入 sharp / png-to-ico 之类的额外依赖，也避免二进制资源入库难以 review。
 *
 * 图形用 ffmpeg 的 geq 滤镜逐像素计算（圆角矩形 + 播放三角）：
 *   - 不依赖任何字体（第一版用 drawtext 画 ▶ 字符，结果 \u25B6 没被解析，
 *     图标上出现了字面的 "25B" —— 这类问题只有真正看过图才会发现）
 *   - 不依赖外部素材，任何装了 ffmpeg 的机器都能复现
 *
 * 视觉：深色圆角底 #15181f + 琥珀色播放三角 #f0a03c，与界面强调色一致。
 *
 * ICO 格式说明：Vista 以后的 .ico 允许直接内嵌 PNG（而非 BMP+掩码），
 * 所以这里只需把多尺寸 PNG 拼成一个 ICO 容器。
 *
 * 用法：node scripts/make-icon.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, promises as fsp, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const buildDir = path.join(root, 'build');
const tmpDir = path.join(root, '.downloads', 'icon');

/** 需要打包进 ICO 的尺寸（Windows 会按场景挑合适的一档） */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* -------------------------------- 设计参数 -------------------------------- */

const BG = '0x15181f'; // 深色底
const FG = '0xf0a03c'; // 琥珀色（与界面 --accent 一致）

/**
 * 用 geq 逐像素计算圆角矩形 + 向右的播放三角。
 *
 * 三角 = 三个半平面的**交集**（右指三角），顶点取：
 *   A(0.33W, 0.26H) 左上、B(0.33W, 0.74H) 左下、C(0.72W, 0.5H) 右尖
 * 三条边对应的半平面：
 *   x >= 0.33W                      （左边竖直边）
 *   y >= 0.26H + k(x - 0.33W)       （下侧边：不能高于 A→C 这条线）
 *   y <= 0.74H - k(x - 0.33W)       （上侧边：不能低于 B→C 这条线）
 * 其中 k = (0.5-0.26)/(0.72-0.33) = 0.24/0.39 ≈ 0.6154
 *
 * 踩坑记录（两次都是"看过图才发现"）：
 *   1) 最初用 drawtext 画 ▶ 字符 —— 该 ffmpeg 构建不解析 \u 转义，图标上出现字面 "25B"
 *   2) 改用 geq 后，半平面的方向写反，交集变成了并集，图标成了"蝴蝶结"
 *   两版都通过了脚本的"成功"判定，所以脚本额外做了像素自检（见 verifyPng）。
 */
function buildExpr(size) {
  const r = Math.max(2, Math.round(size * 0.2));
  const W = size;
  const H = size;

  // 圆角遮罩：落在四角圆之外则 alpha = 0
  const outside =
    `(lt(X,${r})*lt(Y,${r})*gt(hypot(X-${r},Y-${r}),${r}))` +
    `+(gt(X,W-${r})*lt(Y,${r})*gt(hypot(X-(W-${r}),Y-${r}),${r}))` +
    `+(lt(X,${r})*gt(Y,H-${r})*gt(hypot(X-${r},Y-(H-${r})),${r}))` +
    `+(gt(X,W-${r})*gt(Y,H-${r})*gt(hypot(X-(W-${r}),Y-(H-${r})),${r}))`;

  const xA = 0.33 * W;
  const yTop = 0.26 * H;
  const yBot = 0.74 * H;
  const xC = 0.72 * W;
  const k = (0.5 * H - yTop) / (xC - xA);

  // 三个半平面条件相乘 = 交集；小尺寸下阈值放宽一点，避免三角被抗锯齿吃掉
  const dx = `(X-${xA.toFixed(3)})`;
  const inside =
    `gte(X,${xA.toFixed(3)})` +
    `*gte(Y,${yTop.toFixed(3)}+${k.toFixed(5)}*${dx})` +
    `*lte(Y,${yBot.toFixed(3)}-${k.toFixed(5)}*${dx})`;

  const bg = [0x15, 0x18, 0x1f];
  const fg = [0xf0, 0xa0, 0x3c];
  const ch = (i) => `(${bg[i]}+${fg[i] - bg[i]}*(${inside}))`;

  return (
    `geq=` +
    `r='${ch(0)}':` +
    `g='${ch(1)}':` +
    `b='${ch(2)}':` +
    `a='if(${outside},0,255*(${inside}))'`
  );
}

/**
 * 像素自检：把生成的 PNG 解码回来，确认左侧中带是琥珀色、右上角是深色底。
 * 这一步是为了防止"脚本说成功、图其实是错的"（本项目已经栽过两次）。
 */
function verifyPng(file, size) {
  const probe = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-vf',
      `crop=1:1:${Math.round(size * 0.4)}:${Math.round(size * 0.5)},format=rgb24`,
      '-f',
      'rawvideo',
      '-',
    ],
    { windowsHide: true, maxBuffer: 1024 },
  );
  const probe2 = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-vf',
      `crop=1:1:${Math.round(size * 0.9)}:${Math.round(size * 0.1)},format=rgb24`,
      '-f',
      'rawvideo',
      '-',
    ],
    { windowsHide: true, maxBuffer: 1024 },
  );

  const center = probe.stdout;
  const corner = probe2.stdout;
  if (!center || center.length < 3) throw new Error('自检失败：无法读取中心像素');
  if (!corner || corner.length < 3) throw new Error('自检失败：无法读取角落像素');

  const isAmber = center[0] > 180 && center[1] > 110 && center[2] < 110;
  const isDark = corner[0] < 60 && corner[1] < 60 && corner[2] < 70;

  if (!isAmber) {
    throw new Error(
      `自检失败：三角内部应为琥珀色，实际 rgb(${center[0]},${center[1]},${center[2]})`,
    );
  }
  if (!isDark) {
    throw new Error(
      `自检失败：右上角应为深色底，实际 rgb(${corner[0]},${corner[1]},${corner[2]})`,
    );
  }
  return `中心 rgb(${center[0]},${center[1]},${center[2]})，角落 rgb(${corner[0]},${corner[1]},${corner[2]})`;
}

function renderPng(size, outFile) {
  // 先在 4 倍尺寸上用 geq 计算，再降采样 —— 相当于 4× 超采样抗锯齿，
  // 否则 geq 的硬阈值会让三角边缘呈锯齿状，小尺寸图标尤其明显。
  const SS = 4;
  const big = size * SS;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${BG}:s=${big}x${big}:d=1`,
    '-vf',
    `${buildExpr(big)},scale=${size}:${size}:flags=lanczos`,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgba',
    outFile,
  ];
  const res = spawnSync(FFMPEG, args, { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !existsSync(outFile)) {
    throw new Error(`渲染 ${size}px 图标失败：${(res.stderr || '').slice(-300)}`);
  }
}

/** 把多张 PNG 打包成 ICO（内嵌 PNG 变体） */
function packIco(pngs, outFile) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width（256 记作 0）
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // 调色板数
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  writeFileSync(outFile, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
}

async function main() {
  if (!existsSync(FFMPEG)) {
    console.error('[make-icon] 找不到 ffmpeg，请先执行 node scripts/fetch-binaries.mjs');
    process.exit(1);
  }
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const pngs = [];
  for (const size of SIZES) {
    const file = path.join(tmpDir, `icon-${size}.png`);
    renderPng(size, file);
    const data = readFileSync(file);
    pngs.push({ size, data });
    // 只在最大尺寸上做像素自检（小尺寸的抗锯齿会让阈值判断不稳）
    const note = size === 256 ? `  自检通过：${verifyPng(file, size)}` : '';
    console.log(`[make-icon] ✔ ${size}×${size}  ${(data.length / 1024).toFixed(1)} KB${note}`);
  }

  const icoPath = path.join(buildDir, 'icon.ico');
  packIco(pngs, icoPath);

  const pngPath = path.join(buildDir, 'icon.png');
  await fsp.copyFile(path.join(tmpDir, 'icon-256.png'), pngPath);

  const icoSize = (await fsp.stat(icoPath)).size;
  console.log(
    `[make-icon] 已生成 ${path.relative(root, icoPath)}（${(icoSize / 1024).toFixed(1)} KB，${SIZES.length} 个尺寸）`,
  );
  console.log(`[make-icon] 已生成 ${path.relative(root, pngPath)}`);
}

main().catch((err) => {
  console.error('[make-icon] 失败：', err.message);
  process.exit(1);
});
