<script setup lang="ts">
/**
 * 右侧详情与参数面板。
 *
 * 信息架构（自上而下）：
 *   1. 视频信息卡片 —— 满足需求 1 的「加载视频信息显示」
 *   2. 输出格式预设 —— 主决策：我要转成什么
 *   3. 质量与尺寸 —— 次决策：压多小 / 多大分辨率
 *   4. 高级选项     —— 字幕、音轨、裁剪、文件名
 *
 * 「给人用」的取舍：默认只露前 3 层，高级选项折叠起来。
 * 但每调一个参数都实时给出「预计体积」，因为这是用户最关心的隐性目标。
 */
import { computed, ref } from 'vue';
import {
  CONVERSION_PRESETS,
  FPS_PRESETS,
  QUALITY_PRESETS,
  RESOLUTION_PRESETS,
  activeFile,
  activePreset,
  activeProbe,
  clearActiveOverride,
  effectiveOptions,
  encoderAvailability,
  options,
  setActiveOverride,
  showToast,
  startConversion,
  availableVideoCodecs,
  predictedOutput,
} from '@/composables/useStore';
import type { ConversionOptions } from '@shared/types';
import { CONTAINERS, VIDEO_CODECS, AUDIO_CODECS } from '@shared/presets';
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
 * 参数变更分两类处理，这个区分很重要（是一个真实 bug 的教训）：
 *
 * - **全局偏好**（质量 / 分辨率 / 帧率 / 编码器 / 音频编码 / 文件名模板）：
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
  options.value = {
    ...options.value,
    presetId: preset.id,
    videoCodecId: preset.videoCodecId ?? 'none',
    audioCodecId: preset.audioCodecId,
    qualityId: preset.qualityId,
    resolutionId: preset.resolutionId,
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
      <!-- ① 视频信息 -->
      <section class="block">
        <header class="block-head">
          <h4>视频信息</h4>
          <button class="btn btn-sm btn-ghost" @click="revealInFolder(probe.path)">
            在文件夹中显示
          </button>
        </header>

        <div class="info-grid selectable">
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
      <section class="block">
        <header class="block-head">
          <h4>输出格式</h4>
          <button v-if="hasOverride" class="btn btn-sm btn-ghost" @click="resetToGlobal">
            恢复全局设置
          </button>
        </header>

        <div v-for="group in presetGroups" :key="group.key" class="preset-group">
          <div class="group-title">
            <span>{{ group.title }}</span>
            <span class="muted">{{ group.desc }}</span>
          </div>
          <div class="preset-grid">
            <button
              v-for="preset in group.items"
              :key="preset.id"
              class="preset-card"
              :class="{ active: activePreset.id === preset.id }"
              :aria-pressed="activePreset.id === preset.id"
              :title="`选择「${preset.label}」`"
              @click="choosePreset(preset.id)"
            >
              <div class="preset-top">
                <span class="preset-label">{{ preset.label }}</span>
                <!-- 右侧是「输出容器」标签，不是按钮：整张卡片才是可点区域。
                     加 title 说明它的含义，避免被误认为是下拉入口。 -->
                <span
                  class="chip chip-container"
                  :title="`输出容器：${CONTAINERS[preset.container].label}（${CONTAINERS[preset.container].description}）`"
                >
                  {{ CONTAINERS[preset.container].label }}
                </span>
                <span v-if="activePreset.id === preset.id" class="preset-check" aria-hidden="true">
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
              </div>
              <p class="preset-desc">{{ preset.description }}</p>
            </button>
          </div>
        </div>

        <div v-if="activePreset.tip" class="alert alert-info preset-tip">
          <span>💡</span><span>{{ activePreset.tip }}</span>
        </div>
      </section>

      <!-- ③ 质量与尺寸 -->
      <section class="block">
        <header class="block-head">
          <h4>质量与尺寸</h4>
          <span v-if="estimatedText" class="chip chip-accent" :title="estimatedText.note ?? ''">
            预计产物 {{ estimatedText.size }}
            <template v-if="estimatedText.ratio"> · 原片 {{ estimatedText.ratio }}</template>
          </span>
        </header>

        <div class="field-grid">
          <label class="field">
            <span class="field-label">质量</span>
            <select
              class="select"
              :value="eff.qualityId"
              :disabled="isRemux"
              @change="setGlobal({ qualityId: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="q in QUALITY_PRESETS" :key="q.id" :value="q.id">
                {{ q.label }} — {{ q.description }}
              </option>
            </select>
            <span v-if="isRemux" class="field-hint">直通模式不重新编码，质量档位无效</span>
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

          <label v-if="!isAudioOnly" class="field">
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

      <!-- ④ 高级选项 -->
      <section class="block">
        <button class="advanced-toggle" @click="advancedOpen = !advancedOpen">
          <svg viewBox="0 0 12 12" width="10" height="10" :style="{ transform: advancedOpen ? 'rotate(90deg)' : '' }">
            <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          高级选项
          <span class="muted">编码器 / 音轨 / 字幕 / 裁剪 / 文件名</span>
        </button>

        <div v-if="advancedOpen" class="advanced-body">
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
              <span class="field-label">文件名模板</span>
              <input
                class="input"
                :value="eff.fileNameTemplate"
                placeholder="{name}"
                @input="setGlobal({ fileNameTemplate: ($event.target as HTMLInputElement).value })"
              />
              <span class="field-hint">
                可用变量：<code>{name}</code> <code>{preset}</code> <code>{date}</code>
                · 预览：<span class="mono">{{ templatePreview }}</span>
              </span>
            </label>
          </div>

          <label class="check-item">
            <input v-model="keepMetadata" type="checkbox" />
            <span class="check-label">保留元数据与章节<small class="muted">（标题、作者、章节标记）</small></span>
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

/* 表单 */
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.field-grid .field:only-child {
  grid-column: 1 / -1;
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
