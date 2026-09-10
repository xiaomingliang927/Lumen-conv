<script setup lang="ts">
/**
 * 左侧导航栏：应用主功能入口 + 队列状态徽标。
 * 刻意做得很窄 —— 转换类工具的核心工作区是文件列表，导航不该抢视觉重心。
 */
import { computed } from 'vue';
import { activeView, files, finishedJobs, runningJobs } from '@/composables/useStore';

interface NavItem {
  id: 'convert' | 'queue' | 'settings';
  label: string;
  hint: string;
  badge?: number;
  icon: string;
}

const nav = computed<NavItem[]>(() => [
  {
    id: 'convert',
    label: '转换',
    hint: '选择文件与输出格式',
    badge: files.value.length || undefined,
    icon: 'M4 5.5h9M4 9h9M4 12.5h5',
  },
  {
    id: 'queue',
    label: '任务队列',
    hint: '查看进度与结果',
    badge: runningJobs.value.length || undefined,
    icon: 'M4 6h8M4 10h8M4 14h5',
  },
  {
    id: 'settings',
    label: '设置',
    hint: 'ffmpeg 路径与偏好',
    icon: 'M8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z M8 2.5v1.2M8 12.3v1.2M2.5 8h1.2M12.3 8h1.2',
  },
]);

const doneCount = computed(() => finishedJobs.value.filter((j) => j.state === 'done').length);
</script>

<template>
  <nav class="sidebar">
    <div class="nav-list">
      <button
        v-for="item in nav"
        :key="item.id"
        class="nav-item"
        :class="{ active: activeView === item.id }"
        :title="item.hint"
        @click="activeView = item.id"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" class="nav-icon">
          <path :d="item.icon" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <span class="nav-label">{{ item.label }}</span>
        <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
      </button>
    </div>

    <div class="sidebar-foot">
      <div v-if="doneCount > 0" class="foot-stat">
        <span class="muted">本次已完成</span>
        <strong>{{ doneCount }}</strong>
      </div>
      <div class="foot-tip">
        <kbd>Ctrl</kbd><kbd>O</kbd><span class="muted">打开文件</span>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  flex: none;
  background: var(--bg-panel);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 10px 8px;
}

.nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-weight: 500;
  transition: background 0.12s, color 0.12s;
  position: relative;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--accent-dim);
  color: var(--accent);
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.nav-icon {
  flex: none;
}

.nav-label {
  flex: 1;
  text-align: left;
}

.nav-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--bg-active);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  display: grid;
  place-items: center;
}

.nav-item.active .nav-badge {
  background: var(--accent);
  color: #1a1206;
}

.sidebar-foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 2px;
  border-top: 1px solid var(--border-subtle);
}

.foot-stat {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
}

.foot-tip {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-secondary);
}
</style>
