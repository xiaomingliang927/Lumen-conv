<script setup lang="ts">
/**
 * 「目标体积上限」输入控件（纯展示组件：值与变更都交给父组件）。
 *
 * ------------------------------------------------------------------ *
 * 为什么把它单独抽成一个组件（真实用户反馈驱动）
 *
 * 用户反馈："你要拿去干什么 和 在哪播放/多大体积 存在耦合情况"。
 * 其中一个具体表现就是这个输入框：它**住在「在哪播 / 多大体积」区块里，
 * 值却是由「用途」决定的**（发微信 = 100MB、手机存着看 = 不限）。
 * 同一个参数两个主人 —— 用户在这个框里改数字，改的其实是用途的推荐值之一，
 * 而且切换用途会让框里的数字莫名其妙地跳变。
 *
 * 现在按"一个参数只有一个主人"重新归属（见 DECISIONS.md D-020）：
 *   · 推荐模式 → 控件跟着**用途区块**走（它就是用途的一部分：发微信就是 ≤100MB）
 *   · 自定义模式 → 控件跟着**质量与尺寸**走（此时它是"体积优先"的开关，
 *                  设了它质量档位就不再参与决定码率，两者必须放在一起看）
 * 两处渲染、一份实现，避免两边行为/文案跑偏。
 * ------------------------------------------------------------------ */

import { computed } from 'vue';

const props = defineProps<{
  /** 当前值（MB）；null = 不限制 */
  value: number | null;
  /** 提示语气：用途区强调"这是用途带来的"，质量区强调"它会盖过质量档位" */
  context: 'usecase' | 'quality';
}>();

const emit = defineEmits<{ (e: 'update', value: number | null): void }>();

/** 空字符串 / 0 / 负数都视为"不限制" */
function onInput(raw: string): void {
  const n = Number(raw);
  emit('update', raw.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n);
}

const hint = computed(() => {
  if (!props.value) {
    return props.context === 'usecase'
      ? '这套用途不限制体积；填一个数字即可改成按体积压（例如微信常用 100MB）'
      : '填一个数字即可按目标体积压缩；填了之后质量档位不再参与决定码率';
  }
  return '用两遍编码精确命中目标体积，耗时约为普通转换的两倍';
});
</script>

<template>
  <label class="field">
    <span class="field-label">目标体积上限</span>
    <div class="size-limit">
      <input
        class="input mono"
        type="number"
        min="0"
        step="10"
        placeholder="不限"
        :value="value ?? ''"
        @input="onInput(($event.target as HTMLInputElement).value)"
      />
      <span class="muted">MB</span>
      <button
        v-if="value"
        class="btn btn-sm btn-ghost"
        title="取消体积上限，回到按质量档转换"
        @click="emit('update', null)"
      >
        不限
      </button>
    </div>
    <span class="field-hint">{{ hint }}</span>
  </label>
</template>
