<script setup lang="ts">
// 侧栏（设计稿 PC：左 200px 导航 + 文件夹树；平板：左 280dp 目录树）。
// 只读渲染；「移除根目录 / 重新扫描」走右键菜单，不占视觉（设计稿无删除入口）。
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import AppIcon from "@/components/AppIcon.vue";
import FolderTreeNode from "@/components/FolderTreeNode.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import { useScanStore } from "@/stores/scan";
import { useUiStore } from "@/stores/ui";
import { useVideosStore } from "@/stores/videos";
import { useResponsive } from "@/composables/usePlatform";
import { useDirPickerStore } from "@/stores/dirPicker";
import { buildFolderTree, dirKeyOf } from "@/composables/useFolderTree";
import type { FolderNode } from "@/composables/useFolderTree";
import type { RootMeta } from "@/bridge/contracts";
import type { MenuItem } from "@/types/ui";
import type { RootId } from "@/types/video";

const route = useRoute();
const router = useRouter();
const scan = useScanStore();
const ui = useUiStore();
const videos = useVideosStore();
const { roots, isScanning, statusText } = storeToRefs(scan);
const { items, selectedRootId, currentDir, loading } = storeToRefs(videos);
const { layout } = useResponsive();

const width = computed(() => (layout.value === "tablet" ? 280 : 200));

const NAVS = [
  { key: "all", label: "全部视频", icon: "list-video" },
  { key: "groups", label: "分组", icon: "layers" },
  { key: "folders", label: "文件夹", icon: "folder" },
  { key: "settings", label: "设置", icon: "settings" },
] as const;

function isActive(key: (typeof NAVS)[number]["key"]): boolean {
  if (key === "groups") return route.name === "groups";
  if (key === "settings") return route.name === "settings";
  return route.name === "home" && ui.libraryView === key;
}

async function onNav(key: (typeof NAVS)[number]["key"]) {
  if (key === "groups" || key === "settings") {
    void router.push(key === "groups" ? "/groups" : "/settings");
    return;
  }
  ui.setLibraryView(key);
  await router.push("/");
  // 还没有选中的根时先给一个，免得首页既没目录树选中项、也没内容
  if (!selectedRootId.value && roots.value.length) {
    await videos.load(roots.value[0].id);
  }
}

/** 当前选中根的派生目录树（数据来自已加载的 videos[].path，纯前端计算）。 */
const tree = computed<FolderNode | null>(() => {
  const root = roots.value.find((r) => r.id === selectedRootId.value);
  if (!root) return null;
  return buildFolderTree(
    items.value.map((v) => dirKeyOf(v.path, root.path)),
    root.label,
  );
});

/**
 * 侧栏树的根节点：数量取 `RootMeta.videoCount`（未展开也能显示「电影 (4)」），
 * 子节点只在当前选中根下才存在（点开某个根即加载该根）。
 */
const rootNodes = computed(() =>
  roots.value.map((r) => {
    const isCurrent = r.id === selectedRootId.value;
    const node =
      isCurrent && tree.value
        ? tree.value
        : { key: "", name: r.label, count: 0, depth: 0, children: [] };
    return {
      root: r,
      node: { ...node, name: r.label, count: r.videoCount ?? 0 },
    };
  }),
);

const activeKeyFor = (root: RootMeta) =>
  root.id === selectedRootId.value ? currentDir.value : "\u0000";

/**
 * 点树上的名字：别的根先加载（点开即选中该根），当前根则只是下钻到某个子目录。
 * 不改 libraryView——「文件夹」视图现在也会渲染该目录的视频，切视图交给左侧导航。
 */
async function onSelectNode(root: RootMeta, key: string) {
  if (root.id !== selectedRootId.value) {
    await videos.load(root.id);
    if (route.name !== "home") void router.push("/");
    return;
  }
  videos.setDir(key);
}

async function onAddRoot() {
  // 同 HomeView.onAdd：桌面原生对话框 / 移动端目录浏览，差异收口在 dirPicker
  const dir = await useDirPickerStore().pick();
  if (dir) await scan.addRoots([dir]);
}

// ---- 根节点右键：移除目录 / 重新扫描（C1：只删记录，不动磁盘）----
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);

function onRootMenu(root: RootMeta, ev: MouseEvent) {
  ev.preventDefault();
  const items: MenuItem[] = [];
  if (root.id === selectedRootId.value && currentDir.value) {
    items.push({
      key: "back",
      label: "回到根目录",
      run: () => videos.setDir(""),
    });
  }
  items.push({
    key: "rescan",
    label: `重新扫描「${root.label}」`,
    disabled: isScanning.value,
    run: () => void scan.startScan({ roots: [root.id], mode: "manual" }),
  });
  items.push({
    key: "remove",
    label: "移除该目录（不删文件）",
    danger: true,
    run: () => void scan.removeRoot(root.id as RootId),
  });
  menu.value = { x: ev.clientX, y: ev.clientY, items };
}
</script>

<template>
  <aside
    class="flex h-screen shrink-0 flex-col border-r bg-bg-elev"
    :style="{ width: `${width}px`, borderColor: 'var(--line)' }"
  >
    <div class="flex items-center gap-3 px-4 pb-4 pt-5">
      <span
        class="grid h-9 w-9 shrink-0 place-items-center rounded-btn bg-pink text-white"
      >
        <AppIcon name="film" :size="20" />
      </span>
      <span class="truncate text-base font-semibold text-ink-1">影栈</span>
    </div>

    <nav class="space-y-1 px-3">
      <button
        v-for="n in NAVS"
        :key="n.key"
        type="button"
        class="flex h-10 w-full cursor-pointer items-center gap-3 rounded-btn px-3 text-sm transition-colors duration-200"
        :class="
          isActive(n.key)
            ? 'bg-pink/10 font-medium text-pink'
            : 'text-ink-1 hover:bg-ink-1/5'
        "
        :aria-current="isActive(n.key) ? 'page' : undefined"
        @click="onNav(n.key)"
      >
        <AppIcon :name="n.icon" :size="18" />
        {{ n.label }}
      </button>
    </nav>

    <div class="mt-5 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
      <p class="px-2 pb-2 text-xs text-ink-2">文件夹树</p>

      <p v-if="!roots.length" class="px-2 text-xs text-ink-2">还没有影片目录</p>

      <ul v-else class="space-y-0.5">
        <li
          v-for="r in rootNodes"
          :key="r.root.id"
          @contextmenu="onRootMenu(r.root, $event)"
        >
          <FolderTreeNode
            :node="r.node"
            :active-key="activeKeyFor(r.root)"
            :expand-depth="1"
            @select="onSelectNode(r.root, $event)"
          />
        </li>
      </ul>

      <p v-if="loading" class="px-2 pt-2 text-xs text-ink-2">加载中…</p>
    </div>

    <div class="border-t px-3 py-3" style="border-color: var(--line)">
      <button
        type="button"
        class="flex h-8 w-full cursor-pointer items-center gap-1 px-2 text-sm text-pink disabled:opacity-40"
        :disabled="isScanning"
        @click="onAddRoot"
      >
        <AppIcon name="plus" :size="16" />
        添加根目录
      </button>
      <p v-if="statusText" class="truncate px-2 pt-1 text-xs text-ink-2">
        {{ statusText }}
      </p>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @select="(item) => ((menu = null), item.run?.())"
      @close="menu = null"
    />
  </aside>
</template>
