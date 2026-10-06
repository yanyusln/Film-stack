<script setup lang="ts">
import { computed } from "vue";
import {
  formatTime,
  type LoopMode,
  type PlaybackRate,
} from "@/composables/playbackPolicy";
import SpeedMenu from "@/components/SpeedMenu.vue";

// 控制栏（W4 / 技术方案 §8.5）：进度条（V1 无悬浮预览）、时间、倍速 6 档、PC 横向音量。
// Android 的竖向音量/亮度、手势层、锁屏层属于下一批（W4-b）。
const props = defineProps<{
  playing: boolean;
  currentTime: number;
  duration: number;
  rate: PlaybackRate;
  volume: number;
  muted: boolean;
  loopMode: LoopMode;
  hasPrev: boolean;
  hasNext: boolean;
  visible: boolean;
  locked: boolean;
  /** Android 才显示画中画按钮（PC V1 不做，技术方案 §8.5）。 */
  pipVisible: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  seek: [delta: number];
  seekTo: [sec: number];
  setRate: [rate: PlaybackRate];
  setVolume: [v: number];
  toggleMute: [];
  prev: [];
  next: [];
  setLoop: [mode: LoopMode];
  fullscreen: [];
  toggleLock: [];
  pip: [];
}>();

const timeText = computed(
  () => `${formatTime(props.currentTime)} / ${formatTime(props.duration)}`,
);

const LOOP_LABEL: Record<LoopMode, string> = {
  off: "不循环",
  single: "单曲循环",
  list: "列表循环",
};

function cycleLoop() {
  const order: LoopMode[] = ["off", "single", "list"];
  const next = order[(order.indexOf(props.loopMode) + 1) % order.length];
  emit("setLoop", next);
}
</script>

<template>
  <div
    class="absolute inset-x-0 bottom-0 space-y-2 bg-gradient-to-t from-black/70 to-transparent px-4 pb-4 pt-8 text-white transition-opacity duration-200 ease-out"
    :class="visible ? 'opacity-100' : 'pointer-events-none opacity-0'"
  >
    <div class="flex items-center gap-3">
      <input
        type="range"
        min="0"
        :max="duration || 0"
        step="0.1"
        :value="currentTime"
        class="h-1 flex-1 cursor-pointer"
        style="accent-color: var(--pink)"
        aria-label="播放进度"
        @input="
          emit('seekTo', Number(($event.target as HTMLInputElement).value))
        "
      />
      <span class="w-24 shrink-0 text-right text-xs tabular-nums">
        {{ timeText }}
      </span>
    </div>

    <div class="flex items-center gap-2">
      <button
        class="rounded-btn px-2 py-1 text-sm disabled:opacity-40"
        :disabled="!hasPrev"
        @click="emit('prev')"
      >
        上一个
      </button>
      <button class="rounded-btn px-3 py-1 text-sm" @click="emit('toggle')">
        {{ playing ? "暂停" : "播放" }}
      </button>
      <button
        class="rounded-btn px-2 py-1 text-sm disabled:opacity-40"
        :disabled="!hasNext"
        @click="emit('next')"
      >
        下一个
      </button>
      <button
        class="rounded-btn px-2 py-1 text-xs text-white/80"
        @click="cycleLoop"
      >
        {{ LOOP_LABEL[loopMode] }}
      </button>

      <span class="ml-auto flex items-center gap-2">
        <SpeedMenu
          :rate="rate"
          :visible="visible"
          @select="emit('setRate', $event)"
        />
        <button
          class="rounded-btn px-2 py-1 text-xs"
          @click="emit('toggleMute')"
        >
          {{ muted ? "已静音" : "静音" }}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="volume"
          class="h-1 w-24 cursor-pointer"
          style="accent-color: var(--pink)"
          aria-label="音量"
          @input="
            emit('setVolume', Number(($event.target as HTMLInputElement).value))
          "
        />
        <button
          v-if="pipVisible"
          class="rounded-btn px-2 py-1 text-xs"
          @click="emit('pip')"
        >
          画中画
        </button>
        <button
          class="rounded-btn px-2 py-1 text-xs"
          @click="emit('toggleLock')"
        >
          {{ locked ? "解锁" : "锁定" }}
        </button>
        <button
          class="rounded-btn px-2 py-1 text-xs"
          @click="emit('fullscreen')"
        >
          全屏
        </button>
      </span>
    </div>
  </div>
</template>
