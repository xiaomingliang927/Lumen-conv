<script setup lang="ts">
/**
 * 右侧详情与参数面板。
 *
 * 信息架构（自上而下，两种模式共用同一套骨架）：
 *   0. 模式切换（推荐设置 / 自定义）+ 当前方案摘要
 *   1. 专业参数 —— **仅自定义模式出现**，且放在最上面（折叠态：格式 / 编码器 / 音轨 / 字幕 / 裁剪 / 命名）
 *   2. 视频信息卡片 —— 满足需求 1 的「加载视频信息显示」，默认收起成一行摘要
 *   3. 你要拿去干什么（用途） —— 主决策，决定格式/编码/分辨率/体积上限
 *   4. 在哪播 / 多大体积 —— 次决策
 *   5. 质量与尺寸 —— 帧率只在自定义模式出现
 *
 * 「给人用」的取舍：推荐模式只露 2/3/4/5，专业参数整体隐藏；自定义模式把它摊开。
 *
 * 两条来之不易的教训（都来自用户反馈"推荐设置和自定义没区别啊"，见 DECISIONS.md D-018）：
 *   ① **模式的差别必须落在首屏**。差异藏在折叠线以下 = 用户认为没区别。
 *      所以专业参数入口在最上面，而不是挂在面板末尾。
 *   ② **别再自动展开专业参数**。入口在首屏之后，自动展开会把「用途 / 在哪播 / 质量」
 *      推到 1000px 之外，用户一进自定义模式就失去参照物。
 *
 * 但每调一个参数都实时给出「预计体积」，因为这是用户最关心的隐性目标。
 */
import { computed, ref, watch } from 'vue';
import {
  CONVERSION_PRESETS,
  FPS_PRESETS,
  QUALITY_PRESETS,
  RESOLUTION_PRESETS,
  activeFile,
  activePreset,
  activeProbe,
  applyCompatibilityFix,
  clearActiveOverride,
  compatibilityIssues,
  effectiveOptions,
  encoderAvailability,
  options,
  setActiveOverride,
  settings,
  showToast,
  startConversion,
  updateSettings,
  availableVideoCodecs,
  predictedOutput,
} from '@/composables/useStore';
import type { ConversionOptions } from '@shared/types';
import { CONTAINERS, VIDEO_CODECS, AUDIO_CODECS } from '@shared/presets';
import { DEVICES, USE_CASES, findDevice, findUseCase } from '@shared/use-cases';
import {
  fileExtension,
  formatBitrate,
  formatBytes,
  formatChannels,
  formatDuration,
  formatFps,
  formatRatio,
  formatSampleRate,
  languageName,
} from '@/utils/format';

const advancedOpen = ref(false);

/**
 * 视频信息是否展开。
 *
 * 默认**收起**：这 8 行信息占了约 270px，会把下面的「用途卡片 / 在哪播 / 质量」
 * 全部挤出首屏 —— 用户反馈"推荐设置和自定义没区别啊"，实测根因就在这里：
 * 首屏只看到视频信息，两种模式的差别全在折叠线下。
 *
 * 收起时用一行摘要代替（时长 · 分辨率 · 编码），需要细节再展开。
 */
const infoOpen = ref(false);

/**
 * 参数变更分两类处理，这个区分很重要（是一个真实 bug 的教训）：
 *
 * - **全局偏好**（用途 / 质量 / 分辨率 / 帧率 / 编码器 / 音频编码 / 文件名模板）：
 *   表达的是"我想把视频转成什么样"，属于跨文件复用的意图。
 *   早期实现把它们都写进了 setActiveOverride()（按文件覆盖），后果是
 *   **用户调好的参数一换文件就全丢**，而界面上看不出任何征兆。
 *
 * - **文件特有设置**（裁剪区间 / 字幕轨道勾选）：
 *   天然与具体文件绑定（"这个视频从 1:30 开始"），保持按文件覆盖是对的。
 */

/** 写全局偏好 */
const setGlobal = (patch: Partial<ConversionOptions>): void => {
  options.value = { ...options.value, ...patch };
};

/** 写当前文件的专属设置 */
const setLocal = (patch: Partial<ConversionOptions>): void => setActiveOverride(patch);

/* ------------------------------------------------------------------ *
 * 两种模式：推荐 / 自定义
 *
 * 背景（用户反馈"很奇怪"）：原来把「用途卡片」和一大堆专业参数
 * （格式 / 编码器 / 帧率 / 字幕 / 裁剪 / 命名 / 元数据）同时堆在一个面板里，
 * 大众用户被淹没，专业用户又觉得用途卡片是多余的中间层。
 *
 * 现在分两个模式：
 *   推荐 —— 只留"选用途 + 在哪播/多大 + 少量关键参数"，其余全部隐藏。
 *            大众用户不需要知道编码器是什么。
 *   自定义 —— 展开全部专业参数，并默认把用途当模板。
 *
 * 模式选择持久化在设置里（appMode），而不是只存在界面状态：
 * 专业用户不想每次启动都重新展开一遍。
 * ------------------------------------------------------------------ */

const appMode = computed<'recommended' | 'custom'>(() => settings.value?.appMode ?? 'recommended');

async function setAppMode(mode: 'recommended' | 'custom'): Promise<void> {
  await updateSettings({ appMode: mode });
  /*
   * 切到自定义时**不再**自动展开专业参数。
   *
   * 原来这里写的是 `advancedOpen.value = true`（"省一次点击"）。当时专业参数在面板末尾、
   * 折叠线以下，自动展开只是让页面变长，用户掉进字段堆里也不觉得突兀。
   *
   * 现在专业参数入口搬到了面板**最上面**（就是为了让两种模式在首屏就能看出区别），
   * 自动展开的后果就变了：一进自定义模式，首屏全是要填的专业字段，
   * 而「用途 / 在哪播 / 质量」这些主决策被推到 1000px 之外 —— 用户失去参照物。
   *
   * 所以改成默认收起：入口就在第一屏最上方（一眼能看出和推荐模式不一样），
   * 想调参数再点开，多一次点击换回一个有上下文的界面，这个交换是划算的。
   */
}

/** 体积上限输入：空字符串 / 0 / 负数都视为"不限制" */
function setSizeLimit(raw: string): void {
  const n = Number(raw);
  setGlobal({ sizeLimitMb: raw.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n });
}

/**
 * 选择用途：一次把容器、编码器、分辨率、质量、体积上限都设好。
 * 这是"用户只说他要干什么、技术决策由软件负责"的核心入口。
 */
function chooseUseCase(id: string): void {
  const uc = findUseCase(id);
  if (!uc) return;
  const preset = CONVERSION_PRESETS.find((x) => x.id === uc.presetId);
  if (!preset) return;
  // 用途里若有编码器硬约束（例如"发微信"必须 H.264），优先用约束值
  const videoCodecId = uc.requiresCodec ?? preset.videoCodecId ?? 'none';
  setGlobal({
    useCaseId: uc.id,
    presetId: preset.id,
    videoCodecId,
    audioCodecId: preset.audioCodecId,
    qualityId: uc.qualityId,
    resolutionId: uc.resolutionId,
    sizeLimitMb: uc.sizeLimitMb,
    subtitleStreamIndexes: [],
    audioStreamIndexes: [],
  });
  // 用途与当前设备冲突时，顺手把设备相关的问题一并提醒（compatibilityIssues 会自动算）
}

/**
 * 当前文件的生效值（全局偏好 + 本文件覆盖），所有控件都用它回显。
 *
 * 这样即使某个文件带着旧的 overrides，界面显示的也是**真正会被用于转换的值**，
 * 不会出现"界面显示 A、实际转出 B"。
 */
const eff = computed<ConversionOptions>(() => {
  const file = activeFile.value;
  return file ? effectiveOptions(file) : options.value;
});

const probe = computed(() => activeProbe.value);
const video = computed(() => probe.value?.video.find((v) => !v.isAttachedPic) ?? null);
const primaryAudio = computed(() => probe.value?.audio[0] ?? null);

const presetGroups = computed(() => {
  const order: { key: string; title: string; desc: string }[] = [
    { key: 'common', title: '常用', desc: '不确定就选这里' },
    { key: 'compress', title: '压缩', desc: '体积优先' },
    { key: 'audio', title: '音频', desc: '只导出声音' },
    { key: 'advanced', title: '进阶', desc: '特殊需求' },
  ];
  return order
    .map((g) => ({
      ...g,
      items: CONVERSION_PRESETS.filter((x) => x.group === g.key),
    }))
    .filter((g) => g.items.length > 0);
});

/** 当前用途（用于展示说明与提示） */
const activeUseCase = computed(() => findUseCase(options.value.useCaseId) ?? null);

/**
 * 当前参数与所选用途的推荐值有哪些不一致。
 *
 * 为什么需要它：用户在「专业参数」里改一个下拉框，很容易忘记上面的用途卡片
 * 已经不再代表实际参数了（例如选了「发微信」却手动把编码器改成 H.265）。
 * 早期实现里卡片仍会高亮并继续显示该用途的提示，等于在误导用户。
 * 现在把差异显式列出来，并给一个"恢复推荐值"的出口。
 */
const deviations = computed<{ label: string; current: string; expected: string }[]>(() => {
  const uc = activeUseCase.value;
  if (!uc) return [];
  const out: { label: string; current: string; expected: string }[] = [];

  const preset = CONVERSION_PRESETS.find((p) => p.id === uc.presetId);
  if (preset && options.value.presetId !== preset.id) {
    const cur = CONVERSION_PRESETS.find((p) => p.id === options.value.presetId);
    out.push({ label: '输出格式', current: cur?.label ?? options.value.presetId, expected: preset.label });
  }
  if (uc.requiresCodec && options.value.videoCodecId !== uc.requiresCodec) {
    out.push({
      label: '视频编码器',
      current: options.value.videoCodecId.toUpperCase(),
      expected: uc.requiresCodec.toUpperCase(),
    });
  }
  if (options.value.resolutionId !== uc.resolutionId) {
    const cur = RESOLUTION_PRESETS.find((r) => r.id === options.value.resolutionId);
    const exp = RESOLUTION_PRESETS.find((r) => r.id === uc.resolutionId);
    out.push({ label: '分辨率', current: cur?.label ?? options.value.resolutionId, expected: exp?.label ?? uc.resolutionId });
  }
  if (options.value.qualityId !== uc.qualityId) {
    const cur = QUALITY_PRESETS.find((q) => q.id === options.value.qualityId);
    const exp = QUALITY_PRESETS.find((q) => q.id === uc.qualityId);
    out.push({ label: '质量', current: cur?.label ?? options.value.qualityId, expected: exp?.label ?? uc.qualityId });
  }
  if ((options.value.sizeLimitMb ?? null) !== (uc.sizeLimitMb ?? null)) {
    out.push({
      label: '体积上限',
      current: options.value.sizeLimitMb ? `${options.value.sizeLimitMb} MB` : '不限',
      expected: uc.sizeLimitMb ? `${uc.sizeLimitMb} MB` : '不限',
    });
  }
  return out;
});

/** 把参数恢复成所选用途的推荐值 */
function restoreUseCase(): void {
  const uc = activeUseCase.value;
  if (!uc) return;
  chooseUseCase(uc.id);
  showToast(`已恢复「${uc.label}」的推荐设置`, 'info', 2500);
}

/** 当前播放设备（用于展示说明） */
const activeDevice = computed(() => findDevice(options.value.deviceId) ?? null);

/**
 * 当前方案的参数摘要（一行）。
 *
 * 为什么需要它：用户反馈"推荐设置和自定义没区别啊" —— 实测发现两种模式的差别
 * （专业参数入口、帧率下拉）全在**折叠线下**，首屏内容几乎一样，所以看不出区别。
 * 把"这一套参数到底会怎么转"压成一行放在最上面，用户不必滚动就能看清当前方案，
 * 切换模式时这一行也会立刻变化。
 */
const planSummary = computed(() => {
  const uc = activeUseCase.value;
  const preset = CONVERSION_PRESETS.find((p) => p.id === options.value.presetId);
  const res = RESOLUTION_PRESETS.find((r) => r.id === options.value.resolutionId);
  const quality = QUALITY_PRESETS.find((q) => q.id === options.value.qualityId);
  const codec = (options.value.videoCodecId || '').replace(/_(nvenc|qsv|amf)$/, '').toUpperCase();
  const parts: string[] = [];
  if (preset) parts.push(preset.label);
  if (codec && codec !== 'NONE') parts.push(codec);
  if (res) parts.push(res.label);
  if (quality && !options.value.sizeLimitMb) parts.push(quality.label);
  if (options.value.sizeLimitMb) parts.push(`≤${options.value.sizeLimitMb} MB`);
  return { useCase: uc?.label ?? '自定义组合', detail: parts.join(' · ') };
});

/** 专业参数里的容器/格式下拉：按分组列出全部预设 */
const presetOptions = computed(() =>
  presetGroups.value.map((g) => ({
    group: g.title,
    items: g.items.map((p) => ({ id: p.id, label: p.label })),
  })),
);

/** 当前预设允许的编码器（并按硬件可用性标注） */
const codecChoices = computed(() => {
  const list = availableVideoCodecs.value;
  // 直通 / 纯音频预设不展示视频编码器选择
  if (!list.length) return [];
  return list;
});

const currentContainer = computed(() => CONTAINERS[activePreset.value.container]);
const isAudioOnly = computed(() => currentContainer.value.videoCodecs.length === 0);
const isRemux = computed(() => eff.value.videoCodecId === 'copy');

const audioChoices = computed(() =>
  AUDIO_CODECS.filter((a) => currentContainer.value.audioCodecs.includes(a.id)),
);

const selectedSubs = computed({
  get: () => eff.value.subtitleStreamIndexes,
  set: (v: number[]) => setLocal({ subtitleStreamIndexes: v }),
});

function toggleSub(index: number): void {
  const cur = new Set(eff.value.subtitleStreamIndexes);
  if (cur.has(index)) cur.delete(index);
  else cur.add(index);
  setLocal({ subtitleStreamIndexes: [...cur] });
}

/**
 * 选择输出预设。
 *
 * 这里**必须写全局 options，不能走 setActiveOverride（按文件覆盖）**。
 * 这是一个真实 bug 的修复：早期实现写进了当前文件的 overrides，但界面上的
 * 选中态是拿全局 `options.presetId` 判定的，两者不一致，导致：
 *   1) 点任何预设卡片，高亮都停在「MP4 通用兼容」不动 —— 看起来"点了没反应"
 *   2) 但转换时用的确实是点过的那个预设（实际生效了，只是界面不反映）
 *   3) 切换到另一个文件后，之前的选择丢失
 * 预设表达的是"我要转成什么格式"，属于全局偏好，不该随文件切换而重置。
 */
function choosePreset(id: string): void {
  const preset = CONVERSION_PRESETS.find((x) => x.id === id);
  if (!preset) return;
  const currentUseCase = findUseCase(options.value.useCaseId);
  // 用途有编码器硬约束时（例如「发微信」必须 H.264），仍然遵守约束
  const videoCodecId = currentUseCase?.requiresCodec ?? preset.videoCodecId ?? 'none';

  options.value = {
    ...options.value,
    presetId: preset.id,
    videoCodecId,
    audioCodecId: preset.audioCodecId,
    qualityId: preset.qualityId,
    resolutionId: preset.resolutionId,
    /*
     * 刻意**不清掉 useCaseId**。
     *
     * 试过"手动改格式就解除用途绑定"，结果是：卡片不亮了，但用户也失去了
     * "我本来想干什么 / 怎么回去"的线索 —— 等于把问题从一个坑挪到另一个坑。
     * 更好的做法是保留用途标记，让卡片显式列出"哪些参数被改动了"并给一键恢复
     * （见 deviations / restoreUseCase）。
     */
    // 直通预设下音轨也必须直通，否则会出现「视频直通 + 音频重编码」的隐性行为
    ...(preset.videoCodecId === 'copy' && CONTAINERS[preset.container].audioCodecs.includes('copy')
      ? { audioCodecId: 'copy' }
      : {}),
    subtitleStreamIndexes: preset.container === 'mkv' ? options.value.subtitleStreamIndexes : [],
    audioStreamIndexes: [],
  };
}

const estimatedText = computed(() => {
  const est = predictedOutput.value;
  if (!est || !est.bytes) return null;
  return {
    size: formatBytes(est.bytes),
    ratio: probe.value ? formatRatio(est.bytes, probe.value.sizeBytes) : null,
    note: est.note,
  };
});

const hasOverride = computed(() => Boolean(activeFile.value?.overrides));

function resetToGlobal(): void {
  clearActiveOverride();
  showToast('已恢复为全局设置', 'info', 2000);
}

async function convertThis(): Promise<void> {
  const f = activeFile.value;
  if (!f) return;
  await startConversion([f.path]);
}

/** 模板里不能直接访问 window，包一层 */
function revealInFolder(p: string): void {
  void window.converter.revealInFolder(p);
}

/* 文件名模板预览 */
const templatePreview = computed(() => {
  const name = probe.value?.fileName.replace(/\.[^.]+$/, '') ?? '视频文件名';
  const rendered = eff.value.fileNameTemplate
    .replace(/\{name\}/g, name)
    .replace(/\{preset\}/g, activePreset.value.label)
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10));
  const ext = currentContainer.value.extension || 'mp4';
  return `${rendered}.${ext}`;
});

/**
 * 文件名命名的可选方案。
 *
 * 原来只有一个裸输入框，要用户自己敲 `{name}` 这种占位符 —— 对普通用户等于没有引导。
 * 现在把最常见的几种命名做成选项，同时保留「自定义」让愿意写模板的人自己填。
 * 选项的 value 就是模板字符串，所以底层逻辑完全不用改。
 */
const NAME_PRESETS: { id: string; label: string; template: string }[] = [
  { id: 'keep', label: '保持原文件名', template: '{name}' },
  { id: 'suffix', label: '原名 + 用途后缀', template: '{name}-转换' },
  { id: 'date-first', label: '日期 + 原名', template: '{date}-{name}' },
  { id: 'preset-suffix', label: '原名 + 输出格式', template: '{name}-{preset}' },
  { id: 'custom', label: '自定义模板…', template: '' },
];

/** 当前模板是否匹配某个预设（匹配不上就落到「自定义」） */
const matchedNamePreset = computed(() => {
  const t = eff.value.fileNameTemplate;
  const hit = NAME_PRESETS.find((p) => p.id !== 'custom' && p.template === t);
  return hit?.id ?? 'custom';
});

/**
 * 下拉框显示的选项。
 *
 * 刻意用一个本地 ref 而不是直接绑 `matchedNamePreset`：
 * 用户选「自定义」时模板还没变（仍是上一个预设的值），计算属性依旧算出旧选项，
 * Vue 会在下一次 patch 时把受控 select 的值写回去 —— 表现为"点了自定义又弹回来"。
 * 用本地 ref 记录"用户当前选的是哪一项"，展示与判定就解耦了；
 * 当模板被外部改掉（例如切了用途、或手输模板）时再同步回来。
 */
const namePresetChoice = ref(matchedNamePreset.value);
watch(matchedNamePreset, (v) => {
  // 只在用户没主动选「自定义」时跟随外部变化，避免把用户的选择冲掉
  if (namePresetChoice.value !== 'custom') namePresetChoice.value = v;
});

function chooseNamePreset(id: string): void {
  const p = NAME_PRESETS.find((x) => x.id === id);
  if (!p) return;
  namePresetChoice.value = id;
  if (p.id === 'custom') {
    // 切到自定义时保留当前模板值，让用户接着改（不重置成空）
    return;
  }
  setGlobal({ fileNameTemplate: p.template });
}

const quality = computed(() => QUALITY_PRESETS.find((q) => q.id === eff.value.qualityId));

// 是否保留元数据属于「我想怎么转」的偏好，跨文件复用，所以走全局
const keepMetadata = computed({
  get: () => eff.value.keepMetadata,
  set: (v: boolean) => setGlobal({ keepMetadata: v }),
});

// 裁剪属于文件特有设置，走按文件覆盖
const trimEnabled = ref(false);
function enableTrim(): void {
  const dur = probe.value?.durationSec ?? 0;
  trimEnabled.value = true;
  setLocal({ trimStartSec: 0, trimEndSec: Math.min(dur, 10) });
}
function disableTrim(): void {
  trimEnabled.value = false;
  setLocal({ trimStartSec: null, trimEndSec: null });
}
const trimStart = computed({
  get: () => eff.value.trimStartSec ?? 0,
  set: (v: number) =>
    setLocal({
      trimStartSec: Math.max(0, Math.min(v, eff.value.trimEndSec ?? probe.value?.durationSec ?? 0)),
    }),
});
const trimEnd = computed({
  get: () => eff.value.trimEndSec ?? probe.value?.durationSec ?? 0,
  set: (v: number) =>
    setLocal({
      trimEndSec: Math.max(eff.value.trimStartSec ?? 0, Math.min(v, probe.value?.durationSec ?? 0)),
    }),
});

void fileExtension;
void formatBitrate;
void encoderAvailability;
void VIDEO_CODECS;
</script>

<template>
  <aside class="details">
    <div v-if="!probe" class="empty-state">
      <h3>未选择文件</h3>
      <p class="muted">从左侧选择一个视频，这里会显示它的详细信息与转换设置</p>
    </div>

    <div v-else class="details-scroll">
      <!-- 模式切换：推荐（大众）/ 自定义（专业） -->
      <div class="mode-switch">
        <button
          class="mode-btn"
          :class="{ active: appMode === 'recommended' }"
          @click="setAppMode('recommended')"
        >
          推荐设置
          <small>选用途就够了</small>
        </button>
        <button
          class="mode-btn"
          :class="{ active: appMode === 'custom' }"
          @click="setAppMode('custom')"
        >
          自定义
          <small>我要自己调参数</small>
        </button>
      </div>

      <!--
        当前方案摘要：一行说清"这套参数会怎么转"。
        放在模式切换正下方，让两种模式的差别在**首屏**就能看见
        （不然差别全在折叠线下，用户会觉得"两个模式没区别"）。
      -->
      <div class="plan-summary">
        <span class="plan-usecase">{{ planSummary.useCase }}</span>
        <span class="plan-detail">{{ planSummary.detail }}</span>
      </div>

      <!--
        自定义模式的"专业参数"入口放在首屏。
        之前它在质量区块之后（约 900px 处，折叠线下），于是用户切到自定义模式后
        首屏看到的还是推荐模式那套内容，自然会觉得"两个模式没区别"。
      -->
      <section v-if="appMode === 'custom'" class="block pro-block">
        <button class="advanced-toggle" @click="advancedOpen = !advancedOpen">
          <svg viewBox="0 0 12 12" width="10" height="10" :style="{ transform: advancedOpen ? 'rotate(90deg)' : '' }">
            <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          专业参数
          <!-- 这里只列**里面真正有的**项目：帧率不在此处，它在「质量与尺寸」里（自定义模式才出现） -->
          <span class="muted">格式 / 编码器 / 音轨 / 字幕 / 裁剪 / 命名</span>
        </button>

        <div v-if="advancedOpen" class="advanced-body">

          <!-- 用途已经把常用组合包好了；这里给"我就想自己指定容器"的用户留出口 -->
          <label class="field">
            <span class="field-label">输出格式（手动指定）</span>
            <select
              class="select"
              :value="options.presetId"
              @change="choosePreset(($event.target as HTMLSelectElement).value)"
            >
              <optgroup v-for="g in presetOptions" :key="g.group" :label="g.group">
                <option v-for="p in g.items" :key="p.id" :value="p.id">{{ p.label }}</option>
              </optgroup>
            </select>
            <span class="field-hint">
              手动改格式会覆盖所选用途的推荐设置；改完可以再点一次用途卡片恢复
            </span>
          </label>

          <div class="field-grid">
            <label v-if="!isAudioOnly && codecChoices.length" class="field">
              <span class="field-label">视频编码器</span>
              <select
                class="select"
                :value="eff.videoCodecId"
                @change="setGlobal({ videoCodecId: ($event.target as HTMLSelectElement).value })"
              >
                <option
                  v-for="c in codecChoices"
                  :key="c.id"
                  :value="c.id"
                  :disabled="!c.available"
                >
                  {{ c.label }}{{ c.available ? '' : `（不可用：${c.unavailableReason ?? '未知'}）` }}
                </option>
              </select>
              <span class="field-hint">带「显卡加速」的选项需要对应显卡支持</span>
            </label>

            <label v-if="probe.hasAudio && !isRemux" class="field">
              <span class="field-label">音频编码</span>
              <select
                class="select"
                :value="eff.audioCodecId"
                @change="setGlobal({ audioCodecId: ($event.target as HTMLSelectElement).value })"
              >
                <option v-for="a in audioChoices" :key="a.id" :value="a.id">
                  {{ a.label }} — {{ a.description }}
                </option>
              </select>
            </label>
          </div>

          <!-- 字幕 -->
          <div v-if="probe.subtitle.length" class="field">
            <span class="field-label">字幕轨道</span>
            <div class="check-list">
              <label
                v-for="s in probe.subtitle"
                :key="s.index"
                class="check-item"
                :class="{ disabled: s.codec === 'hdmv_pgs_subtitle' && activePreset.container === 'mp4' }"
              >
                <input
                  type="checkbox"
                  :checked="selectedSubs.includes(s.index)"
                  @change="toggleSub(s.index)"
                />
                <span class="check-label">
                  {{ s.title || languageName(s.language) || `轨道 #${s.index}` }}
                  <span class="chip">{{ s.codec }}</span>
                  <span v-if="s.isForced" class="chip chip-info">强制</span>
                  <span v-if="!s.isTextBased" class="chip chip-accent" title="图形字幕，MP4 无法直接封装">图形</span>
                </span>
              </label>
            </div>
            <span class="field-hint">
              默认不保留字幕。MP4 只支持文字字幕；图形字幕（PGS/VobSub）请选择 MKV 输出。
            </span>
          </div>

          <!-- 裁剪 -->
          <div class="field">
            <span class="field-label">
              裁剪片段
              <label class="inline-switch">
                <span class="switch">
                  <input type="checkbox" :checked="trimEnabled" @change="trimEnabled ? disableTrim() : enableTrim()" />
                  <span class="switch-track" />
                </span>
              </label>
            </span>
            <div v-if="trimEnabled" class="trim-row">
              <label class="trim-field">
                <span class="muted">开始</span>
                <input
                  class="input mono"
                  type="number"
                  min="0"
                  :max="probe.durationSec"
                  step="0.1"
                  :value="trimStart"
                  @input="trimStart = Number(($event.target as HTMLInputElement).value)"
                />
                <span class="muted mono">{{ formatDuration(trimStart) }}</span>
              </label>
              <label class="trim-field">
                <span class="muted">结束</span>
                <input
                  class="input mono"
                  type="number"
                  min="0"
                  :max="probe.durationSec"
                  step="0.1"
                  :value="trimEnd"
                  @input="trimEnd = Number(($event.target as HTMLInputElement).value)"
                />
                <span class="muted mono">{{ formatDuration(trimEnd) }}</span>
              </label>
            </div>
            <span v-else class="field-hint">开启后可只转换视频中的一段（例如做 GIF 动图时截 5 秒）</span>
          </div>

          <!-- 文件名与元数据 -->
          <div class="field-grid">
            <label class="field">
              <span class="field-label">输出文件命名</span>
              <!--
                key 是必要的：下面那个自定义输入框用 v-if 控制显隐，
                兄弟节点数量会变。没有 key 时 Vue 在复用时可能把 select 的
                受控值对错元素，表现为"选了自定义又弹回上一个选项"（实测踩到）。
              -->
              <select
                key="name-preset-select"
                class="select"
                :value="namePresetChoice"
                @change="chooseNamePreset(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="p in NAME_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
              </select>
              <input
                v-if="namePresetChoice === 'custom'"
                key="name-custom-input"
                class="input template-input"
                :value="eff.fileNameTemplate"
                placeholder="{name}"
                @input="setGlobal({ fileNameTemplate: ($event.target as HTMLInputElement).value })"
              />
              <span class="field-hint">
                输出文件名：<span class="mono">{{ templatePreview }}</span>
                <template v-if="namePresetChoice === 'custom'">
                  <br />可用变量：<code>{name}</code> 原文件名、<code>{preset}</code> 输出格式、
                  <code>{date}</code> 日期
                </template>
              </span>
            </label>
          </div>

          <label class="check-item">
            <input v-model="keepMetadata" type="checkbox" />
            <span class="check-label">保留元数据与章节<small class="muted">（标题、作者、章节标记）</small></span>
          </label>
        </div>
      </section>

      <!-- ① 视频信息（默认收起成一行摘要，把首屏让给"选用途"） -->
      <section class="block info-block">
        <header class="block-head">
          <button class="info-toggle" @click="infoOpen = !infoOpen">
            <svg viewBox="0 0 12 12" width="10" height="10" :style="{ transform: infoOpen ? 'rotate(90deg)' : '' }">
              <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
            <h4>视频信息</h4>
          </button>
          <button class="btn btn-sm btn-ghost" @click="revealInFolder(probe.path)">
            在文件夹中显示
          </button>
        </header>

        <!-- 收起时的一行摘要：够用，且不占地方 -->
        <div v-if="!infoOpen" class="info-summary selectable">
          <span class="mono">{{ formatDuration(probe.durationSec) }}</span>
          <span class="sep">·</span>
          <span>{{ formatBytes(probe.sizeBytes) }}</span>
          <template v-if="video">
            <span class="sep">·</span>
            <span class="mono">{{ video.displayWidth }}×{{ video.displayHeight }}</span>
          </template>
          <span class="sep">·</span>
          <span>{{ probe.formatLongName }}</span>
          <template v-if="video">
            <span class="sep">·</span>
            <span class="chip">{{ video.codec.toUpperCase() }}</span>
          </template>
          <span v-if="video?.isHdr" class="chip chip-accent">HDR</span>
          <span v-if="video && video.bitDepth >= 10" class="chip chip-info">10bit</span>
        </div>

        <div v-else class="info-grid selectable">
          <div class="info-row">
            <span class="k">容器</span>
            <span class="v">{{ probe.formatLongName }}</span>
          </div>
          <div class="info-row">
            <span class="k">时长</span>
            <span class="v">{{ formatDuration(probe.durationSec) }}</span>
          </div>
          <div class="info-row">
            <span class="k">文件大小</span>
            <span class="v">{{ formatBytes(probe.sizeBytes) }}</span>
          </div>
          <div class="info-row">
            <span class="k">总码率</span>
            <span class="v">{{ formatBitrate(probe.bitrateKbps) }}</span>
          </div>

          <template v-if="video">
            <div class="info-row">
              <span class="k">画面</span>
              <span class="v">
                {{ video.displayWidth }}×{{ video.displayHeight }}
                <span class="muted">· {{ formatFps(video.avgFps || video.fps) }}</span>
              </span>
            </div>
            <div class="info-row">
              <span class="k">视频编码</span>
              <span class="v">
                {{ video.codec.toUpperCase() }}
                <span v-if="video.profile" class="muted">· {{ video.profile }}</span>
              </span>
            </div>
            <div class="info-row">
              <span class="k">色彩</span>
              <span class="v">
                {{ video.pixFmt || '未知' }}
                <span v-if="video.bitDepth >= 10" class="chip chip-info">10bit</span>
                <span v-if="video.isHdr" class="chip chip-accent">HDR</span>
              </span>
            </div>
            <div v-if="video.rotation" class="info-row">
              <span class="k">旋转</span>
              <span class="v">{{ video.rotation }}°（转换时会自动转正）</span>
            </div>
          </template>

          <div v-if="primaryAudio" class="info-row">
            <span class="k">音频编码</span>
            <span class="v">
              {{ primaryAudio.codec.toUpperCase() }}
              <span class="muted">· {{ formatChannels(primaryAudio.channels, primaryAudio.channelLayout) }}</span>
              <span class="muted">· {{ formatSampleRate(primaryAudio.sampleRate) }}</span>
            </span>
          </div>
          <div v-if="probe.audio.length > 1" class="info-row">
            <span class="k">音轨</span>
            <span class="v">{{ probe.audio.length }} 条（默认使用第一条）</span>
          </div>
          <div v-if="probe.subtitle.length" class="info-row">
            <span class="k">字幕</span>
            <span class="v">{{ probe.subtitle.length }} 条</span>
          </div>
          <div v-if="probe.chapters.length" class="info-row">
            <span class="k">章节</span>
            <span class="v">{{ probe.chapters.length }} 个</span>
          </div>
          <div v-if="video && !video.width" class="info-row">
            <span class="k">类型</span>
            <span class="v">纯音频文件</span>
          </div>
        </div>
      </section>

      <!-- ② 输出格式 -->
      <!-- ② 要拿去干什么（主决策） -->
      <section class="block">
        <header class="block-head">
          <h4>你要拿去干什么</h4>
          <span class="muted">选一个用途就够了，细节我来定</span>
        </header>

        <div class="usecase-grid">
          <button
            v-for="uc in USE_CASES"
            :key="uc.id"
            class="usecase-card"
            :class="{ active: options.useCaseId === uc.id }"
            :aria-pressed="options.useCaseId === uc.id"
            :title="uc.description"
            @click="chooseUseCase(uc.id)"
          >
            <span class="usecase-label">{{ uc.label }}</span>
            <span v-if="uc.sizeLimitMb" class="chip usecase-chip">≤{{ uc.sizeLimitMb }}MB</span>
            <span v-else-if="uc.presetId === 'remux-copy'" class="chip usecase-chip">秒转</span>
            <span v-if="options.useCaseId === uc.id" class="preset-check" aria-hidden="true">
              <svg viewBox="0 0 14 14" width="11" height="11">
                <path
                  d="M2.5 7.5 5.5 10.5 11.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </button>
        </div>

        <p v-if="activeUseCase" class="usecase-desc">{{ activeUseCase.description }}</p>

        <!-- 参数与用途推荐值不一致时，明确说出来并给恢复入口 -->
        <div v-if="deviations.length > 0" class="alert alert-warning deviation-note">
          <span>✎</span>
          <div class="deviation-body">
            <strong>你手动改过这些设置，已不同于「{{ activeUseCase?.label }}」的推荐值</strong>
            <ul class="deviation-list">
              <li v-for="d in deviations" :key="d.label">
                {{ d.label }}：<span class="mono">{{ d.current }}</span>
                <span class="muted">（推荐 {{ d.expected }}）</span>
              </li>
            </ul>
          </div>
          <button class="btn btn-sm" @click="restoreUseCase">恢复推荐值</button>
        </div>

        <div v-if="activeUseCase?.tip" class="alert alert-info preset-tip">
          <span>💡</span><span>{{ activeUseCase.tip }}</span>
        </div>

        <!-- 兼容性预检：把"转完才发现用不了"的坑提前拦住 -->
        <div v-if="compatibilityIssues.length > 0" class="compat-list">
          <div
            v-for="(issue, i) in compatibilityIssues"
            :key="i"
            class="alert compat-item"
            :class="{
              'alert-danger': issue.level === 'block',
              'alert-warning': issue.level === 'warn',
              'alert-info': issue.level === 'info',
            }"
          >
            <span>{{ issue.level === 'block' ? '⛔' : issue.level === 'warn' ? '⚠️' : 'ℹ️' }}</span>
            <div class="compat-body">
              <strong>{{ issue.message }}</strong>
              <p v-if="issue.suggestion" class="compat-suggestion">{{ issue.suggestion }}</p>
            </div>
            <button
              v-if="issue.fix"
              class="btn btn-sm compat-fix"
              @click="applyCompatibilityFix(issue.fix)"
            >
              一键修复
            </button>
          </div>
        </div>
      </section>

      <!-- ③ 播放在什么设备上 + 体积上限 -->
      <section class="block">
        <header class="block-head">
          <h4>在哪播 / 多大体积</h4>
        </header>

        <div class="field-grid">
          <label class="field">
            <span class="field-label">播放设备</span>
            <select
              class="select"
              :value="options.deviceId ?? 'any'"
              @change="setGlobal({ deviceId: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="d in DEVICES" :key="d.id" :value="d.id">{{ d.label }}</option>
            </select>
            <span class="field-hint">
              {{ activeDevice?.note ?? '用于提前检查转出来的文件能不能播' }}
            </span>
          </label>

          <label class="field">
            <span class="field-label">目标体积上限</span>
            <div class="size-limit">
              <input
                class="input mono"
                type="number"
                min="0"
                step="10"
                placeholder="不限"
                :value="options.sizeLimitMb ?? ''"
                @input="setSizeLimit(($event.target as HTMLInputElement).value)"
              />
              <span class="muted">MB</span>
              <button
                v-if="options.sizeLimitMb"
                class="btn btn-sm btn-ghost"
                title="取消体积上限，回到按质量档转换"
                @click="setGlobal({ sizeLimitMb: null })"
              >
                不限
              </button>
            </div>
            <span class="field-hint">
              {{
                options.sizeLimitMb
                  ? '用两遍编码精确命中，耗时约为普通转换的两倍'
                  : '填一个数字即可按目标体积压缩（例如微信常用 100MB）'
              }}
            </span>
          </label>
        </div>
      </section>

      <!-- ④ 质量与尺寸（推荐模式只留这两项；帧率属于专业参数，放自定义模式） -->
      <section class="block">
        <header class="block-head">
          <h4>质量与尺寸</h4>
          <span v-if="estimatedText" class="chip chip-accent" :title="estimatedText.note ?? ''">
            预计产物 {{ estimatedText.size }}
            <template v-if="estimatedText.ratio"> · 原片 {{ estimatedText.ratio }}</template>
          </span>
        </header>

        <div v-if="options.sizeLimitMb" class="alert alert-info size-limit-note">
          <span>ℹ️</span>
          <span>已按目标体积反推码率，<strong>质量档位不再参与决定</strong>（体积优先时码率是算出来的，不是猜出来的）</span>
        </div>

        <div class="field-grid">
          <label class="field">
            <span class="field-label">质量</span>
            <select
              class="select"
              :value="eff.qualityId"
              :disabled="isRemux || Boolean(options.sizeLimitMb)"
              @change="setGlobal({ qualityId: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="q in QUALITY_PRESETS" :key="q.id" :value="q.id">
                {{ q.label }} — {{ q.description }}
              </option>
            </select>
            <span v-if="isRemux" class="field-hint">直通模式不重新编码，质量档位无效</span>
            <span v-else-if="options.sizeLimitMb" class="field-hint">
              已设体积上限，码率由目标体积反推
            </span>
          </label>

          <label v-if="!isAudioOnly" class="field">
            <span class="field-label">分辨率</span>
            <select
              class="select"
              :value="eff.resolutionId"
              :disabled="isRemux"
              @change="setGlobal({ resolutionId: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="r in RESOLUTION_PRESETS" :key="r.id" :value="r.id">
                {{ r.label }}<template v-if="r.id !== 'source'"> — {{ r.description }}</template>
              </option>
            </select>
          </label>

          <!-- 帧率只对专业用户有意义，放进自定义模式 -->
          <label v-if="!isAudioOnly && appMode === 'custom'" class="field">
            <span class="field-label">帧率</span>
            <select
              class="select"
              :value="eff.fpsId"
              :disabled="isRemux"
              @change="setGlobal({ fpsId: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="f in FPS_PRESETS" :key="f.id" :value="f.id">{{ f.label }}</option>
            </select>
          </label>
        </div>
      </section>
    </div>

    <footer v-if="probe" class="details-foot">
      <div class="foot-estimate">
        <template v-if="estimatedText">
          <span class="muted">预计</span>
          <strong>{{ estimatedText.size }}</strong>
          <span v-if="quality" class="muted">· {{ quality.label }}</span>
        </template>
      </div>
      <!-- 让"这个文件参数为什么和别的文件不一样"这件事有处可查、可一键还原 -->
      <button
        v-if="hasOverride"
        class="btn btn-sm btn-ghost override-badge"
        title="本文件有单独设置（质量 / 分辨率 / 帧率 / 编码器等），点击恢复为全局设置"
        @click="resetToGlobal"
      >
        <span class="override-dot" />本文件已单独设置 · 恢复
      </button>
      <button class="btn btn-primary" @click="convertThis">
        <svg viewBox="0 0 16 16" width="13" height="13">
          <path d="M5 3.5 12 8l-7 4.5v-9Z" fill="currentColor" />
        </svg>
        转换这个文件
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.details {
  width: 400px;
  flex: none;
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.details-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 14px 14px;
}

.block {
  padding: 14px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.block:last-child {
  border-bottom: none;
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.block-head h4 {
  font-size: 13px;
  color: var(--text-primary);
}

/* 信息表 */
.info-grid {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/* ---------- 视频信息：收起态摘要 ---------- */

.info-block .block-head {
  margin-bottom: 8px;
}

.info-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0;
  color: var(--text-primary);
  font-weight: 600;
}
.info-toggle:hover {
  color: var(--accent);
}
.info-toggle svg {
  transition: transform 0.15s;
  color: var(--text-muted);
}
.info-toggle h4 {
  font-size: 13px;
}

.info-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
}
.info-summary .sep {
  color: var(--text-muted);
}
.info-row {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
  line-height: 1.7;
}
.info-row .k {
  width: 68px;
  flex: none;
  color: var(--text-muted);
}
.info-row .v {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

/* 预设卡片 */
.preset-group {
  margin-bottom: 12px;
}
.group-title {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.group-title .muted {
  font-weight: 400;
  font-size: 11px;
}

.preset-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
}

.preset-card {
  text-align: left;
  padding: 9px 11px;
  border-radius: var(--radius);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  transition: border-color 0.12s, background 0.12s, transform 0.06s;
  cursor: pointer;
  /* 左侧留一条透明竖线，选中时点亮 —— 比只靠边框颜色更容易一眼扫到 */
  border-left-width: 3px;
  border-left-color: transparent;
}
.preset-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.preset-card:active {
  transform: translateY(1px);
}
.preset-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.preset-card.active {
  border-color: var(--accent);
  border-left-color: var(--accent);
  background: var(--accent-dim);
}
.preset-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.preset-label {
  font-weight: 600;
  font-size: 12.5px;
}
/* 容器标签推到右边，选中标记再跟在它后面 */
.preset-card .chip-container {
  margin-left: auto;
  cursor: help;
}
.preset-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
  color: #1a1206;
}
.preset-desc {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.preset-tip {
  margin-top: 4px;
}

/* ---------- 用途卡片（主入口） ---------- */

.usecase-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.usecase-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border-subtle);
  border-left-width: 3px;
  border-left-color: transparent;
  background: var(--bg-elevated);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s, background 0.12s, transform 0.06s;
}
.usecase-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.usecase-card:active {
  transform: translateY(1px);
}
.usecase-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.usecase-card.active {
  border-color: var(--accent);
  border-left-color: var(--accent);
  background: var(--accent-dim);
}

.usecase-label {
  font-weight: 600;
  font-size: 12.5px;
  flex: 1;
  min-width: 0;
}

.usecase-chip {
  flex: none;
  font-size: 10.5px;
  height: 18px;
}

.usecase-desc {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.55;
}

/* ---------- 兼容性提示 ---------- */

.compat-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}

.compat-item {
  align-items: flex-start;
  gap: 8px;
}

.compat-body {
  flex: 1;
  min-width: 0;
}
.compat-body strong {
  font-size: 12.5px;
  display: block;
}
.compat-suggestion {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.55;
}

.compat-fix {
  flex: none;
  align-self: flex-start;
}

/* ---------- 体积上限 ---------- */

.size-limit {
  display: flex;
  align-items: center;
  gap: 6px;
}
.size-limit .input {
  width: 88px;
  flex: none;
  text-align: right;
}

.size-limit-note {
  margin-bottom: 10px;
  align-items: flex-start;
}

/* ---------- 参数偏离用途推荐值时的提示 ---------- */

.deviation-note {
  margin-top: 8px;
  align-items: flex-start;
}

.deviation-body {
  flex: 1;
  min-width: 0;
}
.deviation-body strong {
  font-size: 12.5px;
  display: block;
}

.deviation-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.template-input {
  margin-top: 6px;
  font-family: var(--font-mono);
}

/* 表单 */
.field-grid {
  display: grid;
  /*
   * minmax(0, 1fr) 而不是 1fr —— 这是修一个真实布局 bug 的关键。
   *
   * `1fr` 的最小值是 auto，网格列会被**内容**撑宽：专业参数里的 <select>
   * 因为 <option> 文本很长（"AAC — MP4 标准音频，兼容性最好"）而把列撑到 516px，
   * 而面板只有 400px，于是整个区域横向溢出、文字被截断（用户反馈"很奇怪"）。
   * minmax(0, 1fr) 把最小宽度设为 0，列不再被内容撑开。
   */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}
.field-grid .field:only-child {
  grid-column: 1 / -1;
}

/* 网格/弹性子项默认 min-width:auto 也会被内容撑开，统一压回 0 */
.field-grid > *,
.advanced-body > *,
.field {
  min-width: 0;
}

/* 下拉框内容过长时省略，而不是把布局撑破 */
.select {
  max-width: 100%;
  text-overflow: ellipsis;
}

.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.advanced-toggle:hover {
  color: var(--text-primary);
}
.advanced-toggle svg {
  transition: transform 0.15s;
}
.advanced-toggle .muted {
  font-weight: 400;
  font-size: 11px;
  margin-left: auto;
}

.advanced-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--radius);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
}

/* ---------- 模式切换（推荐 / 自定义） ---------- */

.mode-switch {
  display: flex;
  gap: 6px;
  padding: 12px 0 4px;
}

.mode-btn {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 8px 11px;
  border-radius: var(--radius);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  cursor: pointer;
  text-align: left;
  font-weight: 600;
  font-size: 12.5px;
  transition: border-color 0.12s, background 0.12s;
}
.mode-btn:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.mode-btn.active {
  border-color: var(--accent);
  background: var(--accent-dim);
  color: var(--accent);
}
.mode-btn small {
  font-weight: 400;
  font-size: 11px;
  color: var(--text-muted);
}
.mode-btn.active small {
  color: var(--accent);
  opacity: 0.85;
}

/* 当前方案摘要 */
.plan-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 2px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  font-size: 11.5px;
}
.plan-usecase {
  font-weight: 600;
  color: var(--accent);
  flex: none;
}
.plan-detail {
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}

.check-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.check-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  cursor: pointer;
  padding: 3px 0;
}
.check-item input[type='checkbox'] {
  margin-top: 2px;
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  flex: none;
}
.check-item.disabled {
  opacity: 0.5;
}
.check-label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.check-label small {
  font-size: 11px;
}

.inline-switch {
  margin-left: 8px;
  vertical-align: middle;
}

.trim-row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.trim-field {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
}
.trim-field .input {
  width: 84px;
  height: 28px;
}

code {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-active);
  color: var(--accent);
}

.details-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-base);
}
.foot-estimate {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 12px;
}
.foot-estimate strong {
  color: var(--accent);
}

.override-badge {
  margin-left: auto;
  margin-right: 8px;
  gap: 5px;
  color: var(--accent);
}
.override-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}
</style>
