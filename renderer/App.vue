<script setup lang="ts">
/**
 * 应用根组件：三栏骨架 + 全局快捷键 + 全局提示。
 *
 * 布局：标题栏 / 侧边导航 / （转换页：文件列表 + 详情面板 | 队列页 | 设置页）
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import TitleBar from '@/components/TitleBar.vue';
import Sidebar from '@/components/Sidebar.vue';
import FileList from '@/components/FileList.vue';
import PreviewPane from '@/components/PreviewPane.vue';
import DetailsPanel from '@/components/DetailsPanel.vue';
import JobQueue from '@/components/JobQueue.vue';
import SettingsView from '@/components/SettingsView.vue';
import {
  activeView,
  addFiles,
  capabilities,
  initStore,
  runningJobs,
  showToast,
  toast,
} from '@/composables/useStore';

const maximized = ref(false);
const booted = ref(false);

function minimize(): void {
  window.converter.windowMinimize();
}

async function toggleMaximize(): Promise<void> {
  maximized.value = await window.converter.windowMaximize();
}

function closeWindow(): void {
  window.converter.windowClose();
}

async function pickFiles(): Promise<void> {
  const paths = await window.converter.pickVideoFiles();
  if (paths.length > 0) await addFiles(paths);
}

function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === 'o' || e.key === 'O') {
    e.preventDefault();
    void pickFiles();
  } else if (e.key === '1') {
    activeView.value = 'convert';
  } else if (e.key === '2') {
    activeView.value = 'queue';
  } else if (e.key === '3') {
    activeView.value = 'settings';
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);

  // 便于排查"An object could not be cloned."这类只在特定路径出现的 IPC 克隆错误：
  // 默认情况下 Electron 只在控制台打一行没有堆栈的错误，几乎无法定位。
  // 注意必须显式 String() 化：直接 console.error(errorEvent) 打不出内容。
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[renderer] 未处理的 Promise 拒绝：' + String(e.reason) + ' | stack=' + (e.reason?.stack ?? '无'));
  });
  window.addEventListener('error', (e) => {
    console.error('[renderer] 全局错误：' + String(e.message) + ' @ ' + (e.filename ?? '') + ':' + e.lineno);
  });

  await initStore();
  booted.value = true;

  /*
   * Shell 集成：接手"启动时通过命令行传进来的文件"（2026-09 新增，见 D-024）。
   *
   * 覆盖三种入口：把文件拖到 exe 图标上、「发送到 → Lumen-conv 转换」、
   * 资源管理器右键「用 Lumen-conv 转换」。第二条路径（应用已经开着时又右键一次）
   * 由主进程的 second-instance 通过事件推过来。
   *
   * 走的是与拖拽/选择文件**完全相同**的 addFiles，所以探测、缩略图、失败标红
   * 这些行为都一致，不是另开一条捷径。
   */
  const pending = await window.converter.takePendingFiles();
  if (pending.ok && pending.data.length > 0) await addFiles(pending.data);
  window.converter.onOpenExternalFiles((paths: string[]) => {
    void addFiles(paths);
  });

  // 给自动化界面自检（npm run smoke:ui）用的就绪标志：
  // 仅凭 DOM 是否存在无法判断 store 是否已加载完数据 —— 设置页会因为
  // settings 仍为 null 而整块不渲染，早期版本因此截到一张空白设置页。
  document.documentElement.setAttribute('data-store-ready', '1');

  // 界面自检用的加载入口：走与拖拽/选择文件完全相同的 addFiles 路径，
  // 这样截出来的图就是真实交互的结果，而不是另写一套假数据。
  //
  // 注意：必须返回 undefined。executeJavaScript 会用结构化克隆把返回值传回主进程，
  // 而 Vue 的响应式对象 / Promise 都不可克隆，返回它们会让渲染进程直接崩溃
  // （实测报错："An object could not be cloned."）。
  (window as unknown as { __lumenAddFiles?: (paths: string[]) => void }).__lumenAddFiles = (
    paths: string[],
  ): void => {
    void addFiles(paths);
  };
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});

// ffmpeg 缺失时给一条明确的引导，而不是让用户点半天没反应
const ffmpegMissing = () => booted.value && capabilities.value !== null && !capabilities.value.ready;
void runningJobs;
void showToast;
</script>

<template>
  <div class="app">
    <TitleBar
      :maximized="maximized"
      @minimize="minimize"
      @maximize="toggleMaximize"
      @close="closeWindow"
    />

    <div class="body">
      <Sidebar />

      <main class="main">
        <div v-if="ffmpegMissing()" class="banner alert alert-warning">
          <span>⚠</span>
          <div>
            <strong>未检测到 ffmpeg，转换功能不可用。</strong>
            <p>
              请到「设置 → 运行环境」手动指定 ffmpeg 路径；如果你是源码运行，请先执行
              <code>npm run setup</code>。
            </p>
          </div>
          <button class="btn btn-sm" @click="activeView = 'settings'">去设置</button>
        </div>

        <div class="content">
          <template v-if="activeView === 'convert'">
            <!--
              中间栏拆成上下两块：上面是文件列表，下面是画面效果预览。
              预览放这里而不是塞在右侧 400px 面板里 —— 用户反馈"太小了看不清"，
              而中间栏在只加载一两个文件时本来就是一大片空白（见 D-025 的补充说明）。
            -->
            <div class="center-col">
              <FileList @pick="pickFiles" />
              <PreviewPane />
            </div>
            <DetailsPanel />
          </template>
          <JobQueue v-else-if="activeView === 'queue'" />
          <SettingsView v-else />
        </div>
      </main>
    </div>

    <Transition name="fade">
      <div v-if="toast" class="toast" :class="`toast-${toast.kind}`">
        {{ toast.text }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.banner {
  margin: 10px 12px 0;
  align-items: center;
  gap: 12px;
  flex: none;
}
.banner strong {
  font-size: 12.5px;
}
.banner p {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.banner button {
  margin-left: auto;
  flex: none;
}

.content {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}

.content > :first-child {
  flex: 1;
  min-width: 0;
}

/*
 * 中间栏：文件列表在上、画面预览在下。
 *
 * 文件列表**不参与拉伸**（flex: 0 0 auto）并限制在 46% 高度内：
 * 只加载一个文件时它只需要一百多像素，剩下的空间全部让给预览 ——
 * 这正是"预览太小看不清"的解法。
 */
.center-col {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.center-col :deep(.file-pane) {
  flex: 0 0 auto;
  max-height: 46%;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  max-width: 640px;
  padding: 10px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
  font-size: 12.5px;
  z-index: 200;
  line-height: 1.6;
}
.toast-success {
  border-color: rgba(62, 207, 142, 0.5);
}
.toast-danger {
  border-color: rgba(242, 86, 77, 0.55);
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
