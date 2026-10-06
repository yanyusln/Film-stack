<script setup lang="ts">
import { computed } from "vue";
import { EMPTY_STATES, type EmptyKind } from "@/composables/emptyStates";

// 空状态（W6-2 / 技术方案 §10.3）：灰粉线稿插画 + 固定文案 + 一个主操作一个文字链接。
// 插画只表达「空」，不出现云、会员、网络、登录等意象；描边随主题翻转（--illu-line）。
const props = defineProps<{
  kind: EmptyKind;
  /** 插画尺寸：移动端 160px、桌面 240px（方案给定上限）。 */
  compact?: boolean;
}>();
const emit = defineEmits<{ action: []; link: [] }>();

const spec = computed(() => EMPTY_STATES[props.kind]);
</script>

<template>
  <div
    class="flex flex-col items-center justify-center gap-3 rounded-card px-4 py-6 text-center"
  >
    <svg
      viewBox="0 0 96 72"
      :class="compact ? 'h-24 w-40' : 'h-32 w-60'"
      aria-hidden="true"
      fill="none"
      stroke="var(--illu-line)"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <!-- 无分组：空胶片盒 + 一张卡片 -->
      <g v-if="kind === 'no-group'">
        <rect x="14" y="26" width="56" height="34" rx="6" />
        <path d="M14 34h56" />
        <rect
          x="24"
          y="14"
          width="36"
          height="14"
          rx="4"
          stroke="var(--pink)"
        />
        <circle cx="42" cy="47" r="6" stroke="var(--pink)" />
      </g>

      <!-- 分组为空：打开的盒子 + 漂浮标签 -->
      <g v-else-if="kind === 'group-empty'">
        <path d="M20 40h56v22a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V40Z" />
        <path d="M20 40 28 22h40l8 18" stroke="var(--pink)" />
        <rect x="34" y="12" width="20" height="8" rx="4" />
        <rect x="56" y="6" width="16" height="8" rx="4" />
      </g>

      <!-- 目录无视频：放大镜照文件夹 -->
      <g v-else-if="kind === 'folder-empty'">
        <path
          d="M14 24h24l6 8h30a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V26a2 2 0 0 1 2-2Z"
        />
        <circle cx="58" cy="34" r="12" stroke="var(--pink)" />
        <path d="M66 42l8 8" stroke="var(--pink)" />
      </g>

      <!-- 搜索无结果：胶片条 + 散开的小圆点 -->
      <g v-else>
        <rect x="12" y="24" width="66" height="24" rx="4" />
        <path d="M12 32h66M12 40h66" />
        <circle cx="22" cy="28" r="1.5" stroke="var(--pink)" />
        <circle cx="22" cy="44" r="1.5" stroke="var(--pink)" />
        <circle cx="68" cy="28" r="1.5" stroke="var(--pink)" />
        <circle cx="68" cy="44" r="1.5" stroke="var(--pink)" />
        <circle cx="30" cy="60" r="2" />
        <circle cx="48" cy="64" r="2" />
        <circle cx="66" cy="58" r="2" />
      </g>
    </svg>

    <p class="text-base font-medium text-ink-1">{{ spec.title }}</p>
    <p class="max-w-72 text-sm text-ink-2">{{ spec.hint }}</p>

    <div class="mt-1 flex items-center gap-3">
      <button
        class="rounded-btn bg-pink px-4 py-2 text-sm font-medium text-white"
        @click="emit('action')"
      >
        {{ spec.action }}
      </button>
      <button class="text-sm text-ink-2 hover:text-ink-1" @click="emit('link')">
        {{ spec.link }}
      </button>
    </div>
  </div>
</template>
