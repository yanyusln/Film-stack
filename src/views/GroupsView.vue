<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useGroupsStore } from "@/stores/groups";
import { useVideosStore } from "@/stores/videos";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import { useResponsive } from "@/composables/usePlatform";
import { useDrag, type DragMode } from "@/composables/useDrag";
import { useRouter } from "vue-router";
import DragHandle from "@/components/DragHandle.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import EmptyState from "@/components/EmptyState.vue";
import type { MenuItem } from "@/types/ui";
import type { GroupMeta } from "@/bridge/contracts";
import type { GroupId } from "@/types/video";

// 分组管理（W3-3）：一级分组的增删改与排序提交，顺序持久化由 W3-2 的数据层负责。
// 这里只负责编排：拖拽/上移下移 -> store.applyOrder -> 单事务落库，失败自动回滚 + toast。
const router = useRouter();
const groupsStore = useGroupsStore();
const videos = useVideosStore();
const player = usePlayerStore();
const { groups, itemsByGroup, selectedGroupId, errorText, pendingCommits } =
  storeToRefs(groupsStore);
const { items: rootVideos, thumbPath, selectedRootId } = storeToRefs(videos);
const ui = useUiStore();
const { editMode } = storeToRefs(ui);
const { layout } = useResponsive();

const isPhone = computed(() => layout.value === "phone");
const isTablet = computed(() => layout.value === "tablet");
const newName = ref("");

const members = computed(() =>
  selectedGroupId.value
    ? (itemsByGroup.value[selectedGroupId.value] ?? [])
    : [],
);
const memberIds = computed(() => new Set(members.value.map((v) => v.id)));
// 可添加：当前根目录已加载、且尚未属于该分组的视频
const addable = computed(() =>
  rootVideos.value.filter((v) => !memberIds.value.has(v.id)),
);

onMounted(() => {
  void groupsStore.load();
});

// ① 分组内重排：PC/平板直接鼠标拖动，手机需先进编辑模式且从 ⠿ 手柄起手。
const {
  container: listSurface,
  state: reorderState,
  onDown: onReorderDown,
  cancel: cancelReorder,
} = useDrag({
  mode: computed<DragMode>(() => layout.value),
  axis: "y",
  enabled: computed(() => !isPhone.value || editMode.value),
  onCommit: async (from, to) => {
    const gid = selectedGroupId.value;
    if (!gid) return false;
    return groupsStore.moveTo(gid, from, to);
  },
});

// ② 平板跨列：左侧分组树为落点（data-tree-index），右侧影片网格为拖起源（data-drag-index）。
const {
  container: crossSurface,
  state: crossState,
  onDown: onCrossDown,
} = useDrag({
  mode: "tablet",
  axis: "free",
  targetAttr: "data-tree-index",
  enabled: isTablet,
  onCommit: async (from, to) => {
    const group = groups.value[to];
    const video = addable.value[from];
    if (!group || !video) return false;
    await onAddVideo(video.id, group.id);
    return true;
  },
});

// 手机退出编辑模式：取消拖拽并丢弃尚未确认的顺序（技术方案 §8.4）
watch(editMode, (v) => {
  if (!v) {
    cancelReorder();
    groupsStore.cancelPending();
  }
});

function onMemberDown(index: number, ev: PointerEvent) {
  const target = ev.target as HTMLElement | null;
  // 列表内的按钮不触发拖拽；手机端只能从 ⠿ 手柄起手
  if (target?.closest("button")) return;
  if (isPhone.value && !target?.closest("[data-drag-handle]")) return;
  onReorderDown(index, ev);
}

function onSourceDown(index: number, ev: PointerEvent) {
  const target = ev.target as HTMLElement | null;
  if (target?.closest("button")) return;
  onCrossDown(index, ev);
}

// 拖影：跟随指针的轻量预览（120ms 淡入，组件规范表 sheet2/sheet4）
const ghost = computed(() => {
  const r = reorderState.value;
  if (r.active) {
    const v = members.value[r.from];
    if (v) return { name: v.name, thumb: thumbUrl(v.id), x: r.x, y: r.y };
  }
  const c = crossState.value;
  if (c.active) {
    const v = addable.value[c.from];
    if (v) return { name: v.name, thumb: thumbUrl(v.id), x: c.x, y: c.y };
  }
  return null;
});

// 拖拽中的项：倾斜 + 投影 + 插入线（组件规范表 sheet2「拖拽手柄」/ sheet4 dragging 态）
function draggingStyle(index: number): string | undefined {
  const s = reorderState.value;
  if (!s.active || s.from !== index) return undefined;
  return "box-shadow: 0 12px 32px rgba(0,0,0,.22); transform: rotate(1.5deg)";
}

// 落点：粉虚线描边，向上时画在项上方、向下时画在项下方
function insertion(index: number): "top" | "bottom" | null {
  const s = reorderState.value;
  if (!s.active || s.to !== index || s.from === index) return null;
  return index < s.from ? "top" : "bottom";
}

// 平板跨列：命中的分组高亮（释放后才提交）
function treeDropActive(index: number): boolean {
  return crossState.value.active && crossState.value.to === index;
}

function thumbUrl(id: string): string | null {
  const p = thumbPath.value[id];
  return p ? convertFileSrc(p) : null;
}

async function onCreate() {
  const name = newName.value.trim();
  if (!name) return;
  newName.value = "";
  await groupsStore.create(name);
}

async function onSelect(id: string) {
  const gid = id as GroupId;
  await groupsStore.loadItems(gid);
  videos.seedThumbs(itemsByGroup.value[gid] ?? []);
}

async function onRemoveGroup(id: string) {
  await groupsStore.remove(id as GroupId);
}

async function onAddVideo(videoId: string, groupId: string) {
  const gid = groupId as GroupId;
  await groupsStore.addVideos(gid, [videoId]);
  videos.seedThumbs(itemsByGroup.value[gid] ?? []);
}

async function onAdd(videoId: string) {
  const gid = selectedGroupId.value;
  if (!gid) return;
  await onAddVideo(videoId, gid);
}

async function onRemove(videoId: string) {
  const gid = selectedGroupId.value;
  if (!gid) return;
  await groupsStore.removeVideo(gid, videoId);
}

// ① 分组序播放列表（技术方案 §8.6）：按这里的 sort_order 顺序播放，与应用内的拖拽结果一致
async function onPlay(videoId: string) {
  const label =
    groups.value.find((g) => g.id === selectedGroupId.value)?.name ?? "";
  // 同首页：先跳转再准备（转封装可能要几秒），别让点击后停在本页没反应
  void player.openPlaylist(members.value, "group", label, videoId);
  await router.push("/player");
}

// ---- 右键菜单（W3-3c / 技术方案 §8.4）：PC 鼠标右键提供添加 / 移除 / 新建分组 ----
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);

function openMenu(ev: MouseEvent, items: MenuItem[]) {
  // 触屏长按同样会触发 contextmenu，手机形态不接管（右键菜单属 PC 交互）
  if (isPhone.value) return;
  ev.preventDefault();
  ev.stopPropagation();
  menu.value = { x: ev.clientX, y: ev.clientY, items };
}

function focusNewGroup() {
  nameInput.value?.focus();
}

/** 空态的次操作：从视频页挑片加入当前分组 */
function goHome() {
  void router.push("/");
}

function removeSelectedGroup() {
  const gid = selectedGroupId.value;
  if (gid) void onRemoveGroup(gid);
}

// 左侧空白处右键：只有「新建分组」
function onPanelMenu(ev: MouseEvent) {
  openMenu(ev, [{ key: "new", label: "新建分组", run: focusNewGroup }]);
}

function onGroupMenu(ev: MouseEvent, g: GroupMeta) {
  openMenu(ev, [
    { key: "open", label: `查看「${g.name}」`, run: () => void onSelect(g.id) },
    { key: "new", label: "新建分组", run: focusNewGroup },
    {
      key: "del",
      label: "删除分组",
      danger: true,
      run: () => void onRemoveGroup(g.id),
    },
  ]);
}

function onMemberMenu(ev: MouseEvent, index: number) {
  const v = members.value[index];
  if (!v) return;
  openMenu(ev, [
    {
      key: "up",
      label: "上移",
      disabled: index === 0,
      run: () => void onMove(index, "up"),
    },
    {
      key: "down",
      label: "下移",
      disabled: index === members.value.length - 1,
      run: () => void onMove(index, "down"),
    },
    {
      key: "out",
      label: "移出本组",
      danger: true,
      run: () => void onRemove(v.id),
    },
  ]);
}

// 多归属：直接列出全部分组，「添加到 X」可重复执行
function onVideoMenu(ev: MouseEvent, videoId: string) {
  const list = groups.value;
  openMenu(
    ev,
    list.length
      ? list.map((g) => ({
          key: `add:${g.id}`,
          label: `添加到「${g.name}」`,
          run: () => void onAddVideo(videoId, g.id),
        }))
      : [{ key: "none", label: "尚未有分组", disabled: true }],
  );
}

function onMenuSelect(item: MenuItem) {
  menu.value = null;
  item.run?.();
}

async function onMove(index: number, dir: "up" | "down") {
  const gid = selectedGroupId.value;
  if (!gid) return;
  // 失败时 store 已回滚内存顺序并 toast，这里不做额外处理
  if (dir === "up") await groupsStore.moveUp(gid, index);
  else await groupsStore.moveDown(gid, index);
}
</script>

<template>
  <section class="space-y-4">
    <header class="flex items-center justify-between gap-3">
      <h1 class="text-base font-semibold text-ink-1">分组</h1>
      <div class="flex items-center gap-2">
        <button
          v-if="isPhone"
          class="rounded-btn px-3 py-2 text-sm"
          style="border: 1px solid var(--line)"
          @click="ui.editMode = !ui.editMode"
        >
          {{ editMode ? "完成" : "编辑" }}
        </button>
        <form class="flex items-center gap-2" @submit.prevent="onCreate">
          <input
            ref="nameInput"
            v-model="newName"
            class="rounded-btn bg-bg-elev px-3 py-2 text-sm text-ink-1"
            style="border: 1px solid var(--line)"
            placeholder="新分组名称"
          />
          <button
            type="submit"
            class="rounded-btn bg-pink px-4 py-2 text-sm font-medium text-white"
          >
            新建分组
          </button>
        </form>
      </div>
    </header>

    <p v-if="errorText" class="text-sm text-pink">{{ errorText }}</p>

    <div
      ref="crossSurface"
      class="grid gap-4 md:grid-cols-[220px_1fr]"
      :style="isTablet ? 'grid-template-columns: 280px 1fr' : undefined"
    >
      <aside @contextmenu="onPanelMenu">
        <!-- 无分组（技术方案 §10.3）：主操作新建分组，次操作回视频页挑片 -->
        <EmptyState
          v-if="!groups.length"
          kind="no-group"
          :compact="isPhone"
          @action="focusNewGroup"
          @link="goHome"
        />
        <ul v-else class="space-y-2">
          <li
            v-for="(g, gi) in groups"
            :key="g.id"
            :data-tree-index="gi"
            class="flex items-center justify-between rounded-card bg-bg-elev p-3"
            :class="treeDropActive(gi) ? 'border-pink-dashed' : ''"
            :style="
              selectedGroupId === g.id
                ? 'border-left: 4px solid var(--pink)'
                : undefined
            "
            @contextmenu="(e) => onGroupMenu(e, g)"
          >
            <button class="min-w-0 flex-1 text-left" @click="onSelect(g.id)">
              <span class="truncate text-sm font-medium text-ink-1">{{
                g.name
              }}</span>
            </button>
            <button
              class="ml-2 shrink-0 text-sm text-ink-2 hover:text-ink-1"
              @click="onRemoveGroup(g.id)"
            >
              删除
            </button>
          </li>
        </ul>
      </aside>

      <div class="space-y-4">
        <div>
          <h2 class="mb-2 text-sm font-semibold text-ink-1">
            成员（{{ members.length }}）
            <span v-if="pendingCommits" class="ml-2 text-xs text-ink-2"
              >保存中…</span
            >
          </h2>

          <p v-if="!selectedGroupId" class="text-sm text-ink-2">
            选择左侧分组查看成员。
          </p>
          <!-- 分组为空（技术方案 §10.3）：主操作去视频页添加，次操作取消该分组 -->
          <EmptyState
            v-else-if="!members.length"
            kind="group-empty"
            :compact="isPhone"
            @action="goHome"
            @link="removeSelectedGroup"
          />
          <ul
            v-else
            ref="listSurface"
            class="space-y-2"
            :class="reorderState.active ? 'select-none' : ''"
          >
            <li
              v-for="(v, i) in members"
              :key="v.id"
              :data-drag-index="i"
              :data-drop-index="i"
              class="relative flex items-center gap-3 rounded-card bg-bg-elev p-2 transition-[transform,box-shadow] duration-[160ms] ease-[cubic-bezier(.2,.9,.2,1)]"
              :class="
                reorderState.active && reorderState.from === i
                  ? 'opacity-80'
                  : ''
              "
              :style="`border: 1px solid var(--line); ${draggingStyle(i) ?? ''}`"
              @pointerdown="onMemberDown(i, $event)"
              @contextmenu="(e) => onMemberMenu(e, i)"
            >
              <span
                v-if="insertion(i) === 'top'"
                class="pointer-events-none absolute inset-x-0 -top-1 h-0"
                style="border-top: 2px dashed var(--pink)"
              />
              <span
                v-if="insertion(i) === 'bottom'"
                class="pointer-events-none absolute inset-x-0 -bottom-1 h-0"
                style="border-bottom: 2px dashed var(--pink)"
              />
              <DragHandle v-if="isPhone && editMode" />
              <div
                class="h-[72px] w-32 shrink-0 overflow-hidden rounded-btn bg-bg"
              >
                <img
                  v-if="thumbUrl(v.id)"
                  :src="thumbUrl(v.id) ?? ''"
                  alt=""
                  class="h-full w-full object-cover"
                />
              </div>
              <p class="min-w-0 flex-1 truncate text-sm text-ink-1">
                {{ v.name }}
              </p>
              <button
                class="rounded-btn px-2 py-1 text-xs text-pink"
                @click="onPlay(v.id)"
              >
                播放
              </button>
              <button
                class="rounded-btn px-2 py-1 text-xs text-ink-2 hover:text-ink-1 disabled:opacity-40"
                :disabled="i === 0"
                @click="onMove(i, 'up')"
              >
                上移
              </button>
              <button
                class="rounded-btn px-2 py-1 text-xs text-ink-2 hover:text-ink-1 disabled:opacity-40"
                :disabled="i === members.length - 1"
                @click="onMove(i, 'down')"
              >
                下移
              </button>
              <button
                class="rounded-btn px-2 py-1 text-xs text-ink-2 hover:text-ink-1"
                @click="onRemove(v.id)"
              >
                移出
              </button>
            </li>
          </ul>
        </div>

        <div v-if="selectedGroupId">
          <h2 class="mb-2 text-sm font-semibold text-ink-1">可添加的影片</h2>
          <p v-if="!selectedRootId" class="text-sm text-ink-2">
            请先在「首页」选择一个影片目录。
          </p>
          <p v-else-if="!addable.length" class="text-sm text-ink-2">
            当前目录下的影片都已在该分组中。
          </p>
          <ul
            v-else-if="isTablet"
            class="grid grid-cols-3 gap-2"
            :class="crossState.active ? 'select-none' : ''"
          >
            <li
              v-for="(v, i) in addable"
              :key="v.id"
              :data-drag-index="i"
              class="rounded-card bg-bg-elev p-2"
              :class="
                crossState.active && crossState.from === i ? 'opacity-60' : ''
              "
              style="border: 1px solid var(--line)"
              @pointerdown="onSourceDown(i, $event)"
              @contextmenu="(e) => onVideoMenu(e, v.id)"
            >
              <div class="aspect-video overflow-hidden rounded-btn bg-bg">
                <img
                  v-if="thumbUrl(v.id)"
                  :src="thumbUrl(v.id) ?? ''"
                  alt=""
                  class="h-full w-full object-cover"
                />
              </div>
              <p class="mt-1 truncate text-xs text-ink-1">{{ v.name }}</p>
            </li>
          </ul>
          <ul v-else class="max-h-80 space-y-2 overflow-y-auto pr-1">
            <li
              v-for="v in addable"
              :key="v.id"
              class="flex items-center justify-between rounded-card bg-bg-elev p-2"
              style="border: 1px solid var(--line)"
              @contextmenu="(e) => onVideoMenu(e, v.id)"
            >
              <p class="min-w-0 flex-1 truncate text-sm text-ink-1">
                {{ v.name }}
              </p>
              <button
                class="ml-3 shrink-0 rounded-btn px-2 py-1 text-xs text-ink-2 hover:text-ink-1"
                @click="onAdd(v.id)"
              >
                加入
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="ghost"
        class="pointer-events-none fixed z-50 max-w-56 truncate rounded-btn bg-bg-elev px-3 py-2 text-xs text-ink-1 opacity-90 shadow-[0_12px_32px_rgba(0,0,0,.22)] transition-opacity duration-[120ms]"
        :style="`left: ${ghost.x + 12}px; top: ${ghost.y + 8}px`"
      >
        {{ ghost.name }}
      </div>
    </Teleport>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </section>
</template>

<style scoped>
/* 平板跨列落点：粉虚线描边 2px（AGENTS §7 / 技术方案 §8.4） */
.border-pink-dashed {
  border: 2px dashed var(--pink);
}
</style>
