<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { formatTime } from "@/composables/playbackPolicy";
import type { PlaylistItem } from "@/stores/player";

// 播放列表面板（W5 / 技术方案 §8.6、F19）：
// ① 分组序 = 内建 sort_order，② 文件夹序 = 文件属性序（文件名自然序）。
// 面板只做展示与跳转，顺序由 player store 决定，不在这里重排。
const props = defineProps<{
  items: PlaylistItem[];
  index: number;
  kind: "folder" | "group";
  label: string;
}>();
const emit = defineEmits<{ select: [index: number] }>();

const list = ref<HTMLElement | null>(null);

const kindText = computed(() =>
  props.kind === "group" ? "分组序" : "文件夹序",
);
const counter = computed(() =>
  props.index >= 0 ? `${props.index + 1} / ${props.items.length}` : "—",
);

// 自动连播跳到下一首时，把当前项滚进可视区（block:nearest 不会打断整页滚动）
watch(
  () => props.index,
  async () => {
    await nextTick();
    list.value
      ?.querySelector<HTMLElement>('[data-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  },
  { immediate: true },
);
</script>

<template>
  <div
    class="rounded-card bg-bg-elev p-3"
    style="border: 1px solid var(--line)"
  >
    <div class="mb-2 flex items-center justify-between gap-2">
      <p class="truncate text-sm font-medium text-ink-1">
        {{ kindText }}
        <span v-if="label" class="text-xs text-ink-2">· {{ label }}</span>
      </p>
      <span class="shrink-0 text-xs tabular-nums text-ink-2">
        {{ counter }}
      </span>
    </div>

    <ul ref="list" class="max-h-56 space-y-1 overflow-y-auto">
      <li v-for="(v, i) in items" :key="v.id" :data-current="i === index">
        <button
          class="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-sm"
          :class="i === index ? 'bg-bg text-pink' : 'text-ink-1 hover:bg-bg'"
          :style="
            i === index ? 'box-shadow: inset 2px 0 0 0 var(--pink)' : undefined
          "
          @click="emit('select', i)"
        >
          <span class="min-w-0 flex-1 truncate">{{ v.name }}</span>
          <span
            v-if="v.duration"
            class="shrink-0 text-xs tabular-nums text-ink-2"
          >
            {{ formatTime(v.duration) }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
