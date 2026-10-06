<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useUiStore } from "@/stores/ui";
import type { ResumePreference } from "@/composables/playbackPolicy";

// 设置页（W4-b 起接入播放相关开关；W5 补齐结束策略开关）。
const ui = useUiStore();
const { resumePreference, gestureEnabled, autoAdvance, theme } =
  storeToRefs(ui);

const THEMES: Array<{ key: "light" | "dark"; label: string }> = [
  { key: "light", label: "亮色" },
  { key: "dark", label: "暗色" },
];

const RESUME_LABEL: Record<ResumePreference, string> = {
  ask: "每次询问",
  resume: "总是续播",
  restart: "总是从头",
};

const resumePref = computed({
  get: () => resumePreference.value,
  set: (v: ResumePreference) => ui.setResumePreference(v),
});

const gestures = computed({
  get: () => gestureEnabled.value,
  set: (v: boolean) => ui.setGestureEnabled(v),
});

const advance = computed({
  get: () => autoAdvance.value,
  set: (v: boolean) => ui.setAutoAdvance(v),
});
</script>

<template>
  <section class="space-y-4">
    <header>
      <h1 class="text-base font-semibold text-ink-1">设置</h1>
      <p class="text-sm text-ink-2">主题、续播策略与播放手势。</p>
    </header>

    <div
      class="flex items-center justify-between gap-4 rounded-card bg-bg-elev p-4"
      style="border: 1px solid var(--line)"
    >
      <div class="min-w-0">
        <p class="text-sm font-medium text-ink-1">主题</p>
        <p class="text-xs text-ink-2">
          首次进入跟随系统，手动选择后记住你的选择。
        </p>
      </div>
      <div class="flex shrink-0 gap-1">
        <button
          v-for="t in THEMES"
          :key="t.key"
          class="rounded-btn px-3 py-1 text-sm"
          :class="
            theme === t.key
              ? 'bg-pink text-white'
              : 'text-ink-2 hover:text-ink-1'
          "
          @click="ui.setTheme(t.key)"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <div
      class="space-y-3 rounded-card bg-bg-elev p-4"
      style="border: 1px solid var(--line)"
    >
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="text-sm font-medium text-ink-1">续播策略</p>
          <p class="text-xs text-ink-2">
            播放过的影片再次打开时如何处理；设置页优先，播放页的「本次不再询问」只对当前视频生效。
          </p>
        </div>
        <select
          v-model="resumePref"
          class="rounded-btn bg-bg px-3 py-1.5 text-sm text-ink-1"
          style="border: 1px solid var(--line)"
        >
          <option v-for="(label, key) in RESUME_LABEL" :key="key" :value="key">
            {{ label }}
          </option>
        </select>
      </div>

      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="text-sm font-medium text-ink-1">手势总控</p>
          <p class="text-xs text-ink-2">
            关闭后只保留点击（播放/暂停）与双击左右半屏 ±10s，长按 2x
            与左右竖滑一并停用。
          </p>
        </div>
        <label class="flex shrink-0 items-center gap-2 text-sm text-ink-1">
          <input v-model="gestures" type="checkbox" />
          {{ gestures ? "已开启" : "已关闭" }}
        </label>
      </div>

      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="text-sm font-medium text-ink-1">播完自动播下一曲</p>
          <p class="text-xs text-ink-2">
            关闭后影片播完就停在当前时间，不再进下一曲；单曲循环是显式选择，不受这个开关影响。
          </p>
        </div>
        <label class="flex shrink-0 items-center gap-2 text-sm text-ink-1">
          <input v-model="advance" type="checkbox" />
          {{ advance ? "已开启" : "播完暂停" }}
        </label>
      </div>
    </div>
  </section>
</template>
