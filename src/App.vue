<script setup lang="ts">
import { computed, watch } from "vue";
import { RouterView, RouterLink } from "vue-router";
import { storeToRefs } from "pinia";
import { useUiStore } from "@/stores/ui";
import { usePlayerStore } from "@/stores/player";
import { useResponsive } from "@/composables/usePlatform";
import AppSidebar from "@/components/AppSidebar.vue";
import ToastHost from "@/components/ToastHost.vue";
import DirPickerSheet from "@/components/DirPickerSheet.vue";

// 外壳（W6-1 / W6-3 + 设计稿 PC 校准）：PC/平板左侧栏（200px / 280dp，含文件夹树），
// 手机底部 4 Tab；暗色靠 <html class="dark"> 驱动语义令牌；安全区不裁内容。
const ui = useUiStore();
const player = usePlayerStore();
const { layout } = useResponsive();
const { theme } = storeToRefs(ui);

const isPhone = computed(() => layout.value === "phone");

/** 拆分后的四个入口；没有选中影片时「播放」不可点（技术方案 §9.1 手机 4 Tab）。 */
const tabs = computed(() => [
  { to: "/", label: "首页", icon: "home", disabled: false },
  { to: "/groups", label: "分组", icon: "group", disabled: false },
  { to: "/player", label: "播放", icon: "play", disabled: !player.current },
  { to: "/settings", label: "设置", icon: "settings", disabled: false },
]);

function applyTheme(next: "light" | "dark") {
  document.documentElement.classList.toggle("dark", next === "dark");
}

watch(theme, applyTheme, { immediate: true });
</script>

<template>
  <div class="flex min-h-screen bg-bg text-ink-1">
    <AppSidebar v-if="!isPhone" />

    <div class="flex min-h-screen min-w-0 flex-1 flex-col">
      <header
        v-if="isPhone"
        class="flex h-12 items-center justify-between border-b pad-x-safe"
        style="border-color: var(--line)"
      >
        <span class="font-semibold">影栈</span>
        <RouterLink to="/settings" class="text-sm text-ink-2">设置</RouterLink>
      </header>

      <main
        class="flex-1"
        :class="isPhone ? 'pad-x-safe pb-20 pt-4 pad-bottom-safe' : 'px-6 py-6'"
      >
        <RouterView />
      </main>
    </div>

    <nav
      v-if="isPhone"
      class="fixed inset-x-0 bottom-0 z-40 flex border-t bg-bg-elev tab-safe"
      style="border-color: var(--line)"
    >
      <RouterLink
        v-for="t in tabs"
        :key="t.to"
        :to="t.to"
        class="flex flex-1 flex-col items-center gap-1 py-2 text-xs text-ink-2"
        :class="
          t.disabled ? 'pointer-events-none opacity-40' : 'active:text-pink'
        "
        active-class="text-pink"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-5 w-5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            v-if="t.icon === 'home'"
            d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z"
          />
          <path
            v-else-if="t.icon === 'group'"
            d="M4 6h6l2 2h8v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"
          />
          <path v-else-if="t.icon === 'play'" d="M8 5l11 7-11 7Z" />
          <path v-else d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
          <path
            v-if="t.icon === 'settings'"
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.3a2 2 0 1 1 4 0A1.7 1.7 0 0 0 16.9 5.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"
          />
        </svg>
        {{ t.label }}
      </RouterLink>
    </nav>

    <ToastHost />
    <!-- 移动端选根目录的替身：dialog 插件在移动端没有目录选择器 -->
    <DirPickerSheet />
  </div>
</template>
