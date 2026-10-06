<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatTime } from "@/composables/playbackPolicy";

// 续播三选一（技术方案 §8.6）：「本次不再询问」只跳过当前视频，不改全局偏好。
const props = defineProps<{
  open: boolean;
  videoId: string;
  position: number;
  duration: number;
}>();

const emit = defineEmits<{
  resume: [skipOnce: boolean];
  restart: [];
  cancel: [];
}>();

const skipOnce = ref(false);
watch(
  () => props.videoId,
  () => {
    skipOnce.value = false;
  },
);

const positionText = computed(() => formatTime(props.position));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        class="w-72 space-y-3 rounded-card bg-bg-elev p-4 text-ink-1"
        style="border: 1px solid var(--line)"
      >
        <p class="text-sm font-medium">继续上次播放？</p>
        <p class="text-xs text-ink-2">上次看到 {{ positionText }}</p>
        <label class="flex items-center gap-2 text-xs text-ink-2">
          <input v-model="skipOnce" type="checkbox" />
          本次不再询问
        </label>
        <div class="flex justify-end gap-2">
          <button
            class="rounded-btn px-3 py-1 text-xs text-ink-2 hover:text-ink-1"
            @click="emit('cancel')"
          >
            取消
          </button>
          <button
            class="rounded-btn px-3 py-1 text-xs text-ink-2 hover:text-ink-1"
            @click="emit('restart')"
          >
            从头播放
          </button>
          <button
            class="rounded-btn bg-pink px-3 py-1 text-xs font-medium text-white"
            @click="emit('resume', skipOnce)"
          >
            继续播放
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
