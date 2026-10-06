<script setup lang="ts">
// 筛选行（设计稿：左「全部 / 分组 chips」，右「共 N 个视频 · 已选 M 个」）。
// 取消选中项即视为「全部」；统计文案严格按设计稿措辞。
withDefaults(
  defineProps<{
    modelValue: string;
    options: Array<{ key: string; label: string }>;
    total: number;
    selected?: number;
  }>(),
  { selected: 0 },
);

defineEmits<{ (e: "update:modelValue", value: string): void }>();
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <slot name="leading" />
      <button
        v-for="opt in options"
        :key="opt.key"
        type="button"
        class="h-8 cursor-pointer rounded-btn px-3 text-sm transition-colors duration-200"
        :class="
          modelValue === opt.key
            ? 'bg-pink/10 font-medium text-pink'
            : 'text-ink-2 hover:bg-ink-1/5 hover:text-ink-1'
        "
        @click="$emit('update:modelValue', opt.key)"
      >
        {{ opt.label }}
      </button>
    </div>

    <div class="flex items-center gap-3">
      <slot name="actions" />
      <p class="text-xs text-ink-2">
        共 {{ total }} 个视频<template v-if="selected">
          · 已选 {{ selected }} 个</template
        >
      </p>
    </div>
  </div>
</template>
