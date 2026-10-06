import { onMounted, onUnmounted, ref } from "vue";

// 三端断点：<600 手机 / 600–839 过渡 / 840–1439 平板 / ≥1440 PC（技术方案 §9.1）。
export type Layout = "phone" | "tablet" | "pc";

function layoutOf(width: number): Layout {
  if (width >= 1440) return "pc";
  if (width >= 840) return "tablet";
  return "phone";
}

export function useResponsive() {
  const width = ref(typeof window !== "undefined" ? window.innerWidth : 1280);
  const layout = ref<Layout>(layoutOf(width.value));

  function update() {
    width.value = window.innerWidth;
    layout.value = layoutOf(width.value);
  }

  // 横竖屏/折叠屏展开不改变路由，只重算列数与安全区（技术方案 §9.1）
  onMounted(() => {
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
  });
  onUnmounted(() => {
    window.removeEventListener("resize", update);
    window.removeEventListener("orientationchange", update);
  });

  return { width, layout };
}
