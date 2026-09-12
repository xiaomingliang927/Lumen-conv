<script setup lang="ts">
/**
 * 任务队列视图。
 *
 * 「给人用」的重点：
 * - 每个任务都能看到「当前速度 + 剩余时间 + 已用时」，而不是只有一个百分比
 * - 失败任务直接给出原因 + 建议，并把 ffmpeg 原始日志折叠在下面（可复制）
 * - 命令原文可展开 —— 这是本项目"确实在用 ffmpeg 命令行"的最直观证据，
 *   同时也方便用户/评审自查参数是否正确
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import {
  cancelJob,
  clearFinished,
  files,
  finishedJobs,
  jobLogs,
  jobs,
  moveJob,
  openJobOutput,
  pauseQueue,
  queueEtaSec,
  queuePaused,
  queuedJobs,
  removeJob,
  resumeQueue,
  retryJob,
  runningJobs,
  settings,
  showToast,
  updateSettings,
} from '@/composables/useStore';
import { formatBytes, formatDuration, formatEta, formatRatio, formatSpeed, stateLabel } from '@/utils/format';
import type { MediaJob } from '@shared/types';

const openLog = reactive<Record<string, boolean>>({});
const openCommand = reactive<Record<string, boolean>>({});

/** 排队中任务的位置（用于判断"置顶/上移"能不能点） */
const queuedIndex = (id: string): number => queuedJobs.value.findIndex((j) => j.id === id);

/** 并发数：直接读设置，改了立刻生效（引擎的 setConcurrency 会重新调度） */
const concurrency = computed(() => settings.value?.concurrency ?? 2);
async function changeConcurrency(e: Event): Promise<void> {
  const n = Number((e.target as HTMLSelectElement).value);
  await updateSettings({ concurrency: n });
  showToast(`并发已设为 ${n}`, 'info', 1800);
}

/** 本地 1 秒心跳：让「已用时 / 剩余时间」持续走动，而不必等 ffmpeg 上报 */
const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    tick.value++;
  }, 1000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const thumbOf = (path: string): string | null =>
  files.value.find((f) => f.path === path)?.thumbnail ?? null;

const elapsed = (job: MediaJob): number => {
  void tick.value;
  if (!job.startedAt) return 0;
  const end = job.finishedAt ?? Date.now();
  return (end - job.startedAt) / 1000;
};

const remaining = (job: MediaJob): number | null => {
  void tick.value;
  if (job.state !== 'running' || !job.progress) return null;
  // 有 ffmpeg 上报的 eta 就用它，否则按已处理时长与已用时反推
  if (job.progress.etaSec !== null && job.progress.etaSec !== undefined) return job.progress.etaSec;
  if (job.progress.processedSec > 0) {
    const elapsedSec = elapsed(job);
    const speed = job.progress.processedSec / Math.max(elapsedSec, 0.5);
    const total = job.progress.percent ? (job.progress.processedSec / job.progress.percent) * 100 : 0;
    if (total > 0) return (total - job.progress.processedSec) / Math.max(speed, 0.01);
  }
  return null;
};

const stateClass = (state: string): string => {
  if (state === 'done') return 'chip-success';
  if (state === 'failed') return 'chip-danger';
  if (state === 'running') return 'chip-accent';
  if (state === 'canceled') return 'chip';
  return 'chip-info';
};

const sortedJobs = computed(() =>
  [...jobs.value].sort((a, b) => {
    const rank = (s: string) => (s === 'running' ? 0 : s === 'queued' ? 1 : 2);
    const r = rank(a.state) - rank(b.state);
    if (r !== 0) return r;
    return b.createdAt - a.createdAt;
  }),
);

function copyLog(job: MediaJob): void {
  const log = [job.command, '', ...(jobLogs[job.id] ?? []), '', job.error?.rawLog ?? ''].join('\n');
  void navigator.clipboard.writeText(log);
}

const hasAnyFinished = computed(() => finishedJobs.value.length > 0);
void formatDuration;
</script>

<template>
  <section class="queue">
    <header class="queue-head">
      <div class="head-left">
        <h2>任务队列</h2>
        <span v-if="runningJobs.length" class="chip chip-accent">{{ runningJobs.length }} 个进行中</span>
        <span v-if="finishedJobs.length" class="chip">{{ finishedJobs.length }} 个已结束</span>
        <span v-if="queuePaused" class="chip chip-warn">已暂停</span>
        <span v-if="queueEtaSec !== null" class="chip" title="按已完成任务的平均耗时 + 运行中任务的实时剩余时间估算">
          总剩余约 {{ formatEta(queueEtaSec) }}
        </span>
      </div>
      <div class="head-right">
        <!--
          队列级控制（2026-09 新增，见 DECISIONS.md D-023）。
          暂停的语义是"不再启动新任务"，正在跑的那个会跑完 —— 因为 ffmpeg 不支持断点续传，
          硬停一个跑一半的任务只能从头再来，那叫取消。
        -->
        <button
          v-if="!queuePaused"
          class="btn btn-sm btn-ghost"
          title="不再启动新任务；正在转换的那个会跑完"
          @click="pauseQueue"
        >
          暂停队列
        </button>
        <button v-else class="btn btn-sm" @click="resumeQueue">继续队列</button>

        <label class="concurrency" title="同时转换几个文件">
          <span class="muted">并发</span>
          <select class="select select-sm" :value="concurrency" @change="changeConcurrency">
            <option v-for="n in 4" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>

        <button class="btn btn-sm btn-ghost" :disabled="!hasAnyFinished" @click="clearFinished">
          清除已完成
        </button>
      </div>
    </header>

    <div v-if="jobs.length === 0" class="empty-state">
      <svg viewBox="0 0 48 48" width="48" height="48" style="color: var(--text-muted); opacity: 0.7">
        <rect x="8" y="14" width="32" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M14 22h12M14 27h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <h3>队列是空的</h3>
      <p class="muted">回到「转换」页选择文件，点击「开始转换」后任务会出现在这里</p>
    </div>

    <div v-else class="job-list">
      <article v-for="job in sortedJobs" :key="job.id" class="job-card" :class="job.state">
        <div class="job-main">
          <div class="job-thumb">
            <img v-if="thumbOf(job.sourcePath)" :src="thumbOf(job.sourcePath)!" alt="" />
            <div v-else class="thumb-fallback mono">{{ stateLabel(job.state).slice(0, 2) }}</div>
          </div>

          <div class="job-body">
            <div class="job-title-row">
              <span class="job-name" :title="job.sourcePath">{{ job.sourceName }}</span>
              <span class="chip" :class="stateClass(job.state)">
                <span v-if="job.state === 'running'" class="spinner" />
                {{ stateLabel(job.state) }}
              </span>
              <span class="chip">{{ job.presetLabel }}</span>
            </div>

            <div class="job-sub">
              <span class="mono">{{ formatDuration(job.sourceDurationSec) }}</span>
              <span class="sep">·</span>
              <span>{{ formatBytes(job.sourceSizeBytes) }}</span>
              <template v-if="job.state === 'done' && job.outputSizeBytes">
                <span class="sep">→</span>
                <strong class="out-size" :data-bytes="job.outputSizeBytes">{{ formatBytes(job.outputSizeBytes) }}</strong>
                <span class="chip chip-success">原片 {{ formatRatio(job.outputSizeBytes, job.sourceSizeBytes) }}</span>
              </template>
              <template v-if="job.state === 'running'">
                <span class="sep">·</span>
                <span>{{ formatSpeed(job.progress?.speed) }}</span>
                <span class="sep">·</span>
                <span>{{ formatEta(remaining(job)) }}</span>
                <span class="sep">·</span>
                <span class="muted">已用时 {{ formatDuration(elapsed(job)) }}</span>
              </template>
            </div>

            <!-- 进度条 -->
            <div
              v-if="job.state === 'running'"
              class="progress"
              :class="{ 'progress-indeterminate': job.progress?.percent === null || job.progress?.percent === undefined }"
            >
              <div
                class="progress-fill"
                :style="{ width: `${job.progress?.percent ?? 0}%` }"
              />
            </div>

            <!-- 失败原因 -->
            <div v-if="job.state === 'failed' && job.error" class="job-error alert alert-danger">
              <div class="err-body">
                <strong>{{ job.error.message }}</strong>
                <p v-if="job.error.hint" class="err-hint">{{ job.error.hint }}</p>
              </div>
            </div>

            <!-- 完成信息 -->
            <div v-if="job.state === 'done'" class="job-path mono selectable" :title="job.outputPath">
              {{ job.outputPath }}
            </div>
          </div>

          <div class="job-actions">
            <button
              v-if="job.state === 'running' || job.state === 'queued'"
              class="btn btn-sm"
              @click="cancelJob(job.id)"
            >
              取消
            </button>
            <button
              v-if="job.state === 'failed' || job.state === 'canceled'"
              class="btn btn-sm"
              @click="retryJob(job.id)"
            >
              重试
            </button>
            <button
              v-if="job.state === 'done'"
              class="btn btn-sm btn-primary"
              @click="openJobOutput(job.id)"
            >
              打开位置
            </button>

            <!--
              重排只对**排队中**的任务开放。
              正在跑的改顺序没有意义；已结束的更没有 —— 与其给出点了没反应的按钮，
              不如不显示（这是本项目一贯的取舍：按钮必须真的有用）。
            -->
            <template v-if="job.state === 'queued'">
              <button
                class="btn btn-sm btn-ghost move-btn"
                title="提到最前（下一个就转它）"
                :disabled="queuedIndex(job.id) === 0"
                @click="moveJob(job.id, 'top')"
              >
                ⇤ 置顶
              </button>
              <button
                class="btn btn-sm btn-ghost move-btn"
                title="上移一位"
                :disabled="queuedIndex(job.id) === 0"
                @click="moveJob(job.id, 'up')"
              >
                ↑
              </button>
              <button
                class="btn btn-sm btn-ghost move-btn"
                title="下移一位"
                :disabled="queuedIndex(job.id) === queuedJobs.length - 1"
                @click="moveJob(job.id, 'down')"
              >
                ↓
              </button>
            </template>

            <button
              v-if="job.state !== 'running'"
              class="btn btn-sm btn-ghost"
              title="从列表移除"
              @click="removeJob(job.id)"
            >
              ✕
            </button>
          </div>
        </div>

        <!-- 折叠信息：命令 + 日志 -->
        <div class="job-details">
          <button class="link-btn" @click="openCommand[job.id] = !openCommand[job.id]">
            {{ openCommand[job.id] ? '▾' : '▸' }} 查看 ffmpeg 命令
          </button>
          <button
            v-if="job.state === 'failed' || (jobLogs[job.id]?.length ?? 0) > 0"
            class="link-btn"
            @click="openLog[job.id] = !openLog[job.id]"
          >
            {{ openLog[job.id] ? '▾' : '▸' }} 运行日志（{{ jobLogs[job.id]?.length ?? 0 }} 行）
          </button>
          <button class="link-btn" @click="copyLog(job)">复制诊断信息</button>
        </div>

        <pre v-if="openCommand[job.id]" class="code-block selectable">{{ job.command }}</pre>
        <pre v-if="openLog[job.id]" class="code-block log selectable">{{
          (jobLogs[job.id] ?? []).slice(-60).join('\n') || '（暂无日志）'
        }}</pre>
      </article>
    </div>
  </section>
</template>

<style scoped>
.queue {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-base);
}

.queue-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-subtle);
}
.head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.concurrency {
  display: flex;
  align-items: center;
  gap: 5px;
}
.select-sm {
  width: auto;
  min-width: 54px;
  padding: 3px 6px;
  font-size: 12px;
}
.move-btn {
  padding: 2px 7px;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.head-left h2 {
  font-size: 15px;
}

.job-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.job-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 11px 12px;
  transition: border-color 0.15s;
}
.job-card.running {
  border-color: var(--accent-border);
}
.job-card.failed {
  border-color: rgba(242, 86, 77, 0.35);
}

.job-main {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.job-thumb {
  width: 82px;
  height: 46px;
  flex: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-elevated);
  display: grid;
  place-items: center;
}
.job-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-fallback {
  color: var(--text-muted);
  font-size: 12px;
}

.job-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.job-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.job-name {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 380px;
}

.job-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}
.job-sub .sep {
  color: var(--text-muted);
}
.out-size {
  color: var(--success);
}

.job-error {
  margin-top: 2px;
}
.err-body strong {
  font-size: 12.5px;
}
.err-hint {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.job-path {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.job-actions {
  flex: none;
  display: flex;
  gap: 6px;
  align-items: center;
}

.job-details {
  display: flex;
  gap: 14px;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-subtle);
}

.link-btn {
  font-size: 11.5px;
  color: var(--text-muted);
  transition: color 0.12s;
}
.link-btn:hover {
  color: var(--accent);
}

.code-block {
  margin: 8px 0 0;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  background: #0a0c10;
  border: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: #b8c4d4;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow-y: auto;
}
:root[data-theme='light'] .code-block {
  background: #f7f8fa;
  color: #33404f;
}
.code-block.log {
  color: #93a1b3;
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
</style>
