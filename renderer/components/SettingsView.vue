<script setup lang="ts">
/**
 * 设置页。
 *
 * 这里承担两个职责：
 *  1. 常规偏好（并发数、主题、通知、默认输出目录）
 *  2. 「诊断」—— 显示 ffmpeg 实际路径与编码器可用性，
 *     让用户（和评审）能自己确认环境是否正常，而不是只看到一个「转换失败」。
 */
import { computed, onMounted, ref } from 'vue';
import { applyTheme, capabilities, settings, showToast, updateSettings } from '@/composables/useStore';
import type { FfmpegDetectResult } from '@shared/types';

const detecting = ref(false);
const detectResult = ref<FfmpegDetectResult | null>(null);

const s = computed(() => settings.value);

async function patch(p: Parameters<typeof updateSettings>[0]): Promise<void> {
  await updateSettings(p);
}

async function pickBinary(which: 'ffmpegPath' | 'ffprobePath'): Promise<void> {
  const picked = await window.converter.pickExecutable();
  if (!picked) return;
  await patch({ [which]: picked } as Parameters<typeof patch>[0]);
  showToast(`已设置路径：${picked}`, 'success');
}

async function pickOutputDir(): Promise<void> {
  const dir = await window.converter.pickOutputDir();
  if (!dir) return;
  await patch({ defaultOutputDir: dir });
  showToast(`默认输出目录已设为：${dir}`, 'success');
}

async function redetect(): Promise<void> {
  detecting.value = true;
  try {
    const res = await window.converter.detectFfmpeg();
    detectResult.value = res.ok ? res.data : null;
    if (!res.ok) {
      showToast(`检测失败：${res.error}`, 'danger');
      return;
    }
    showToast(
      res.data.ok ? `已找到 ffmpeg ${res.data.version ?? ''}` : res.data.message,
      res.data.ok ? 'success' : 'danger',
    );
    const caps = await window.converter.getCapabilities(true);
    if (caps.ok) capabilities.value = caps.data;
  } finally {
    detecting.value = false;
  }
}

async function clearThumbs(): Promise<void> {
  const res = await window.converter.clearThumbnailCache();
  if (res.ok) {
    const mb = res.data / 1024 / 1024;
    showToast(`已清理缩略图缓存，释放 ${mb < 0.1 ? '<0.1' : mb.toFixed(1)} MB`, 'success', 3000);
  } else {
    showToast(`清理失败：${res.error}`, 'danger');
  }
}

const encoderRows = computed(() => capabilities.value?.encoders ?? []);

const groupLabels: Record<string, string> = {
  software: '软件编码（CPU）',
  nvidia: 'NVIDIA 显卡加速',
  intel: 'Intel 核显加速',
  amd: 'AMD 显卡加速',
};

const groupedEncoders = computed(() => {
  const groups = new Map<string, typeof encoderRows.value>();
  for (const e of encoderRows.value) {
    const list = groups.get(e.kind) ?? [];
    list.push(e);
    groups.set(e.kind, list);
  }
  return [...groups.entries()];
});

async function openFfmpegFolder(): Promise<void> {
  const p = capabilities.value?.ffmpegPath;
  if (p) await window.converter.revealInFolder(p);
}

const themeOptions: { value: 'system' | 'light' | 'dark'; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
];

const resetting = ref(false);

/** 恢复默认设置：清掉自定义 ffmpeg 路径、输出目录、主题等全部偏好 */
async function resetAll(): Promise<void> {
  resetting.value = true;
  try {
    const res = await window.converter.resetSettings();
    if (!res.ok) {
      showToast(`恢复默认失败：${res.error}`, 'danger');
      return;
    }
    settings.value = res.data;
    applyTheme(res.data.theme);
    showToast('已恢复默认设置', 'success');
  } finally {
    resetting.value = false;
  }
}

/* ---------------- Shell 集成（发送到 / 右键菜单） ---------------- */

const shellInfo = ref<{ sendTo: boolean; contextMenu: boolean; exePath: string; supported: boolean } | null>(
  null,
);
const shellBusy = ref(false);
/** 两条都开了才算"已开启"（只开一条也算半成品，界面如实显示） */
const shellOn = computed(() => Boolean(shellInfo.value?.sendTo && shellInfo.value?.contextMenu));

async function refreshShell(): Promise<void> {
  const res = await window.converter.getShellIntegration();
  if (res.ok) shellInfo.value = res.data;
}

async function toggleShell(enable: boolean): Promise<void> {
  shellBusy.value = true;
  try {
    const res = await window.converter.setShellIntegration(enable);
    if (!res.ok) {
      showToast(`操作失败：${res.error}`, 'danger');
      return;
    }
    showToast(res.data.message, res.data.ok ? 'success' : 'danger', 5000);
    await refreshShell();
  } finally {
    shellBusy.value = false;
  }
}

onMounted(() => {
  void refreshShell();
});
</script>

<template>
  <section class="settings">
    <header class="settings-head">
      <h2>设置</h2>
      <span class="muted">这些偏好会保存在本地，下次启动自动生效</span>
    </header>

    <div v-if="s" class="settings-body">
      <!-- 运行环境 -->
      <section class="card">
        <header class="card-head">
          <h3>运行环境</h3>
          <button class="btn btn-sm" :disabled="detecting" @click="redetect">
            {{ detecting ? '检测中…' : '重新检测' }}
          </button>
        </header>

        <div class="kv">
          <div class="kv-row">
            <span class="k">ffmpeg 路径</span>
            <span class="v mono selectable">{{ capabilities?.ffmpegPath ?? '未找到' }}</span>
          </div>
          <div class="kv-row">
            <span class="k">ffprobe 路径</span>
            <span class="v mono selectable">{{ capabilities?.ffprobePath ?? '未找到' }}</span>
          </div>
          <div class="kv-row">
            <span class="k">ffmpeg 版本</span>
            <span class="v">{{ capabilities?.ffmpegVersion ?? '未知' }}</span>
          </div>
        </div>

        <div v-if="capabilities?.ffmpegPath" class="row-actions">
          <button class="btn btn-sm btn-ghost" @click="openFfmpegFolder">在文件夹中显示 ffmpeg</button>
        </div>

        <div v-if="!capabilities?.ready" class="alert alert-warning" style="margin-top: 10px">
          <span>⚠</span>
          <div>
            <strong>没有找到可用的 ffmpeg。</strong>
            <p style="margin: 4px 0 0">
              本应用本应自带 ffmpeg 二进制。如果你是通过 git clone 获取的源码，请先执行
              <code>npm run setup</code> 完整安装依赖；也可以在下方手动指定已有的 ffmpeg 可执行文件。
            </p>
          </div>
        </div>

        <div class="field-grid" style="margin-top: 10px">
          <label class="field">
            <span class="field-label">自定义 ffmpeg 路径（留空使用内置版本）</span>
            <div class="input-with-btn">
              <input
                class="input mono"
                :value="s.ffmpegPath ?? ''"
                placeholder="C:\ffmpeg\bin\ffmpeg.exe"
                @change="patch({ ffmpegPath: ($event.target as HTMLInputElement).value || null })"
              />
              <button class="btn btn-sm" @click="pickBinary('ffmpegPath')">浏览</button>
            </div>
          </label>
          <label class="field">
            <span class="field-label">自定义 ffprobe 路径</span>
            <div class="input-with-btn">
              <input
                class="input mono"
                :value="s.ffprobePath ?? ''"
                placeholder="C:\ffmpeg\bin\ffprobe.exe"
                @change="patch({ ffprobePath: ($event.target as HTMLInputElement).value || null })"
              />
              <button class="btn btn-sm" @click="pickBinary('ffprobePath')">浏览</button>
            </div>
          </label>
        </div>
        <span class="field-hint">
          留空即使用随应用分发的 ffmpeg。也可以从资源管理器地址栏复制路径后直接粘贴。
        </span>
      </section>

      <!-- 编码器能力 -->
      <section class="card">
        <header class="card-head">
          <h3>可用编码器</h3>
          <span class="muted">硬件编码器已通过真实试跑验证</span>
        </header>

        <div v-for="[kind, list] in groupedEncoders" :key="kind" class="encoder-group">
          <div class="group-name">{{ groupLabels[kind] ?? kind }}</div>
          <div class="encoder-list">
            <div
              v-for="e in list"
              :key="e.id"
              class="encoder-item"
              :class="{ off: !e.available }"
              :title="e.reason ?? ''"
            >
              <span class="encoder-dot" :class="{ on: e.available }" />
              <span class="encoder-label">{{ e.label }}</span>
              <span v-if="!e.available" class="muted encoder-reason">{{ e.reason }}</span>
            </div>
          </div>
        </div>
        <p v-if="encoderRows.length === 0" class="muted">尚未完成探测</p>
      </section>

      <!-- 转换偏好 -->
      <section class="card">
        <header class="card-head"><h3>转换偏好</h3></header>

        <div class="pref-row">
          <div class="pref-text">
            <strong>同时转换的任务数</strong>
            <span class="muted">视频编码会吃满 CPU，建议保持 1-2；显卡加速时可以提高</span>
          </div>
          <select
            class="select"
            :value="String(s.concurrency)"
            @change="patch({ concurrency: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option value="1">1 个（最稳）</option>
            <option value="2">2 个（推荐）</option>
            <option value="3">3 个</option>
            <option value="4">4 个（高性能机器）</option>
          </select>
        </div>

        <div class="pref-row">
          <div class="pref-text">
            <strong>默认输出目录</strong>
            <span class="muted mono">{{ s.defaultOutputDir ?? '与源文件相同目录' }}</span>
          </div>
          <div class="pref-actions">
            <button class="btn btn-sm" @click="pickOutputDir">选择目录</button>
            <button
              v-if="s.defaultOutputDir"
              class="btn btn-sm btn-ghost"
              @click="patch({ defaultOutputDir: null })"
            >
              恢复默认
            </button>
          </div>
        </div>

        <label class="check-item">
          <input
            type="checkbox"
            :checked="s.notifyOnFinish"
            @change="patch({ notifyOnFinish: ($event.target as HTMLInputElement).checked })"
          />
          <span class="check-label">转换完成后发送系统通知</span>
        </label>

        <label class="check-item">
          <input
            type="checkbox"
            :checked="s.openFolderOnFinish"
            @change="patch({ openFolderOnFinish: ($event.target as HTMLInputElement).checked })"
          />
          <span class="check-label">转换完成后自动打开输出目录</span>
        </label>
      </section>

      <!-- 外观 -->
      <section class="card">
        <header class="card-head"><h3>外观</h3></header>
        <div class="pref-row">
          <div class="pref-text">
            <strong>主题</strong>
            <span class="muted">深色适合长时间使用，浅色适合明亮环境</span>
          </div>
          <div class="segmented">
            <button
              v-for="t in themeOptions"
              :key="t.value"
              class="seg"
              :class="{ active: s.theme === t.value }"
              @click="patch({ theme: t.value })"
            >
              {{ t.label }}
            </button>
          </div>
        </div>
      </section>

      <!--
        Shell 集成（2026-09 新增，见 D-024）。
        两条都只写 HKCU、可一键撤销；**不动文件关联**（不抢用户原有的默认播放器）。
      -->
      <section class="card">
        <header class="card-head">
          <h3>系统集成</h3>
          <span class="muted">让它更像一个桌面工具，而不是"必须先打开再拖文件"</span>
        </header>

        <div class="pref-row">
          <div class="pref-text">
            <strong>「发送到」菜单 + 资源管理器右键菜单</strong>
            <span class="muted">
              开启后：右键任意视频 →「用 Lumen-conv 转换」；或右键 →「发送到」→ Lumen-conv。
              两条都只写当前用户（HKCU），随时可以在这里关掉。
              不会改动视频文件的默认打开方式。
            </span>
            <span v-if="shellInfo && !shellInfo.supported" class="muted">
              当前形态不支持（开发态不写注册表：这时 exe 是 electron.exe，注册了也启动不了；
              请用便携版开启）
            </span>
            <span v-else-if="shellInfo" class="mono muted">exe：{{ shellInfo.exePath }}</span>
          </div>
          <div class="shell-actions">
            <span v-if="shellOn" class="chip chip-success">已开启</span>
            <button
              class="btn btn-sm"
              :disabled="shellBusy || !shellInfo?.supported"
              @click="toggleShell(!shellOn)"
            >
              {{ shellBusy ? '处理中…' : shellOn ? '移除' : '一键开启' }}
            </button>
          </div>
        </div>
      </section>

      <!-- 缓存 -->
      <section class="card">
        <header class="card-head"><h3>缓存</h3></header>
        <div class="pref-row">
          <div class="pref-text">
            <strong>缩略图缓存</strong>
            <span class="muted">缩略图缓存在本地，删除后下次会重新生成（不影响转换结果）</span>
          </div>
          <button class="btn btn-sm" @click="clearThumbs">清理缓存</button>
        </div>
      </section>

      <section class="about">
        <div>
          <strong>Lumen-conv</strong> v1.0.0 · 基于 Electron + Vue 3 + ffmpeg 命令行
        </div>
        <div class="muted">视频格式转换器 · MIT License</div>
        <button class="btn btn-sm" style="margin-left: auto" :disabled="resetting" @click="resetAll">
          {{ resetting ? '恢复中…' : '恢复默认设置' }}
        </button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.settings {
  flex: 1;
  overflow-y: auto;
  min-width: 0;
  background: var(--bg-base);
}

.settings-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-subtle);
}
.settings-head h2 {
  font-size: 15px;
}

.settings-body {
  padding: 16px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 860px;
}

.card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.card-head h3 {
  font-size: 13px;
}

.kv {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kv-row {
  display: flex;
  gap: 10px;
  font-size: 12px;
  align-items: baseline;
}
.kv-row .k {
  width: 92px;
  flex: none;
  color: var(--text-muted);
}
.kv-row .v {
  flex: 1;
  word-break: break-all;
  color: var(--text-secondary);
}

.row-actions {
  display: flex;
  gap: 8px;
}

.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.input-with-btn {
  display: flex;
  gap: 6px;
}
.input-with-btn .input {
  flex: 1;
  min-width: 0;
}

.pref-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.encoder-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.group-name {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.encoder-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 16px;
}
.encoder-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  padding: 2px 0;
}
.encoder-item.off {
  opacity: 0.55;
}
.encoder-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex: none;
}
.encoder-dot.on {
  background: var(--success);
  box-shadow: 0 0 0 3px rgba(62, 207, 142, 0.15);
}
.encoder-reason {
  font-size: 11px;
  margin-left: auto;
  text-align: right;
}

.pref-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.pref-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
}
.pref-text .muted {
  font-size: 11.5px;
}

.segmented {
  display: flex;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex: none;
}
.seg {
  padding: 0 12px;
  height: 30px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border-right: 1px solid var(--border-strong);
}
.seg:last-child {
  border-right: none;
}
.seg:hover {
  background: var(--bg-hover);
}
.seg.active {
  background: var(--accent-dim);
  color: var(--accent);
  font-weight: 600;
}

.check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.check-item input[type='checkbox'] {
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
}

.shell-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.about {
  font-size: 11.5px;
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding-top: 4px;
}

code {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-active);
  color: var(--accent);
}
</style>
