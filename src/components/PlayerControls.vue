<script setup lang="ts">
import { computed } from "vue";
import {
  formatTime,
  type LoopMode,
  type PlaybackRate,
} from "@/composables/playbackPolicy";
import SpeedMenu from "@/components/SpeedMenu.vue";
import AppIcon from "@/components/AppIcon.vue";

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

/** 循环模式 → 图标：off 用灰色 repeat，single 是 repeat-1，list 是高亮 repeat。 */
const LOOP_ICON: Record<LoopMode, string> = {
  off: "repeat",
  single: "repeat-1",
  list: "repeat",
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

    <div class="flex items-center gap-1">
      <!-- 图标按钮统一 40px 点击区（8pt 网格）：文案进 aria-label / title，
           真机小屏不再挤成两行竖排文字（v1 反馈截图实证） -->
      <button
        type="button"
        class="flex h-10 w-10 items-center justify-center rounded-btn transition-colors duration-200 ease-out hover:bg-white/10 disabled:opacity-40"
        :disabled="!hasPrev"
        aria-label="上一个"
        title="上一个"
        @click="emit('prev')"
      >
        <AppIcon name="skip-back" :size="20" />
      </button>
      <button
        type="button"
        class="flex h-10 w-10 items-center justify-center rounded-btn transition-colors duration-200 ease-out hover:bg-white/10"
        :aria-label="playing ? '暂停' : '播放'"
        :title="playing ? '暂停' : '播放'"
        @click="emit('toggle')"
      >
        <AppIcon :name="playing ? 'pause' : 'play'" :size="22" />
      </button>
      <button
        type="button"
        class="flex h-10 w-10 items-center justify-center rounded-btn transition-colors duration-200 ease-out hover:bg-white/10 disabled:opacity-40"
        :disabled="!hasNext"
        aria-label="下一个"
        title="下一个"
        @click="emit('next')"
      >
        <AppIcon name="skip-forward" :size="20" />
      </button>
      <button
        type="button"
        class="flex h-10 w-10 items-center justify-center rounded-btn transition-colors duration-200 ease-out hover:bg-white/10"
        :class="loopMode === 'off' ? 'text-white/70' : 'text-[var(--pink)]'"
        :aria-label="`循环模式：${LOOP_LABEL[loopMode]}`"
        :title="LOOP_LABEL[loopMode]"
        @click="cycleLoop"
      >
        <AppIcon :name="LOOP_ICON[loopMode]" :size="20" />
      </button>

      <span class="ml-auto flex items-center gap-1">
        <SpeedMenu
          :rate="rate"
          :visible="visible"
          @select="emit('setRate', $event)"
        />
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-btn transition-colors duration-200 ease-out hover:bg-white/10"
          :aria-label="muted ? '取消静音' : '静音'"
          :title="muted ? '取消静音' : '静音'"
          @click="emit('toggleMute')"
        >
          <AppIcon :name="muted ? 'volume-x' : 'volume-2'" :size="20" />
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
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-btn transition-colors duration-200 ease-out hover:bg-white/10"
          aria-label="画中画"
          title="画中画"
          @click="emit('pip')"
        >
          <AppIcon name="picture-in-picture-2" :size="20" />
        </button>
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-btn transition-colors duration-200 ease-out hover:bg-white/10"
          :aria-label="locked ? '解锁' : '锁定'"
          :title="locked ? '解锁' : '锁定'"
          @click="emit('toggleLock')"
        >
          <AppIcon :name="locked ? 'lock-open' : 'lock'" :size="20" />
        </button>
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-btn transition-colors duration-200 ease-out hover:bg-white/10"
          aria-label="全屏"
          title="全屏"
          @click="emit('fullscreen')"
        >
          <AppIcon name="maximize" :size="20" />
        </button>
      </span>
    </div>
  </div>
</template>
