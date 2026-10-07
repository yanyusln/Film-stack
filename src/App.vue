<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { RouterView, RouterLink } from "vue-router";
import { storeToRefs } from "pinia";
import { useUiStore } from "@/stores/ui";
import { usePlayerStore } from "@/stores/player";
import { usePlatform } from "@/platform";
import { useResponsive } from "@/composables/usePlatform";
import AppSidebar from "@/components/AppSidebar.vue";
import ToastHost from "@/components/ToastHost.vue";
import DirPickerSheet from "@/components/DirPickerSheet.vue";
import AppIcon from "@/components/AppIcon.vue";

// 外壳（W6-1 / W6-3 + 设计稿 PC 校准）：PC/平板左侧栏（200px / 280dp，含文件夹树），
// 手机底部 4 Tab；暗色靠 <html class="dark"> 驱动语义令牌；安全区不裁内容。
const ui = useUiStore();
const player = usePlayerStore();
const { layout } = useResponsive();
const { theme } = storeToRefs(ui);

const isPhone = computed(() => layout.value === "phone");

/** 拆分后的四个入口；没有选中影片时「播放」不可点（技术方案 §9.1 手机 4 Tab）。 */
const tabs = computed(() => [
  { to: "/", label: "首页", icon: "house", disabled: false },
  { to: "/groups", label: "分组", icon: "folder", disabled: false },
  { to: "/player", label: "播放", icon: "play", disabled: !player.current },
  { to: "/settings", label: "设置", icon: "settings", disabled: false },
]);

function applyTheme(next: "light" | "dark") {
  document.documentElement.classList.toggle("dark", next === "dark");
}

watch(theme, applyTheme, { immediate: true });

// Android 上视频走本机回环媒体服务：先取端口（异步，拿到后封面/视频源自动重算）。
// 桌面端是空实现，不产生 IPC。
onMounted(() => {
  void usePlatform().ensureMediaServer();
});
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
        <RouterLink
          to="/settings"
          class="flex h-9 w-9 items-center justify-center rounded-btn text-ink-2 transition-colors duration-200 ease-out hover:text-ink-1"
          aria-label="设置"
          title="设置"
        >
          <AppIcon name="settings" :size="20" />
        </RouterLink>
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
        <AppIcon :name="t.icon" :size="22" />
        {{ t.label }}
      </RouterLink>
    </nav>

    <ToastHost />
    <!-- 移动端选根目录的替身：dialog 插件在移动端没有目录选择器 -->
    <DirPickerSheet />
  </div>
</template>
