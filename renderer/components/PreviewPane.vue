<script setup lang="ts">
/**
 * 画面效果预览（放在中间栏下方的大块空白区）。
 *
 * ------------------------------------------------------------------ *
 * 为什么从右侧详情面板搬到这里
 *
 * 第一版把「原图 / 效果」两张图塞在右侧面板里（面板宽 400px，两张图各约 190px），
 * 用户反馈很直接：**"这个太小了看不清能不能在中间找个大点的位置显示"**。
 * 中间栏在只加载一两个文件时是一大片空白，把预览放这里既解决了看清的问题，
 * 又用上了原本浪费的空间 —— 而且"改完长什么样"本来就该是转换页的主角之一。
 *
 * ------------------------------------------------------------------ *
 * 它能告诉你什么、不能告诉你什么（这条界限也写在界面上）
 *
 * 能：尺寸、画面比例、补边/裁剪、字幕烧录位置 —— 几何类效果。
 * 不能：**编码质量**。预览帧是无损 PNG，答不了"压到 2 Mbps 会不会糊"，
 *       那要看底部的「预计体积」。
 * 所以叫「画面**效果**预览」，不叫「输出效果预览」。
 * ------------------------------------------------------------------ */

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { activeFile, effectiveOptions } from '@/composables/useStore';
import type { ConversionOptions } from '@shared/types';

const probe = computed(() => activeFile.value?.probe ?? null);
const thumbUrl = computed(() => activeFile.value?.thumbnail ?? null);
const hasVideo = computed(() => Boolean(probe.value?.hasVideo));

const previewUrl = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const effects = ref<string[]>([]);

/** 放大查看：点任意一张图进入，Esc 或点遮罩退出 */
const zoom = ref<'original' | 'effect' | null>(null);
const zoomSrc = computed(() => (zoom.value === 'original' ? thumbUrl.value : previewUrl.value));

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && zoom.value) zoom.value = null;
}
watch(zoom, (v) => {
  if (v) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

/**
 * 只依赖**会影响构图**的参数：分辨率、画面比例、字幕烧录、裁剪起点。
 * 调音量、换编码器不该重渲染 —— 它们不改变画面。
 */
const previewKey = computed(() => {
  const p = probe.value;
  if (!p) return '';
  const eff = activeFile.value ? effectiveOptions(activeFile.value) : null;
  if (!eff) return '';
  return [
    p.path,
    eff.resolutionId,
    eff.fitMode ?? 'off',
    String(eff.burnSubtitleIndex ?? ''),
    String(eff.trimStartSec ?? ''),
  ].join('|');
});

let timer: ReturnType<typeof setTimeout> | null = null;
let token = 0;

watch(
  previewKey,
  () => {
    if (timer) clearTimeout(timer);
    // 防抖：拖分辨率下拉、连点画面比例时不该每一下都起一个 ffmpeg
    timer = setTimeout(() => void render(), 400);
  },
  { immediate: true },
);

async function render(): Promise<void> {
  const p = probe.value;
  const file = activeFile.value;
  if (!p || !file || !p.hasVideo) return;
  const mine = ++token;
  busy.value = true;
  error.value = null;
  try {
    const res = await window.converter.previewFrame(
      p.path,
      // 必须去掉响应式代理：IPC 结构化克隆不接受 Proxy（D-016 踩过）
      JSON.parse(JSON.stringify(effectiveOptions(file))) as ConversionOptions,
      p.thumbnailAtSec ?? 0,
    );
    if (mine !== token) return; // 已有更新的一次请求，丢弃这次结果
    if (!res.ok) {
      previewUrl.value = null;
      error.value = res.error;
      return;
    }
    previewUrl.value = res.data.filePath;
    effects.value = res.data.effects;
    if (res.data.error) error.value = res.data.error;
  } catch (err) {
    if (mine === token) {
      previewUrl.value = null;
      error.value = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (mine === token) busy.value = false;
  }
}
</script>

<template>
  <section v-if="hasVideo" class="preview-pane">
    <header class="preview-head">
      <h3>画面效果预览</h3>
      <span v-if="busy" class="chip">渲染中…</span>
      <span v-else-if="error" class="chip chip-warn" :title="error">{{ error }}</span>
      <span v-else-if="effects.length" class="muted effects">{{ effects.join(' · ') }}</span>
      <span class="muted tip">点图片可放大（Esc 关闭）· 只反映画面，不反映编码质量</span>
    </header>

    <div class="preview-grid">
      <figure class="shot" @click="thumbUrl && (zoom = 'original')">
        <img v-if="thumbUrl" :src="thumbUrl" alt="原图" />
        <div v-else class="shot-empty">原图加载中…</div>
        <figcaption>原图</figcaption>
      </figure>

      <figure class="shot" :class="{ clickable: Boolean(previewUrl) }" @click="previewUrl && (zoom = 'effect')">
        <img v-if="previewUrl" :src="previewUrl" alt="效果" />
        <div v-else class="shot-empty">{{ busy ? '正在按当前参数渲染…' : '—' }}</div>
        <figcaption>效果（当前参数）</figcaption>
      </figure>
    </div>

    <!-- 放大查看：占满窗口，Esc 或点空白处关闭 -->
    <Teleport to="body">
      <div v-if="zoom && zoomSrc" class="lightbox" @click.self="zoom = null">
        <img :src="zoomSrc" :alt="zoom === 'original' ? '原图' : '效果'" />
        <div class="lightbox-bar">
          <button
            class="btn btn-sm"
            :class="{ 'btn-primary': zoom === 'original' }"
            @click="zoom = 'original'"
          >
            原图
          </button>
          <button
            class="btn btn-sm"
            :class="{ 'btn-primary': zoom === 'effect' }"
            :disabled="!previewUrl"
            @click="zoom = 'effect'"
          >
            效果
          </button>
          <button class="btn btn-sm btn-ghost" @click="zoom = null">关闭 (Esc)</button>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.preview-pane {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-subtle);
  padding: 10px 16px 12px;
}

.preview-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.preview-head h3 {
  font-size: 13px;
  color: var(--text-primary);
}
.effects {
  font-size: 11.5px;
}
.tip {
  margin-left: auto;
  font-size: 11px;
}

.preview-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  /* minmax(0,1fr) 而不是 1fr：网格子项默认 min-width:auto 会被图片撑破 */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.shot {
  margin: 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  cursor: default;
}
.shot.clickable,
.shot:hover {
  cursor: zoom-in;
}

.shot img,
.shot-empty {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
}
.shot-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
}

.shot figcaption {
  flex: none;
  margin-top: 5px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
}

/* ---------- 放大查看 ---------- */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.82);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
}
.lightbox img {
  max-width: 94vw;
  max-height: 82vh;
  object-fit: contain;
  border-radius: var(--radius);
}
.lightbox-bar {
  display: flex;
  gap: 8px;
}
</style>
