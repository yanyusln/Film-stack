import { defineStore } from "pinia";
import { ref } from "vue";
import * as cmd from "@/bridge/commands";
import { useUiStore } from "@/stores/ui";
import type { GroupMeta, VideoMeta } from "@/bridge/contracts";
import type { GroupId } from "@/types/video";

// 分组 store（W3-1）：仅一级分组、多归属引用、排序持久化、删除只删引用。
// 排序用小数 (prev+next)/2；冲突过多时由后端/调用方重建整数步长（见 W3-2）。
export const useGroupsStore = defineStore("groups", () => {
  const ui = useUiStore();
  const groups = ref<GroupMeta[]>([]);
  const itemsByGroup = ref<Record<string, VideoMeta[]>>({});
  const selectedGroupId = ref<GroupId | null>(null);
  const editing = ref(false);
  const errorText = ref("");
  // 服务端已确认的顺序快照 + 未落库的提交数：退出编辑模式时据此丢弃乐观改动（技术方案 §8.4）
  const confirmedOrders = new Map<string, VideoMeta[]>();
  const pendingCommits = ref(0);

  function remember(groupId: GroupId) {
    confirmedOrders.set(groupId, [...(itemsByGroup.value[groupId] ?? [])]);
  }

  async function load() {
    errorText.value = "";
    try {
      groups.value = await cmd.listGroups();
    } catch (e) {
      errorText.value = `读取分组失败：${String(e)}`;
    }
  }

  async function create(name: string) {
    if (!name.trim()) return;
    try {
      const g = await cmd.createGroup(name.trim());
      groups.value = [...groups.value, g];
    } catch (e) {
      errorText.value = `新建分组失败：${String(e)}`;
    }
  }

  async function remove(groupId: GroupId) {
    try {
      await cmd.removeGroup(groupId);
      groups.value = groups.value.filter((g) => g.id !== groupId);
      delete itemsByGroup.value[groupId];
      if (selectedGroupId.value === groupId) selectedGroupId.value = null;
    } catch (e) {
      errorText.value = `删除分组失败：${String(e)}`;
    }
  }

  async function addVideos(groupId: GroupId, videoIds: string[]) {
    if (!videoIds.length) return;
    try {
      await cmd.addToGroup(groupId, videoIds);
      await loadItems(groupId);
    } catch (e) {
      errorText.value = `加入分组失败：${String(e)}`;
    }
  }

  async function removeVideo(groupId: GroupId, videoId: string) {
    try {
      await cmd.removeFromGroup(groupId, videoId);
      itemsByGroup.value[groupId] = (itemsByGroup.value[groupId] ?? []).filter(
        (v) => v.id !== videoId,
      );
    } catch (e) {
      errorText.value = `移出分组失败：${String(e)}`;
    }
  }

  async function loadItems(groupId: GroupId) {
    try {
      itemsByGroup.value[groupId] = await cmd.listGroupItems(groupId);
      selectedGroupId.value = groupId;
      remember(groupId);
    } catch (e) {
      errorText.value = `读取分组内容失败：${String(e)}`;
    }
  }

  async function setOrder(
    groupId: GroupId,
    videoId: string,
    sortOrder: number,
  ) {
    try {
      await cmd.setGroupOrder(groupId, videoId, sortOrder);
    } catch (e) {
      errorText.value = `保存排序失败：${String(e)}`;
    }
  }

  // W3-2：整列提交。乐观重排 -> 后端只写变化项；失败由 Rust 事务回滚，这里回滚内存顺序并 toast（§8.4）。
  // W3-3 拖拽释放后调用本函数，返回 false 表示调用方需重置拖拽状态。
  async function applyOrder(groupId: GroupId, orderedIds: string[]) {
    const prev = itemsByGroup.value[groupId] ?? [];
    const snapshot = [...prev];
    const byId = new Map(prev.map((v) => [v.id, v]));
    const next = orderedIds
      .map((id) => byId.get(id))
      .filter((v): v is VideoMeta => Boolean(v));
    if (next.length !== snapshot.length || next.length !== orderedIds.length) {
      errorText.value = "分组内容与排序不一致，请刷新后重试";
      return false;
    }
    itemsByGroup.value[groupId] = next;
    pendingCommits.value += 1;
    try {
      await cmd.setSortOrder(groupId, orderedIds);
      remember(groupId);
      return true;
    } catch (e) {
      itemsByGroup.value[groupId] = snapshot;
      errorText.value = `保存排序失败：${String(e)}`;
      ui.notify("排序保存失败，已恢复原顺序", "error");
      return false;
    } finally {
      pendingCommits.value -= 1;
    }
  }

  // 手机退出编辑模式时丢弃尚未确认的顺序改动（技术方案 §8.4）。
  function cancelPending(groupId?: GroupId) {
    const targets = groupId ? [groupId] : Array.from(confirmedOrders.keys());
    for (const gid of targets) {
      const base = confirmedOrders.get(gid);
      if (base) itemsByGroup.value[gid] = [...base];
    }
  }

  // moveTo：把第 from 项插到第 to 位后整列提交（W3-3a 拖拽与这里的上移/下移共用）。
  async function moveTo(groupId: GroupId, from: number, to: number) {
    const list = itemsByGroup.value[groupId] ?? [];
    if (from === to || from < 0 || to < 0) return true;
    if (from >= list.length || to >= list.length) return false;
    const ids = list.map((v) => v.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    return applyOrder(groupId, ids);
  }

  async function moveUp(groupId: GroupId, index: number) {
    return moveTo(groupId, index, index - 1);
  }

  async function moveDown(groupId: GroupId, index: number) {
    return moveTo(groupId, index, index + 1);
  }

  return {
    groups,
    itemsByGroup,
    selectedGroupId,
    editing,
    errorText,
    pendingCommits,
    load,
    create,
    remove,
    addVideos,
    removeVideo,
    loadItems,
    setOrder,
    applyOrder,
    moveTo,
    moveUp,
    moveDown,
    cancelPending,
  };
});
