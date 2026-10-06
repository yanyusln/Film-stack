import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as cmd from "@/bridge/commands";
import type { GroupMeta, VideoMeta } from "@/bridge/contracts";
import type { GroupId } from "@/types/video";
import { useGroupsStore } from "./groups";
import { useUiStore } from "./ui";

// 分组 store 的乐观重排 / 回滚 / 多归属都在前端，桥接层整体替换（W7-2）。
vi.mock("@/bridge/commands", () => ({
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  removeGroup: vi.fn(),
  addToGroup: vi.fn(),
  removeFromGroup: vi.fn(),
  listGroupItems: vi.fn(),
  setGroupOrder: vi.fn(),
  setSortOrder: vi.fn(),
}));

const GID = "gp_1" as GroupId;
const GID2 = "gp_2" as GroupId;

function group(id: string, name: string): GroupMeta {
  return { id, name, parentId: null, sortOrder: 1000 };
}

function item(id: string, name: string): VideoMeta {
  return {
    id,
    rootId: "r1",
    name,
    path: `D:\\v\\${name}`,
    size: 1,
    duration: null,
    width: null,
    height: null,
    mediaType: null,
    fingerprint: null,
    thumbnailState: "pending",
    thumbnailPath: null,
    duplicateCount: 1,
    container: null,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  // ui store 的 toast 走 window.setTimeout：node 环境没有 window，补最小桩
  vi.stubGlobal("window", { setTimeout });
  vi.mocked(cmd.listGroups).mockReset();
  vi.mocked(cmd.createGroup).mockReset();
  vi.mocked(cmd.removeGroup).mockReset();
  vi.mocked(cmd.addToGroup).mockReset();
  vi.mocked(cmd.removeFromGroup).mockReset();
  vi.mocked(cmd.listGroupItems).mockReset();
  vi.mocked(cmd.setGroupOrder).mockReset();
  vi.mocked(cmd.setSortOrder).mockReset();
  vi.mocked(cmd.addToGroup).mockResolvedValue(1);
  vi.mocked(cmd.setSortOrder).mockResolvedValue({
    groupId: GID,
    written: 2,
    rebuilt: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("分组读写", () => {
  it("读取失败记录文案，不抛错", async () => {
    vi.mocked(cmd.listGroups).mockRejectedValue(new Error("boom"));
    const store = useGroupsStore();
    await store.load();
    expect(store.errorText).toContain("读取分组失败");
    expect(store.groups).toEqual([]);
  });

  it("空名不创建；成功后追加到末尾", async () => {
    vi.mocked(cmd.createGroup).mockResolvedValue(group("gp_9", "新分组"));
    const store = useGroupsStore();
    store.groups = [group("gp_1", "已有")];
    await store.create("   ");
    expect(vi.mocked(cmd.createGroup)).not.toHaveBeenCalled();
    await store.create("  新分组  ");
    expect(vi.mocked(cmd.createGroup)).toHaveBeenCalledWith("新分组");
    expect(store.groups.map((g) => g.name)).toEqual(["已有", "新分组"]);
  });

  it("删除分组清空该组引用并取消选中", async () => {
    const store = useGroupsStore();
    store.groups = [group(GID, "A"), group(GID2, "B")];
    store.selectedGroupId = GID;
    await store.remove(GID);
    expect(store.groups.map((g) => g.id)).toEqual([GID2]);
    expect(store.itemsByGroup[GID]).toBeUndefined();
    expect(store.selectedGroupId).toBeNull();
  });

  it("加入分组后重新拉取成员；空数组不请求", async () => {
    vi.mocked(cmd.listGroupItems).mockResolvedValue([item("v1", "a.mp4")]);
    const store = useGroupsStore();
    await store.addVideos(GID, []);
    expect(vi.mocked(cmd.addToGroup)).not.toHaveBeenCalled();
    await store.addVideos(GID, ["v1"]);
    expect(vi.mocked(cmd.addToGroup)).toHaveBeenCalledWith(GID, ["v1"]);
    expect(store.itemsByGroup[GID]).toHaveLength(1);
    expect(store.selectedGroupId).toBe(GID);
  });

  it("移出分组只删引用（C1：不动视频记录）", async () => {
    const store = useGroupsStore();
    store.itemsByGroup[GID] = [item("v1", "a.mp4"), item("v2", "b.mp4")];
    await store.removeVideo(GID, "v1");
    expect(vi.mocked(cmd.removeFromGroup)).toHaveBeenCalledWith(GID, "v1");
    expect(store.itemsByGroup[GID].map((v) => v.id)).toEqual(["v2"]);
  });
});

describe("applyOrder 乐观重排与回滚", () => {
  async function storeWithItems() {
    vi.mocked(cmd.listGroupItems).mockResolvedValue([
      item("v1", "a.mp4"),
      item("v2", "b.mp4"),
      item("v3", "c.mp4"),
    ]);
    const store = useGroupsStore();
    await store.loadItems(GID);
    return store;
  }

  it("成功：内存先重排，提交的是新顺序", async () => {
    const store = await storeWithItems();
    const ok = await store.applyOrder(GID, ["v3", "v1", "v2"]);
    expect(ok).toBe(true);
    expect(store.itemsByGroup[GID].map((v) => v.id)).toEqual([
      "v3",
      "v1",
      "v2",
    ]);
    expect(vi.mocked(cmd.setSortOrder)).toHaveBeenCalledWith(GID, [
      "v3",
      "v1",
      "v2",
    ]);
    expect(store.errorText).toBe("");
  });

  it("失败：回滚内存顺序 + toast，返回 false", async () => {
    const store = await storeWithItems();
    vi.mocked(cmd.setSortOrder).mockRejectedValue(new Error("事务回滚"));
    const ok = await store.applyOrder(GID, ["v3", "v1", "v2"]);
    expect(ok).toBe(false);
    expect(store.itemsByGroup[GID].map((v) => v.id)).toEqual([
      "v1",
      "v2",
      "v3",
    ]);
    expect(store.errorText).toContain("保存排序失败");
    expect(useUiStore().toasts.at(-1)?.text).toContain("已恢复原顺序");
  });

  it("id 集合与成员不一致时不提交", async () => {
    const store = await storeWithItems();
    const ok = await store.applyOrder(GID, ["v1", "v2", "zzz"]);
    expect(ok).toBe(false);
    expect(vi.mocked(cmd.setSortOrder)).not.toHaveBeenCalled();
    expect(store.errorText).toContain("不一致");
    expect(store.itemsByGroup[GID].map((v) => v.id)).toEqual([
      "v1",
      "v2",
      "v3",
    ]);
  });
});

describe("重排与取消", () => {
  async function storeWithItems() {
    vi.mocked(cmd.listGroupItems).mockResolvedValue([
      item("v1", "a.mp4"),
      item("v2", "b.mp4"),
      item("v3", "c.mp4"),
    ]);
    const store = useGroupsStore();
    await store.loadItems(GID);
    return store;
  }

  it("moveDown / moveUp 走同一套整列提交", async () => {
    const store = await storeWithItems();
    expect(await store.moveDown(GID, 0)).toBe(true);
    expect(vi.mocked(cmd.setSortOrder).mock.calls[0][1]).toEqual([
      "v2",
      "v1",
      "v3",
    ]);
  });

  it("越界与原地不动都不提交", async () => {
    const store = await storeWithItems();
    expect(await store.moveTo(GID, 0, 0)).toBe(true);
    expect(await store.moveUp(GID, 0)).toBe(true);
    expect(await store.moveTo(GID, 0, 9)).toBe(false);
    expect(await store.moveTo(GID, -1, 1)).toBe(true);
    expect(vi.mocked(cmd.setSortOrder)).not.toHaveBeenCalled();
  });

  it("cancelPending 丢弃尚未确认的顺序改动", async () => {
    const store = await storeWithItems();
    vi.mocked(cmd.setSortOrder).mockRejectedValue(new Error("x"));
    await store.applyOrder(GID, ["v3", "v2", "v1"]); // 失败回滚
    store.itemsByGroup[GID] = [
      item("v3", "c.mp4"),
      item("v2", "b.mp4"),
      item("v1", "a.mp4"),
    ];
    store.cancelPending(GID);
    expect(store.itemsByGroup[GID].map((v) => v.id)).toEqual([
      "v1",
      "v2",
      "v3",
    ]);
  });
});
