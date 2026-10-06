<script setup lang="ts">
// ⠿ 拖拽手柄（组件规范表 sheet2「拖拽手柄」行）：视觉 24×24、粉 #FB7299、
// 触控热区 44×44，touch-none 让触屏上的拖拽不被页面滚动吞掉。
// 6 圆点用 SVG 而非 Unicode 盲文字符绘制，避免 Android 字体缺字形时显示豆腐块。
const dots = [1, 2, 3, 4, 5, 6].map((n) => ({
  cx: n % 2 === 1 ? 8 : 16,
  cy: 6 + Math.floor((n - 1) / 2) * 6,
}));
</script>

<template>
  <span
    data-drag-handle
    class="flex h-11 w-11 shrink-0 touch-none select-none items-center justify-center text-pink"
  >
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        v-for="(d, i) in dots"
        :key="i"
        :cx="d.cx"
        :cy="d.cy"
        r="2"
        fill="currentColor"
      />
    </svg>
  </span>
</template>
