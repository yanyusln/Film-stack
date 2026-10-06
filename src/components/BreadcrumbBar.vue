<script setup lang="ts">
// 面包屑（设计稿：本地视频 / 电影 / 4K，末级加粗）+ 右侧操作区。
import type { Crumb } from "@/composables/useFolderTree";

withDefaults(
  defineProps<{
    /** 根目录 label；为空时只显示「本地视频」 */
    rootLabel?: string;
    /** 当前目录的层级（不含根） */
    crumbs?: Crumb[];
    /** 当前层级 key（末级加粗） */
    current?: string;
  }>(),
  { rootLabel: "", crumbs: () => [], current: "" },
);

defineEmits<{ (e: "navigate", key: string): void }>();
</script>

<template>
  <div class="flex items-center justify-between gap-4">
    <nav class="flex min-w-0 flex-wrap items-center gap-2" aria-label="目录">
      <button
        type="button"
        class="cursor-pointer text-sm transition-colors duration-200"
        :class="
          !rootLabel ? 'font-medium text-ink-1' : 'text-ink-2 hover:text-ink-1'
        "
        @click="$emit('navigate', '')"
      >
        本地视频
      </button>

      <template v-if="rootLabel">
        <span class="text-sm text-ink-2/60">/</span>
        <button
          type="button"
          class="cursor-pointer text-sm transition-colors duration-200"
          :class="
            !crumbs.length
              ? 'font-medium text-ink-1'
              : 'text-ink-2 hover:text-ink-1'
          "
          @click="$emit('navigate', '')"
        >
          {{ rootLabel }}
        </button>
      </template>

      <template v-for="(c, i) in crumbs" :key="c.key">
        <span class="text-sm text-ink-2/60">/</span>
        <button
          type="button"
          class="max-w-48 cursor-pointer truncate text-sm transition-colors duration-200"
          :class="
            i === crumbs.length - 1 && c.key === current
              ? 'font-medium text-ink-1'
              : 'text-ink-2 hover:text-ink-1'
          "
          :title="c.name"
          @click="$emit('navigate', c.key)"
        >
          {{ c.name }}
        </button>
      </template>
    </nav>

    <div class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
