<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useUiStore } from "@/stores/ui";

// 全局 Toast 容器（技术方案 §7.5 / §8.4）：底部居中，200ms ease-out 淡入淡出。
const ui = useUiStore();
const { toasts } = storeToRefs(ui);
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
  >
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="rounded-btn px-4 py-2 text-sm font-medium"
        :class="t.kind === 'error' ? 'text-pink' : 'text-ink-inv-1'"
        style="background: rgba(0, 0, 0, 0.82)"
      >
        {{ t.text }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-control) var(--ease-out),
    transform var(--dur-control) var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
