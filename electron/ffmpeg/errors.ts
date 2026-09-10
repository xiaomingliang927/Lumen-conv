/**
 * ffmpeg 错误 → 人类可读提示。
 *
 * 这是「给人用」最直接的体现：用户不该看到
 *   [Parsed_scale_1 @ 000001] Failed to configure output pad on Parsed_scale_1
 * 而应该看到「目标分辨率设置有问题，请尝试保持原分辨率」。
 *
 * 原则：给一句人话结论 + 一条可操作建议 + 保留原始日志供展开，
 * 不做「吞掉错误」这种让高级用户没法自查的事。
 */
import type { JobError } from '../../shared/types';

interface Rule {
  test: RegExp;
  kind: JobError['kind'];
  message: string;
  hint: string | null;
}

/** 顺序敏感：越具体的规则排在越前面 */
const RULES: Rule[] = [
  {
    test: /No such file or directory|Could not open|Error opening input/i,
    kind: 'invalid-input',
    message: '打不开源文件',
    hint: '文件可能已被移动、重命名或删除，请把它重新拖进列表。',
  },
  {
    test: /Permission denied|Access is denied/i,
    kind: 'permission',
    message: '没有权限读写该文件',
    hint: '请关闭正在占用该文件的播放器/剪辑软件，或换一个输出目录（不要选 C 盘系统目录）。',
  },
  {
    test: /No space left on device|not enough space|There is not enough space/i,
    kind: 'disk-full',
    message: '磁盘空间不足',
    hint: '请清理目标磁盘空间，或把输出目录改到空间更大的盘。',
  },
  {
    test: /Unknown encoder|Encoder .* not found|Cannot load .*dll|Cannot load nvcuda|No capable devices found/i,
    kind: 'unsupported-codec',
    message: '当前环境不支持所选的编码器',
    hint: '这通常是显卡加速不可用导致的。请在「高级选项 → 视频编码器」里改回不带「显卡加速」的软编码（H.264 / H.265）后重试。',
  },
  {
    test: /Could not find tag for codec|Tag .* incompatible with output codec|not supported in container|Codec .* is not supported/i,
    kind: 'unsupported-codec',
    message: '源文件的编码装不进目标容器',
    hint: '请改用会重新编码的预设（例如「MP4 通用兼容」），或把输出格式换成 MKV。',
  },
  {
    test: /Invalid data found when processing input|moov atom not found|Malformed|corrupt/i,
    kind: 'invalid-input',
    message: '文件已损坏或不是完整的视频',
    hint: '如果是从网盘/浏览器下载的，请确认下载已完成；也可以先用播放器试着播一下。',
  },
  {
    test: /Conversion failed!|Error while opening encoder|Error initializing output stream/i,
    kind: 'unsupported-codec',
    message: '编码器初始化失败',
    hint: '常见原因是参数组合不被该编码器接受。请尝试把分辨率设为「保持原分辨率」，或换用软编码。',
  },
  {
    test: /height not divisible by 2|width not divisible by 2/i,
    kind: 'unsupported-codec',
    message: '目标分辨率不是偶数，H.264/H.265 不接受',
    hint: '这是应用的参数计算问题，请把分辨率改为 1080p / 720p 等标准档位后重试。',
  },
  {
    test: /Application provided invalid, non monotonically increasing dts/i,
    kind: 'invalid-input',
    message: '源文件时间戳异常',
    hint: '这类文件通常来自录屏中断。可尝试在「高级参数」里勾选「仅裁剪片段」或改用 MKV 输出。',
  },
  {
    test: /Subtitle.*codec|subtitle.*not supported/i,
    kind: 'unsupported-codec',
    message: '字幕与目标格式不兼容',
    hint: '请在字幕选项里取消勾选字幕轨道，或改用 MKV 输出（MKV 支持所有字幕类型）。',
  },
  {
    test: /Invalid argument|Option .* not found|Unrecognized option/i,
    kind: 'unknown',
    message: '参数不被当前 ffmpeg 版本接受',
    hint: '可能是自带的 ffmpeg 版本与预期不一致。请到「设置」里点「重新检测」或指定其它 ffmpeg。',
  },
];

export function diagnoseFfmpegError(
  stderr: string,
  exitCode: number | null,
  canceled: boolean,
  timedOut: boolean,
): JobError {
  const tail = tailOf(stderr, 40);

  if (canceled) {
    return {
      message: '任务已取消',
      kind: 'canceled',
      rawLog: tail,
      hint: null,
    };
  }
  if (timedOut) {
    return {
      message: '任务超时被中断',
      kind: 'unknown',
      rawLog: tail,
      hint: '文件可能损坏或位于无响应的网络位置，请复制到本地磁盘后重试。',
    };
  }

  for (const rule of RULES) {
    if (rule.test.test(stderr)) {
      return { message: rule.message, kind: rule.kind, rawLog: tail, hint: rule.hint };
    }
  }

  // 兜底：把 ffmpeg 最后一行有意义的信息带出来，至少让用户知道大概发生了什么
  const lastMeaningful = lastMeaningfulLine(stderr);
  return {
    message: lastMeaningful
      ? `转换失败：${truncate(lastMeaningful, 120)}`
      : `转换失败（ffmpeg 退出码 ${exitCode ?? '未知'}）`,
    kind: 'unknown',
    rawLog: tail,
    hint: '可展开下方「ffmpeg 原始日志」查看详情，或复制日志后反馈。',
  };
}

/** 取日志尾部若干行作为 rawLog（UI 折叠展示） */
export function tailOf(text: string, lines: number): string {
  const all = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return all.slice(-lines).join('\n');
}

function lastMeaningfulLine(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    // 跳过单纯的进度/统计行
    if (/^(frame=|fps=|size=|video:|audio:|subtitle:)/.test(l)) continue;
    if (l.startsWith('[') && l.includes(']')) {
      // 形如 [libx264 @ 0x...] 的库标识行没有信息量
      const afterBracket = l.replace(/^\[[^\]]*\]\s*/, '');
      if (afterBracket.length > 3) return afterBracket;
      continue;
    }
    return l;
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 输出前的预检：预估产物体积并检查磁盘剩余空间。
 * 提前拦住「转完 3 小时后发现磁盘满了」这种最伤人的失败。
 */
export function estimateOutputBytes(
  estimatedBitrateKbps: number,
  durationSec: number,
): number | null {
  if (!Number.isFinite(estimatedBitrateKbps) || estimatedBitrateKbps <= 0) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  // kbps → byte/s：*1000/8
  return Math.round((estimatedBitrateKbps * 1000 * durationSec) / 8);
}
