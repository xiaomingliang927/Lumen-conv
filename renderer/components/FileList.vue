<script setup lang="ts">
/**
 * 文件列表（工作区左侧）。
 * 「给人用」的细节：
 * - 拖拽整块区域都能加文件，不用精准拖到某条虚线框上
 * - 分析中显示骨架屏，分析失败显示原因并允许移除
 * - 缩略图加载失败有占位图，而不是破图图标
 */
import { computed, ref } from 'vue';
import { activePath, addFiles, clearFiles, files, removeFile, startConversion } from '@/composables/useStore';
import { formatBytes, formatDuration, stateLabel } from '@/utils/format';
import type { LoadedFile } from '@/composables/useStore';

const emit = defineEmits<{ (e: 'pick'): void }>();

const dragActive = ref(false);
let dragDepth = 0;

function onDragEnter(e: DragEvent): void {
  e.preventDefault();
  dragDepth++;
  if (e.dataTransfer?.types.includes('Files')) dragActive.value = true;
}

function onDragLeave(e: DragEvent): void {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragActive.value = false;
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  dragDepth = 0;
  dragActive.value = false;
  // 必须在 drop 事件同步阶段取路径：DataTransfer 之后会被回收
  const dropped = Array.from(e.dataTransfer?.files ?? []);
  const paths = window.converter.pathsForFiles(dropped);
  if (paths.length > 0) await addFiles(paths);
  else emit('pick');
}

const totalSize = computed(() => files.value.reduce((sum, f) => sum + (f.probe?.sizeBytes ?? 0), 0));
const readyCount = computed(() => files.value.filter((f) => f.status === 'ready').length);

function statusChip(file: LoadedFile): { text: string; cls: string } | null {
  if (file.status === 'analyzing') return { text: '分析中', cls: 'chip-info' };
  if (file.status === 'error') return { text: '无法读取', cls: 'chip-danger' };
  return null;
}

const busy = ref(false);
async function convertAll(): Promise<void> {
  busy.value = true;
  try {
    await startConversion();
  } finally {
    busy.value = false;
  }
}
void stateLabel;
</script>

<template>
  <section
    class="file-pane"
    :class="{ 'drag-active': dragActive }"
    @dragenter="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <header class="pane-header">
      <div class="pane-title">
        <h3>待转换文件</h3>
        <span v-if="files.length" class="chip">
          {{ files.length }} 个 · {{ formatBytes(totalSize) }}
        </span>
      </div>
      <div class="pane-actions">
        <button class="btn btn-sm btn-ghost" :disabled="files.length === 0" @click="clearFiles">清空</button>
        <button class="btn btn-sm" @click="emit('pick')">添加文件</button>
      </div>
    </header>

    <div v-if="files.length === 0" class="empty-state">
      <svg viewBox="0 0 48 48" width="52" height="52" class="empty-icon">
        <rect x="8" y="12" width="32" height="24" rx="3" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M20 20.5 29 24l-9 3.5v-7Z" fill="currentColor" opacity="0.55" />
        <path d="M24 6v5M24 37v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <h3>把视频拖到这里</h3>
      <p class="muted">支持 MP4 / MKV / MOV / AVI / WebM / FLV 等常见格式，也可以直接拖入整个文件夹里的多个文件</p>
      <button class="btn btn-primary" @click="emit('pick')">选择视频文件</button>
    </div>

    <div v-else class="file-list">
      <article
        v-for="file in files"
        :key="file.path"
        class="file-card"
        :class="{ active: file.path === activePath, error: file.status === 'error' }"
        @click="activePath = file.path"
      >
        <div class="thumb">
          <img v-if="file.thumbnail" :src="file.thumbnail" :alt="file.probe?.fileName ?? ''" />
          <div v-else-if="file.status === 'analyzing'" class="thumb-skeleton" />
          <div v-else class="thumb-fallback">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path
                d="M4 6h16v12H4z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <path d="M4 16l4.5-4.5 3.5 3.5L15 12l5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </div>
          <span v-if="file.probe && file.probe.durationSec > 0" class="thumb-duration">
            {{ formatDuration(file.probe.durationSec) }}
          </span>
        </div>

        <div class="file-meta">
          <div class="file-name" :title="file.path">{{ file.probe?.fileName ?? file.path }}</div>
          <div class="file-sub">
            <template v-if="file.status === 'ready' && file.probe">
              <span>{{ file.probe.formatLongName }}</span>
              <span class="sep">·</span>
              <span v-if="file.probe.hasVideo && file.probe.video[0]">
                {{ file.probe.video[0].displayWidth }}×{{ file.probe.video[0].displayHeight }}
              </span>
              <span v-if="file.probe.hasVideo" class="sep">·</span>
              <span>{{ formatBytes(file.probe.sizeBytes) }}</span>
            </template>
            <template v-else-if="file.status === 'error'">
              <span class="err">{{ file.error }}</span>
            </template>
            <template v-else>
              <span class="muted">正在读取视频信息…</span>
            </template>
          </div>
          <div v-if="statusChip(file)" class="file-chips">
            <span class="chip" :class="statusChip(file)!.cls">{{ statusChip(file)!.text }}</span>
          </div>
        </div>

        <button class="file-remove" title="从列表移除" @click.stop="removeFile(file.path)">
          <svg viewBox="0 0 14 14" width="12" height="12">
            <path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </article>
    </div>

    <footer v-if="files.length > 0" class="pane-footer">
      <span class="muted">{{ readyCount }} 个可转换</span>
      <button class="btn btn-primary" :disabled="readyCount === 0 || busy" @click="convertAll">
        <svg viewBox="0 0 16 16" width="13" height="13">
          <path d="M5 3.5 12 8l-7 4.5v-9Z" fill="currentColor" />
        </svg>
        开始转换{{ readyCount > 1 ? `（${readyCount} 个）` : '' }}
      </button>
    </footer>

    <div v-if="dragActive" class="drop-overlay">
      <div class="drop-card">
        <strong>松开即可添加</strong>
        <span class="muted">视频与音频文件都可以</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.file-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  min-width: 0;
  border-right: 1px solid var(--border-subtle);
}

.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  flex: none;
}

.pane-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.pane-title h3 {
  font-size: 14px;
}

.pane-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.empty-state {
  flex: 1;
}
.empty-icon {
  color: var(--text-muted);
  opacity: 0.7;
}
.empty-state p {
  max-width: 380px;
  font-size: 12.5px;
  margin: 0;
}

.file-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.file-card {
  display: flex;
  gap: 11px;
  align-items: center;
  padding: 8px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  position: relative;
}
.file-card:hover {
  background: var(--bg-panel);
}
.file-card.active {
  background: var(--bg-panel);
  border-color: var(--accent-border);
}
.file-card.error {
  border-color: rgba(242, 86, 77, 0.3);
}

.thumb {
  width: 96px;
  height: 54px;
  flex: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-elevated);
  position: relative;
  display: grid;
  place-items: center;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-fallback {
  color: var(--text-muted);
}
.thumb-skeleton {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-hover) 50%, var(--bg-elevated) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.3s infinite;
}
@keyframes shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
.thumb-duration {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 10.5px;
  font-family: var(--font-mono);
  line-height: 15px;
}

.file-meta {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.file-name {
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}
.file-sub {
  font-size: 11.5px;
  color: var(--text-secondary);
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.file-sub .sep {
  color: var(--text-muted);
}
.file-sub .err {
  color: var(--danger);
}
.file-chips {
  display: flex;
  gap: 5px;
  margin-top: 2px;
}

.file-remove {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  display: grid;
  place-items: center;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
.file-card:hover .file-remove {
  opacity: 1;
}
.file-remove:hover {
  background: var(--danger-dim);
  color: var(--danger);
}

.pane-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-panel);
}

.drop-overlay {
  position: absolute;
  inset: 0;
  background: rgba(14, 16, 20, 0.82);
  display: grid;
  place-items: center;
  z-index: 20;
  pointer-events: none;
}
.drop-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 28px 44px;
  border-radius: var(--radius-lg);
  border: 2px dashed var(--accent);
  background: var(--accent-dim);
}
</style>
