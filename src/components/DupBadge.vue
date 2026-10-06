<script setup lang="ts">
import { ref } from "vue";

// 重复角标：右上角两个半透明重叠胶片 20×20，粉描边 1.5px（技术方案 §7.4 / 组件规范表）。
// 文案严格为「该文件共有 N 处副本」；纯视觉标记，不做删除/移动。
const props = defineProps<{ count: number }>();
const show = ref(false);
</script>

<template>
  <span
    class="relative inline-flex h-5 w-5 items-center justify-center"
    @mouseenter="show = true"
    @mouseleave="show = false"
    @touchstart.passive="show = true"
    @touchend.passive="show = false"
  >
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-label="重复文件"
      role="img"
    >
      <rect
        x="2"
        y="4"
        width="12"
        height="12"
        rx="2"
        fill="rgba(255,255,255,0.6)"
        stroke="#FB7299"
        stroke-width="1.5"
      />
      <rect
        x="6"
        y="4"
        width="12"
        height="12"
        rx="2"
        fill="rgba(255,255,255,0.4)"
        stroke="#FB7299"
        stroke-width="1.5"
      />
    </svg>

    <span
      class="pointer-events-none absolute bottom-full right-0 z-10 mb-1 whitespace-nowrap rounded-pop bg-bg-elev px-2 py-1 text-xs font-medium text-ink-1 shadow-sm transition-opacity"
      style="border: 1px solid var(--line); transition-duration: 160ms"
      :style="{ opacity: show ? 1 : 0 }"
      role="tooltip"
    >
      该文件共有 {{ props.count }} 处副本
    </span>
  </span>
</template>
