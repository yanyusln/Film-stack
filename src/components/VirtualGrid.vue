<script setup lang="ts" generic="T">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useWindowVirtualizer } from "@tanstack/vue-virtual";
import { chunkRows } from "@/composables/useVirtualGrid";

// 虚拟网格（W7-1 / 技术方案 §13.2）：PC / 平板的长列表默认开启，只渲染可视行 ± overscan。
// 窗口外的卡片不再建 <img> 节点（缩略图路径仍在 store 里，回来即可命中缓存）；
// 用 window 级滚动而不是内嵌滚动条，页面滚动手感与手机端保持一致。
const props = withDefaults(
  defineProps<{
    items: readonly T[];
    columns: number;
    /** 行高估值：封面 16:9 + 文本区，实际高度由 measureElement 校正。 */
    estimateRowHeight: number;
    gap?: number;
    overscan?: number;
  }>(),
  { gap: 12, overscan: 2 },
);

const listEl = ref<HTMLElement | null>(null);
const margin = ref(0);
const rows = computed(() => chunkRows(props.items, props.columns));

/** 列表相对文档顶部的位置：window 虚拟器要据此把滚动偏移换算成行偏移。 */
function measure() {
  const el = listEl.value;
  margin.value = el ? el.getBoundingClientRect().top + window.scrollY : 0;
}

onMounted(() => {
  measure();
  window.addEventListener("resize", measure);
});
onUnmounted(() => window.removeEventListener("resize", measure));

const virtualizer = useWindowVirtualizer(
  computed(() => ({
    count: rows.value.length,
    estimateSize: () => props.estimateRowHeight + props.gap,
    overscan: props.overscan,
    scrollMargin: margin.value,
  })),
);

const virtualRows = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());

function measureRow(el: unknown) {
  if (el instanceof HTMLElement) virtualizer.value.measureElement(el);
}
</script>

<template>
  <div
    ref="listEl"
    class="relative w-full"
    :style="{ height: `${totalSize}px` }"
  >
    <div
      v-for="row in virtualRows"
      :key="row.index"
      :ref="measureRow"
      class="absolute inset-x-0 top-0 grid"
      :style="{
        transform: `translateY(${row.start - margin}px)`,
        height: `${row.size}px`,
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: `${gap}px`,
      }"
    >
      <template v-for="(item, i) in rows[row.index]" :key="i">
        <slot name="item" :item="item" :index="row.index * columns + i" />
      </template>
    </div>
  </div>
</template>
