<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useScanStore } from "@/stores/scan";
import { toRecord, useVideosStore } from "@/stores/videos";
import { useGroupsStore } from "@/stores/groups";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import { useResponsive } from "@/composables/usePlatform";
import { useDirPickerStore } from "@/stores/dirPicker";
import {
  buildFolderTree,
  childFolders,
  crumbsOf,
  dirKeyOf,
} from "@/composables/useFolderTree";
import VideoCard from "@/components/VideoCard.vue";
import EmptyState from "@/components/EmptyState.vue";
import VirtualGrid from "@/components/VirtualGrid.vue";
import BreadcrumbBar from "@/components/BreadcrumbBar.vue";
import FilterChips from "@/components/FilterChips.vue";
import AppIcon from "@/components/AppIcon.vue";
import type { GroupId, RootId, VideoRecord } from "@/types/video";

// 首页（设计稿 PC：面包屑 + 「+ 添加目录 / 刷新」+ 分组 chips + 统计 + 4 列卡片网格）。
// 目录树在侧栏（AppSidebar），这里只渲染当前目录这一层；手机无侧栏，保留根目录列表。
const router = useRouter();
const scan = useScanStore();
const videos = useVideosStore();
const groups = useGroupsStore();
const player = usePlayerStore();
const ui = useUiStore();
const { roots, isScanning, statusText, errorText } = storeToRefs(scan);
const {
  items,
  thumbState,
  thumbPath,
  selectedRootId,
  currentDir,
  selectedCount,
  loading,
} = storeToRefs(videos);
const { layout } = useResponsive();
const isPhone = computed(() => layout.value === "phone");
const isPc = computed(() => layout.value === "pc");

const currentRoot = computed(
  () => roots.value.find((r) => r.id === selectedRootId.value) ?? null,
);

/**
 * 当前节点的视频：根节点 = 整根聚合（设计稿「本地视频」默认视图就是全库平铺），
 * 下钻到某个子文件夹则看它的整棵子树（树上的数字也是这个口径，两处必须一致）。
 */
const dirItems = computed(() => {
  const root = currentRoot.value;
  if (!root) return [];
  const dir = currentDir.value;
  return items.value.filter((v) => {
    const key = dirKeyOf(v.path, root.path);
    return dir ? key === dir || key.startsWith(`${dir}/`) : true;
  });
});

// 搜索平铺（三视图之一，技术方案 §9.1）：纯本地按文件名过滤，不做远端请求
const keyword = ref("");
const searchBox = ref<HTMLInputElement | null>(null);
const searching = computed(() => keyword.value.trim().length > 0);

/** 分组 chips：全部 + 一级分组（点击即筛选到该分组，多归属引用不复制文件）。 */
const activeChip = ref("all");
const chipOptions = computed(() => [
  { key: "all", label: "全部" },
  ...groups.groups.map((g) => ({ key: g.id as string, label: g.name })),
]);

watch(activeChip, async (key) => {
  keyword.value = "";
  videos.clearSelection();
  if (key !== "all") await groups.loadItems(key as GroupId);
});

const baseItems = computed<VideoRecord[]>(() => {
  if (activeChip.value === "all") return dirItems.value;
  // 分组成员来自桥接层的 VideoMeta，补成展示记录后再进网格
  return (groups.itemsByGroup[activeChip.value] ?? []).map(toRecord);
});

const visible = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return baseItems.value;
  return baseItems.value.filter((v) => v.name.toLowerCase().includes(k));
});

/** 文件夹视图：当前目录下的直属子文件夹卡片（含各自视频数）。 */
const folderCards = computed(() => {
  const root = currentRoot.value;
  if (!root) return [];
  const tree = buildFolderTree(
    items.value.map((v) => dirKeyOf(v.path, root.path)),
    root.label,
  );
  return childFolders(tree, currentDir.value);
});

const crumbs = computed(() => crumbsOf(currentDir.value));

onMounted(() => {
  void scan.init();
  void groups.load();
});

async function onAdd() {
  // 选目录由 dirPicker 收口：桌面走原生对话框，移动端走本仓库的目录浏览
  const dir = await useDirPickerStore().pick();
  if (dir) await scan.addRoots([dir]);
}

async function onRemove(id: RootId) {
  await scan.removeRoot(id);
}

function onSelect(id: RootId) {
  void videos.load(id);
}

// 扫描结束后刷新当前目录，让新扫描到的视频（含重复计数）即时可见；
// 保持当前目录与已选（reload 而非 load），否则会把人弹回根目录
async function refreshSelected() {
  await videos.reload();
}

/** 面包屑/文件夹卡片下钻：进入某个相对目录（并回到「全部」视图）。 */
function onNavigate(key: string) {
  activeChip.value = "all";
  videos.setDir(key);
}

function goGroups() {
  void router.push("/groups");
}

/**
 * 下钻到别的目录时把分组筛选清掉：否则侧栏/面包屑换了目录，
 * 网格还卡在某个分组上，看起来就是「这个目录一个视频都没有」。
 */
watch(currentDir, () => {
  if (activeChip.value !== "all") activeChip.value = "all";
});

// ② 文件夹序播放列表：直接把当前视图的视频交给播放 store（技术方案 §8.6）
// 搜索态下按搜索结果连播，顺序仍是文件夹序（文件名自然序）的子集
async function onOpen(videoId: string) {
  const label =
    activeChip.value === "all"
      ? (currentRoot.value?.label ?? "")
      : (chipOptions.value.find((c) => c.key === activeChip.value)?.label ??
        "");
  const mode = activeChip.value === "all" ? "folder" : "group";
  // **先跳转、再准备**：openPlaylist 里有授权 / 读进度 / 转封装（AVI 要几秒），
  // 等它跑完才 push 的话，点击后首页会一动不动——真机反馈的「停顿」正是这个。
  // 准备过程由播放页自己显示（转圈 + 进度），这里只管把用户立刻送过去。
  void player.openPlaylist(visible.value, mode, label, videoId);
  await router.push("/player");
}

// 列数与行高估值（技术方案 §9.1 / §13.2）：手机 2 列保留原生滚动，平板 3 列 / PC 4 列走虚拟滚动
const virtualOn = computed(() => layout.value !== "phone");
const columns = computed(() => (layout.value === "pc" ? 4 : 3));
const rowEstimate = computed(() => (layout.value === "pc" ? 268 : 300));
// 设计稿：卡片间距 16px（8pt 网格），比手机端宽一点
const gridGap = computed(() => (layout.value === "phone" ? 12 : 16));

function focusSearch() {
  searchBox.value?.focus();
}

// ③ 多选（设计稿「已选 2 个」）：PC 鼠标形态给复选，选中后可加入分组（多归属引用）
const groupPanel = ref(false);

async function onAddSelected() {
  if (!selectedCount.value) return;
  if (!groups.groups.length) {
    ui.notify("还没有分组，先到「分组」里新建一个", "info");
    return;
  }
  if (groups.groups.length === 1) {
    await addSelectedTo(groups.groups[0].id);
    return;
  }
  groupPanel.value = !groupPanel.value;
}

async function addSelectedTo(groupId: string) {
  const ids = [...videos.selectedIds];
  const name = groups.groups.find((g) => g.id === groupId)?.name ?? "分组";
  await groups.addVideos(groupId as GroupId, ids);
  videos.clearSelection();
  groupPanel.value = false;
  ui.notify(`已把 ${ids.length} 个视频加入「${name}」`, "info");
}

defineExpose({ refreshSelected });
</script>

<template>
  <section class="flex flex-col gap-4">
    <!-- 面包屑 + 操作（设计稿：右上「+ 添加目录」与刷新图标） -->
    <BreadcrumbBar
      :root-label="currentRoot?.label ?? ''"
      :crumbs="crumbs"
      :current="currentDir"
      @navigate="onNavigate"
    >
      <template #actions>
        <!-- 搜索平铺（三视图之一）：本地过滤，不联网 -->
        <div class="relative">
          <input
            ref="searchBox"
            v-model="keyword"
            type="search"
            placeholder="搜索当前目录"
            class="h-9 w-44 rounded-btn bg-bg-elev pl-3 pr-8 text-sm text-ink-1 placeholder:text-ink-2 md:w-56"
            style="border: 1px solid var(--line)"
            aria-label="搜索当前目录"
          />
          <button
            v-if="searching"
            type="button"
            class="absolute right-1 top-1 grid h-7 w-7 cursor-pointer place-items-center rounded-btn text-ink-2 hover:text-ink-1"
            aria-label="清除筛选"
            @click="keyword = ''"
          >
            <AppIcon name="x" :size="14" />
          </button>
        </div>
        <button
          type="button"
          class="flex h-9 cursor-pointer items-center gap-1 rounded-btn bg-pink px-4 text-sm font-medium text-white transition-opacity duration-200 disabled:opacity-50"
          :disabled="isScanning"
          @click="onAdd"
        >
          <AppIcon name="plus" :size="16" />
          {{ isScanning ? "扫描中…" : "添加目录" }}
        </button>
        <button
          type="button"
          class="grid h-9 w-9 cursor-pointer place-items-center rounded-btn text-ink-2 transition-colors duration-200 hover:bg-ink-1/5 hover:text-ink-1 disabled:opacity-40"
          aria-label="刷新当前目录"
          :disabled="!selectedRootId || loading"
          @click="refreshSelected"
        >
          <AppIcon name="refresh-cw" :size="18" />
        </button>
      </template>
    </BreadcrumbBar>

    <!-- 扫描状态在 PC/平板由侧栏底部承担，只有手机没有侧栏时留在首页 -->
    <p v-if="statusText && isPhone" class="text-sm text-ink-2">
      {{ statusText }}
    </p>
    <p v-if="errorText" class="text-sm text-pink">{{ errorText }}</p>

    <!-- 手机无侧栏：根目录列表仍留在首页（PC/平板在侧栏目录树里） -->
    <ul v-if="isPhone" class="space-y-2">
      <li
        v-for="r in roots"
        :key="r.id"
        class="flex items-center justify-between rounded-card bg-bg-elev p-4"
        style="border: 1px solid var(--line)"
        :class="selectedRootId === r.id ? 'border-l-4' : ''"
        :style="
          selectedRootId === r.id ? 'border-left-color: var(--pink)' : undefined
        "
      >
        <button class="min-w-0 flex-1 text-left" @click="onSelect(r.id)">
          <p class="truncate font-medium text-ink-1">
            {{ r.label
            }}<span class="text-ink-2"> ({{ r.videoCount ?? 0 }})</span>
          </p>
          <p class="truncate text-xs text-ink-2">{{ r.path }}</p>
        </button>
        <button
          class="ml-4 shrink-0 text-sm text-ink-2 hover:text-ink-1 disabled:opacity-40"
          :disabled="isScanning"
          @click="onRemove(r.id)"
        >
          移除
        </button>
      </li>
    </ul>

    <p v-if="isPhone && !roots.length" class="text-sm text-ink-2">
      还没有影片目录。点击「添加目录」选择本地视频文件夹，开始扫描。
    </p>

    <template v-if="selectedRootId">
      <!-- 筛选行：分组 chips + 统计（设计稿「共 N 个视频 · 已选 M 个」） -->
      <FilterChips
        v-model="activeChip"
        :options="chipOptions"
        :total="visible.length"
        :selected="selectedCount"
      >
        <template #actions>
          <div class="relative">
            <button
              v-if="selectedCount"
              type="button"
              class="h-8 cursor-pointer rounded-btn bg-pink/10 px-3 text-sm font-medium text-pink"
              @click="onAddSelected"
            >
              加入分组
            </button>
            <div
              v-if="groupPanel"
              class="absolute right-0 top-9 z-30 w-44 rounded-pop bg-bg-elev p-1 shadow-[0_12px_32px_rgba(0,0,0,.22)]"
              style="border: 1px solid var(--line)"
            >
              <button
                v-for="g in groups.groups"
                :key="g.id"
                type="button"
                class="block w-full cursor-pointer truncate rounded-btn px-3 py-2 text-left text-sm text-ink-1 hover:bg-ink-1/5"
                @click="addSelectedTo(g.id)"
              >
                {{ g.name }}
              </button>
            </div>
          </div>
        </template>
      </FilterChips>

      <p v-if="loading" class="text-sm text-ink-2">加载中…</p>

      <template v-else>
        <!--
          文件夹视图：这一层的子文件夹卡片（点进下钻）。
          注意卡片下面照旧渲染该目录的视频网格——只画文件夹的话，下钻到最底层会「一个视频都没有」，
          用户得切回「全部视频」或刷新才看得到（v1 反馈的实际问题）。
        -->
        <div
          v-if="ui.libraryView === 'folders' && folderCards.length"
          class="grid gap-4"
          :class="
            isPc ? 'grid-cols-4' : isPhone ? 'grid-cols-2' : 'grid-cols-3'
          "
        >
          <button
            v-for="f in folderCards"
            :key="f.key"
            type="button"
            data-testid="folder-card"
            class="flex cursor-pointer flex-col gap-2 rounded-card bg-bg-elev p-4 text-left transition-shadow duration-200 hover:shadow-[0_8px_24px_rgba(0,0,0,.12)]"
            style="border: 1px solid var(--line)"
            @click="onNavigate(f.key)"
          >
            <span class="flex items-center gap-2 text-pink">
              <AppIcon name="folder" :size="20" />
              <span class="truncate text-sm font-medium text-ink-1">{{
                f.name
              }}</span>
            </span>
            <span class="text-xs text-ink-2">{{ f.count }} 个视频</span>
          </button>
        </div>

        <!-- 四套空态：搜索无结果 / 分组为空 / 目录无视频（技术方案 §10.3） -->
        <EmptyState
          v-if="searching && !visible.length"
          kind="search-empty"
          :compact="isPhone"
          @action="keyword = ''"
          @link="focusSearch"
        />
        <EmptyState
          v-else-if="!visible.length && activeChip !== 'all'"
          kind="group-empty"
          :compact="isPhone"
          @action="goGroups"
          @link="activeChip = 'all'"
        />
        <!-- 文件夹视图已经有子文件夹卡片时不算空，避免「上面有卡片、下面说没视频」的自相矛盾 -->
        <EmptyState
          v-else-if="
            !visible.length &&
            !(ui.libraryView === 'folders' && folderCards.length)
          "
          kind="folder-empty"
          :compact="isPhone"
          @action="refreshSelected"
          @link="onAdd"
        />

        <!-- 虚拟网格：PC/平板默认开启，窗口外不建 <img> 节点（技术方案 §13.2） -->
        <VirtualGrid
          v-else-if="virtualOn"
          :items="visible"
          :columns="columns"
          :estimate-row-height="rowEstimate"
          :gap="gridGap"
        >
          <template #item="{ item }">
            <VideoCard
              :video="item"
              :thumb-url="thumbPath[item.id] ?? null"
              :thumb-state="thumbState[item.id]"
              :selectable="isPc"
              :selected="videos.isSelected(item.id)"
              @click="onOpen(item.id)"
              @toggle-select="videos.toggleSelect(item.id)"
            />
          </template>
        </VirtualGrid>

        <div v-else class="grid grid-cols-2" :style="{ gap: `${gridGap}px` }">
          <VideoCard
            v-for="v in visible"
            :key="v.id"
            :video="v"
            :thumb-url="thumbPath[v.id] ?? null"
            :thumb-state="thumbState[v.id]"
            :selectable="isPc"
            :selected="videos.isSelected(v.id)"
            @click="onOpen(v.id)"
            @toggle-select="videos.toggleSelect(v.id)"
          />
        </div>
      </template>
    </template>
  </section>
</template>
