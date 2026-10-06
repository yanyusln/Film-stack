<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import {
  PLAYBACK_RATES,
  type PlaybackRate,
} from "@/composables/playbackPolicy";

// 倍速菜单（技术方案 §8.5 / AGENTS §5）：6 档弹出式九宫格，替代原生 <select>。
// 理由：原生下拉在 Android WebView 上样式不可控、点击区偏小；粉仅标当前档位。
// 交互：点击外部 / Esc 关闭，↑↓←→ 移动、Enter 选中，跟随控制栏 200ms ease-out 淡入淡出。
const props = defineProps<{
  rate: PlaybackRate;
  /** 控制栏淡出时连带收起，避免留下悬空的浮层。 */
  visible?: boolean;
}>();
const emit = defineEmits<{ select: [rate: PlaybackRate] }>();

const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const active = ref(0);

const rateLabel = computed(() => `${props.rate}x`);

function items() {
  return root.value?.querySelectorAll<HTMLElement>("[role=menuitemradio]");
}

async function focusActive() {
  await nextTick();
  items()?.[active.value]?.focus();
}

function step(dir: 1 | -1) {
  const n = PLAYBACK_RATES.length;
  active.value = (((active.value + dir) % n) + n) % n;
  void focusActive();
}

function toggle() {
  open.value = !open.value;
}

function close(returnFocus = false) {
  open.value = false;
  if (returnFocus) trigger.value?.focus();
}

function pick(r: PlaybackRate) {
  emit("select", r);
  close(true);
}

function onOutside(ev: PointerEvent) {
  if (!root.value?.contains(ev.target as Node)) close();
}

function onKeyDown(ev: KeyboardEvent) {
  if (!open.value) {
    // 收起态只接管方向键/Enter 展开；空格留给按钮原生 click
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown" || ev.key === "Enter") {
      ev.preventDefault();
      open.value = true;
    }
    return;
  }
  if (ev.key === "Escape") close(true);
  else if (ev.key === "ArrowDown" || ev.key === "ArrowRight") step(1);
  else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") step(-1);
  else if (ev.key === "Enter") pick(PLAYBACK_RATES[active.value]);
  else return;
  ev.preventDefault();
}

watch(open, (v) => {
  if (v) {
    active.value = Math.max(
      0,
      PLAYBACK_RATES.findIndex((r) => r === props.rate),
    );
    void focusActive();
    window.addEventListener("pointerdown", onOutside, true);
  } else {
    window.removeEventListener("pointerdown", onOutside, true);
  }
});

watch(
  () => props.visible,
  (v) => {
    if (v === false) close();
  },
);

onUnmounted(() => {
  window.removeEventListener("pointerdown", onOutside, true);
});
</script>

<template>
  <div ref="root" class="relative" @keydown="onKeyDown">
    <button
      ref="trigger"
      type="button"
      class="flex items-center gap-1 rounded-btn px-2 py-1 text-xs"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="`倍速 ${rateLabel}`"
      @click="toggle"
    >
      <span class="tabular-nums">{{ rateLabel }}</span>
      <svg
        viewBox="0 0 12 12"
        class="h-3 w-3 transition-transform duration-200 ease-out"
        :class="open ? 'rotate-180' : ''"
        aria-hidden="true"
      >
        <path
          d="M2 4.5 6 8.5 10 4.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-1 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-200 ease-out"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="open"
        role="menu"
        aria-label="倍速"
        class="absolute bottom-full right-0 mb-2 grid w-36 grid-cols-3 gap-1 rounded-pop bg-black/80 p-1 shadow-[0_12px_32px_rgba(0,0,0,.35)]"
        style="border: 1px solid rgba(255, 255, 255, 0.12)"
      >
        <button
          v-for="(r, i) in PLAYBACK_RATES"
          :key="r"
          type="button"
          role="menuitemradio"
          :aria-checked="r === rate"
          class="rounded-btn px-2 py-1.5 text-xs tabular-nums transition-colors duration-200 ease-out"
          :class="
            r === rate
              ? 'bg-pink text-white'
              : i === active
                ? 'bg-white/10 text-white'
                : 'text-white/80'
          "
          @pointerenter="active = i"
          @click="pick(r)"
        >
          {{ r }}x
        </button>
      </div>
    </Transition>
  </div>
</template>
