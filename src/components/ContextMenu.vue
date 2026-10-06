<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type { MenuItem } from "@/types/ui";

// 通用右键菜单容器（W3-3c）：跟随指针定位，贴边回弹，点击外部 / Esc 关闭，
// 支持 ↑↓ 选择 + Enter 确认，便于不走鼠标也能完成同样操作。
const props = defineProps<{ x: number; y: number; items: MenuItem[] }>();
const emit = defineEmits<{
  (e: "select", item: MenuItem): void;
  (e: "close"): void;
}>();

const root = ref<HTMLElement | null>(null);
const left = ref(props.x);
const top = ref(props.y);
const active = ref(0);

const enabledCount = computed(
  () => props.items.filter((it) => !it.disabled).length,
);

function step(dir: 1 | -1) {
  const n = props.items.length;
  if (!n) return;
  for (let k = 1; k <= n; k += 1) {
    const i = (((active.value + dir * k) % n) + n) % n;
    if (!props.items[i].disabled) {
      active.value = i;
      root.value?.querySelectorAll<HTMLElement>("[role=menuitem]")[i]?.focus();
      return;
    }
  }
}

function onKeyDown(ev: KeyboardEvent) {
  if (ev.key === "Escape") {
    emit("close");
    return;
  }
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    step(1);
    return;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    step(-1);
    return;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    const it = props.items[active.value];
    if (it && !it.disabled) emit("select", it);
  }
}

function onOutside(ev: PointerEvent) {
  if (!root.value?.contains(ev.target as Node)) emit("close");
}

function pick(it: MenuItem) {
  if (it.disabled) return;
  emit("select", it);
}

onMounted(async () => {
  await nextTick();
  // 贴边时回弹进视口，避免菜单被窗口裁掉
  const box = root.value?.getBoundingClientRect();
  if (box) {
    left.value = Math.max(
      8,
      Math.min(props.x, window.innerWidth - box.width - 8),
    );
    top.value = Math.max(
      8,
      Math.min(props.y, window.innerHeight - box.height - 8),
    );
  }
  if (enabledCount.value) {
    step(1);
    step(-1);
  } else {
    root.value?.focus();
  }
  window.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("keydown", onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      role="menu"
      tabindex="-1"
      class="fixed z-50 min-w-44 max-w-64 rounded-card bg-bg-elev py-1 shadow-[0_12px_32px_rgba(0,0,0,.18)] outline-none"
      :style="`left: ${left}px; top: ${top}px; border: 1px solid var(--line)`"
    >
      <button
        v-for="(it, i) in items"
        :key="it.key"
        type="button"
        role="menuitem"
        class="block w-full truncate px-3 py-2 text-left text-sm outline-none"
        :class="[
          it.disabled
            ? 'cursor-not-allowed text-ink-2 opacity-50'
            : it.danger
              ? 'text-pink'
              : 'text-ink-1',
          !it.disabled && i === active ? 'bg-bg' : '',
        ]"
        :disabled="it.disabled"
        @pointerenter="active = i"
        @click="pick(it)"
      >
        {{ it.label }}
      </button>
    </div>
  </Teleport>
</template>
