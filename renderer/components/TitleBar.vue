<script setup lang="ts">
/**
 * 标题栏：自绘（frameless 观感）+ 窗口按钮。
 * 用系统的 titleBarStyle 默认即可，这里只做「应用身份 + 全局状态 + 窗口控制」。
 */
import { computed } from 'vue';
import { capabilities, runningJobs } from '@/composables/useStore';

const props = defineProps<{
  maximized: boolean;
}>();

const emit = defineEmits<{
  (e: 'minimize'): void;
  (e: 'maximize'): void;
  (e: 'close'): void;
}>();

const ffmpegLabel = computed(() => {
  const c = capabilities.value;
  if (!c) return { text: '检测中…', kind: 'muted' as const };
  if (!c.ready) return { text: 'ffmpeg 未就绪', kind: 'danger' as const };
  return { text: `ffmpeg ${c.ffmpegVersion ?? '已就绪'}`, kind: 'ok' as const };
});

const activeCount = computed(() => runningJobs.value.length);
</script>

<template>
  <header class="titlebar">
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="15" height="15">
          <path
            d="M12 2.5 4 7v10l8 4.5 8-4.5V7l-8-4.5Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
          <path d="M10 9.2 15.5 12 10 14.8V9.2Z" fill="currentColor" />
        </svg>
      </div>
      <span class="brand-name">Lumen-conv</span>
      <span class="brand-sub">视频格式转换器</span>
    </div>

    <div class="spacer" />

    <div class="status-group">
      <span
        class="chip"
        :class="{
          'chip-success': ffmpegLabel.kind === 'ok',
          'chip-danger': ffmpegLabel.kind === 'danger',
        }"
        :title="capabilities?.ffmpegPath ?? ''"
      >
        <span class="dot" :class="{ live: ffmpegLabel.kind === 'ok' }" />
        {{ ffmpegLabel.text }}
      </span>
      <span v-if="activeCount > 0" class="chip chip-accent">
        <span class="spinner" />{{ activeCount }} 个任务进行中
      </span>
    </div>

    <div class="window-controls">
      <button class="wc" title="最小化" @click="emit('minimize')">
        <svg viewBox="0 0 12 12" width="11" height="11"><path d="M2 6h8" stroke="currentColor" stroke-width="1.3" /></svg>
      </button>
      <button class="wc" :title="props.maximized ? '还原' : '最大化'" @click="emit('maximize')">
        <svg v-if="!props.maximized" viewBox="0 0 12 12" width="11" height="11">
          <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.3" />
        </svg>
        <svg v-else viewBox="0 0 12 12" width="11" height="11">
          <rect x="2" y="3.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M4 3.5V2h6v6H8.5" fill="none" stroke="currentColor" stroke-width="1.3" />
        </svg>
      </button>
      <button class="wc wc-close" title="关闭" @click="emit('close')">
        <svg viewBox="0 0 12 12" width="11" height="11">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  gap: 12px;
  padding-left: 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-subtle);
  -webkit-app-region: drag;
  flex: none;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-border);
  color: var(--accent);
  display: grid;
  place-items: center;
}

.brand-name {
  font-weight: 650;
  letter-spacing: -0.01em;
}

.brand-sub {
  color: var(--text-muted);
  font-size: 12px;
  padding-left: 8px;
  border-left: 1px solid var(--border-subtle);
}

.spacer {
  flex: 1;
}

.status-group {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}
.dot.live {
  background: var(--success);
  box-shadow: 0 0 0 3px rgba(62, 207, 142, 0.18);
}

.spinner {
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--accent-border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.window-controls {
  display: flex;
  -webkit-app-region: no-drag;
  margin-left: 4px;
}

.wc {
  width: 44px;
  height: var(--titlebar-h);
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  transition: background 0.12s, color 0.12s;
}
.wc:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.wc-close:hover {
  background: #e03131;
  color: #fff;
}
</style>
