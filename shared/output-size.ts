/**
 * 「这次到底会输出多大」—— 输出尺寸的唯一计算处。
 *
 * 为什么要有这个模块（真实缺陷驱动）：
 *
 * 用户反馈："我换成手机的但是屏幕比例没变"。
 * 根因是界面显示的分辨率是**上限**，而实现里有条"只缩不放"规则：
 * 640×360 的源选 1080p，不会产生任何缩放，输出仍是 640×360。
 * 于是界面上写着「1080p 全高清」、卡片下面写着"按手机屏幕尺寸"，
 * 转出来却和原来一模一样 —— **界面显示了一个它不会产出的分辨率**。
 *
 * 修法不是改文案就完事，而是让"显示"和"实际执行"共用同一份计算：
 *   - ffmpeg 的滤镜链由 `filters` 字段生成（`commands.ts` 直接拼进去）
 *   - 界面的「输出 …」提示由 `width/height/note` 生成
 * 两边读同一个 `SizePlan`，就不可能再对不上。
 *
 * 纯函数、不依赖 node/electron，主进程与渲染进程共用（`shared/` 的约定）。
 */

/** 画面比例处理方式 */
export type FitMode =
  /** 保持原样（默认）：只按高度上限等比缩小，不改比例 */
  | 'off'
  /** 适配手机竖屏 9:16：画面完整，上下补黑边 */
  | 'pad'
  /** 适配手机竖屏 9:16：填满画布，裁掉画面两侧 */
  | 'crop';

export const FIT_MODES: { id: FitMode; label: string; description: string }[] = [
  { id: 'off', label: '保持原样', description: '不改比例' },
  { id: 'pad', label: '竖屏 9:16（补黑边）', description: '画面完整，上下有黑边' },
  { id: 'crop', label: '竖屏 9:16（裁剪填满）', description: '填满屏幕，两侧被裁掉' },
];

export interface SourceSize {
  width: number;
  height: number;
  /** 显示矩阵旋转角（90 / 270 时宽高互换） */
  rotation?: number;
}

export interface SizePlan {
  /** 输出画布宽高（已取偶数，yuv420p 要求） */
  width: number;
  height: number;
  /** 输出尺寸是否与源不同 */
  changes: boolean;
  /** 与源相比是缩小还是放大（正常路径永远不放大） */
  direction: 'same' | 'shrink' | 'grow';
  /** 输出画布内的画面是否需要补边（只有 pad 会出现） */
  bars: boolean;
  /** ffmpeg 滤镜片段（不含其它滤镜）；不需要缩放时为空数组 */
  filters: string[];
  /** 人话说明，界面直接显示 */
  note: string;
}

/** 取偶数：yuv420p 要求宽高都能被 2 整除 */
function even(n: number): number {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

/** 显示尺寸：旋转 90/270 时宽高互换 */
export function displaySize(src: SourceSize): { width: number; height: number } {
  const swapped = src.rotation === 90 || src.rotation === 270;
  return {
    width: swapped ? src.height : src.width,
    height: swapped ? src.width : src.height,
  };
}

/**
 * 计算输出尺寸与对应滤镜。
 *
 * @param source          源尺寸（含旋转信息）
 * @param resolutionHeight 分辨率档位的高度上限；null = 保持原分辨率
 * @param fitMode         画面比例处理方式
 */
export function planOutputSize(
  source: SourceSize,
  resolutionHeight: number | null,
  fitMode: FitMode = 'off',
): SizePlan {
  const disp = displaySize(source);
  const srcW = Math.max(2, disp.width);
  const srcH = Math.max(2, disp.height);
  const srcShort = Math.min(srcW, srcH);

  /* ---------------- 竖屏适配：画布按 9:16，内容按 pad / crop 放进去 ---------------- */
  if (fitMode === 'pad' || fitMode === 'crop') {
    /*
     * 画布短边 = min(分辨率上限, 源短边)。
     *
     * 取 min 是为了**不放大**：源短边 360 的视频选 1080p 时，
     * 画布就是 360×640，而不是把画面拉大到 1080×1920 再补一大片黑边。
     * 这样"只缩不放"这条规则在竖屏模式下依然成立。
     */
    const cap = resolutionHeight ?? srcShort;
    const canvasShort = even(Math.min(cap, srcShort));
    const canvasW = canvasShort;
    const canvasH = even((canvasShort * 16) / 9);

    if (fitMode === 'pad') {
      return {
        width: canvasW,
        height: canvasH,
        changes: true,
        direction: canvasW < srcW || canvasH < srcH ? 'shrink' : 'same',
        bars: true,
        /*
         * 末尾的 `setsar=1` 不是装饰。
         *
         * `force_original_aspect_ratio` 算出来的尺寸常常是小数（640×360 放进 360×640
         * 画布是 360×202.5），ffmpeg 会取整后**改 SAR 来补偿**。结果是产物宽高看着对、
         * 但 ffprobe 读出来的 displayWidth 变成 361 —— 实测踩到，回读尺寸对不上断言。
         * 补边/裁切之后画布尺寸已经是精确值，强制 1:1 像素既让尺寸可预期，
         * 也避免播放器对非方形像素做二次缩放。
         */
        filters: [
          `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease:flags=lanczos`,
          `pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2:black`,
          'setsar=1',
        ],
        note:
          `竖屏 ${canvasW}×${canvasH}：画面完整放进画布，上下留黑边` +
          (canvasShort < (resolutionHeight ?? srcShort)
            ? `（画布短边取源短边 ${canvasShort}，不放大）`
            : ''),
      };
    }
    return {
      width: canvasW,
      height: canvasH,
      changes: true,
      direction: canvasW < srcW || canvasH < srcH ? 'shrink' : 'same',
      bars: false,
      filters: [
        `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${canvasW}:${canvasH}`,
        'setsar=1',
      ],
      note:
        `竖屏 ${canvasW}×${canvasH}：填满画布，横屏画面两侧会被裁掉` +
        `（约保留原宽的 ${Math.max(1, Math.round((canvasW / canvasH / (srcW / srcH)) * 100))}%）`,
    };
  }

  /* ---------------- 默认：只按高度上限等比缩小，不改比例 ---------------- */
  if (resolutionHeight === null) {
    return {
      width: even(srcW),
      height: even(srcH),
      changes: false,
      direction: 'same',
      bars: false,
      filters: [],
      note: `保持原分辨率 ${even(srcW)}×${even(srcH)}`,
    };
  }

  if (srcH > resolutionHeight) {
    const outH = even(resolutionHeight);
    const outW = even((srcW / srcH) * outH);
    return {
      width: outW,
      height: outH,
      changes: true,
      direction: 'shrink',
      bars: false,
      filters: [`scale=-2:${outH}:flags=lanczos`],
      note: `缩放到 ${outW}×${outH}（等比，源 ${srcW}×${srcH}）`,
    };
  }

  if (srcH < resolutionHeight) {
    return {
      width: even(srcW),
      height: even(srcH),
      changes: false,
      direction: 'same',
      bars: false,
      filters: [],
      note: `保持原分辨率 ${even(srcW)}×${even(srcH)}（源低于 ${resolutionHeight}p 上限，不放大）`,
    };
  }

  return {
    width: even(srcW),
    height: even(srcH),
    changes: false,
    direction: 'same',
    bars: false,
    filters: [],
    note: `保持原分辨率 ${even(srcW)}×${even(srcH)}（正好等于 ${resolutionHeight}p 上限）`,
  };
}

/** 画布短边/长边比例，UI 用来解释"为什么不是 1920×1080" */
export const PORTRAIT_RATIO_TEXT = '9:16';
