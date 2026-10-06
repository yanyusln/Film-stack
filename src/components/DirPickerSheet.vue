<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import AppIcon from "@/components/AppIcon.vue";
import { useDirPickerStore } from "@/stores/dirPicker";

// 移动端选目录面板。dialog 插件在移动端没有目录选择器（详见 dirs.rs 与 dirPicker.ts 头注），
// 这里是它的替身：逐级下钻而不是摊平整棵树——手机屏幕窄，深层路径在整棵树里很难点准。
const picker = useDirPickerStore();
const {
  open,
  loading,
  errorText,
  entries,
  trail,
  canGoUp,
  canConfirm,
  currentPath,
} = storeToRefs(picker);

const crumbs = computed(() => trail.value.map((c) => c.name).join(" / "));
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center"
    role="dialog"
    aria-modal="true"
    aria-label="选择影片目录"
    @click.self="picker.cancel()"
  >
    <div
      class="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-pop bg-bg md:max-w-md md:rounded-pop"
      style="border: 1px solid var(--line)"
    >
      <header
        class="flex items-center gap-2 px-4 py-3"
        style="border-bottom: 1px solid var(--line)"
      >
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-ink-1">选择影片目录</p>
          <p class="truncate text-[11px] text-ink-2">{{ crumbs }}</p>
        </div>
        <button
          type="button"
          class="rounded-btn p-1 text-ink-2"
          aria-label="取消"
          @click="picker.cancel()"
        >
          <AppIcon name="x" :size="20" />
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <button
          v-if="canGoUp"
          type="button"
          class="flex w-full items-center gap-3 px-4 py-3 text-sm text-ink-2"
          style="border-bottom: 1px solid var(--line)"
          @click="picker.up()"
        >
          <AppIcon name="chevron-up" :size="18" />
          返回上一层
        </button>

        <p
          v-if="loading"
          class="flex items-center gap-2 px-4 py-6 text-sm text-ink-2"
        >
          <AppIcon name="refresh-cw" :size="18" class="animate-spin" />
          读取中…
        </p>

        <p v-else-if="errorText" class="px-4 py-6 text-sm text-pink">
          {{ errorText }}
          <span class="mt-1 block text-xs text-ink-2">
            若未经授权，请在「设置 → 权限 →
            文件和媒体」中允许管理所有文件后重试。
          </span>
        </p>

        <p
          v-else-if="entries.length === 0"
          class="px-4 py-6 text-sm text-ink-2"
        >
          这层没有子目录，可以直接选它。
        </p>

        <ul v-else>
          <li
            v-for="d in entries"
            :key="d.path"
            class="active:bg-bg-elev"
            style="border-bottom: 1px solid var(--line)"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3 text-left"
              @click="picker.enter(d)"
            >
              <AppIcon name="folder" :size="20" class="shrink-0 text-ink-2" />
              <span class="min-w-0 flex-1 truncate text-sm text-ink-1">{{
                d.name
              }}</span>
              <AppIcon name="chevron-right" :size="18" class="text-ink-2" />
            </button>
          </li>
        </ul>
      </div>

      <footer
        class="flex items-center gap-3 px-4 py-3 pad-bottom-safe"
        style="border-top: 1px solid var(--line)"
      >
        <button
          type="button"
          class="flex-1 rounded-btn py-2.5 text-sm text-ink-2"
          @click="picker.cancel()"
        >
          取消
        </button>
        <button
          type="button"
          class="flex-1 rounded-btn py-2.5 text-sm font-medium"
          :class="
            canConfirm
              ? 'bg-pink text-white'
              : 'cursor-not-allowed bg-ink-1/10 text-ink-2'
          "
          :disabled="!canConfirm"
          @click="picker.confirmHere()"
        >
          选择此目录
        </button>
      </footer>
      <p class="px-4 pb-2 text-center text-[11px] text-ink-2">
        {{ currentPath ?? "未选择目录" }}
      </p>
    </div>
  </div>
</template>
