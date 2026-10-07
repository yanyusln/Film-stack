import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as cmd from "@/bridge/commands";
import { selectDirectory } from "@/bridge/dialog";
import { useDirPickerStore } from "./dirPicker";

vi.mock("@/bridge/commands", () => ({
  listDirs: vi.fn(),
}));

vi.mock("@/bridge/dialog", () => ({
  selectDirectory: vi.fn(),
}));

// 平台开关：这个文件要同时验移动端面板与桌面转发两条路
const platform = vi.hoisted(() => ({ isAndroid: true }));
vi.mock("@/platform", () => ({
  usePlatform: () => ({
    isAndroid: platform.isAndroid,
    needsAssetGrant: true,
    toAssetUrl: (p: string) => `asset://${p}`,
    enterPip: async () => false,
    lockOrientation: async () => false,
    setBrightness: () => {},
  }),
}));

/** 让 pick 里的异步 load 落地（它内部是 void 调用，没人 await）。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

const dir = (path: string, name: string) => ({ path, name });

beforeEach(() => {
  setActivePinia(createPinia());
  platform.isAndroid = true;
  vi.mocked(cmd.listDirs).mockReset();
  vi.mocked(selectDirectory).mockReset();
  vi.mocked(cmd.listDirs).mockResolvedValue([
    dir("/storage/emulated/0", "内部存储"),
  ]);
  vi.mocked(selectDirectory).mockResolvedValue("D:\\电影");
});

describe("移动端：目录浏览代替对话框", () => {
  it("pick 打开面板并载入存储根候选", async () => {
    const store = useDirPickerStore();
    void store.pick();
    await flush();
    expect(store.open).toBe(true);
    expect(cmd.listDirs).toHaveBeenCalledWith(null);
    expect(store.entries.map((e) => e.name)).toEqual(["内部存储"]);
    // 停在根候选层不能算选好了
    expect(store.canConfirm).toBe(false);
  });

  it("逐级下钻后可以回到上一层", async () => {
    const store = useDirPickerStore();
    void store.pick();
    await flush();

    vi.mocked(cmd.listDirs).mockResolvedValue([
      dir("/storage/emulated/0/Movies", "Movies"),
    ]);
    store.enter(dir("/storage/emulated/0", "内部存储"));
    await flush();
    expect(store.trail.map((c) => c.name)).toEqual(["存储", "内部存储"]);
    expect(store.canGoUp).toBe(true);
    expect(store.canConfirm).toBe(true);
    expect(store.currentPath).toBe("/storage/emulated/0");

    vi.mocked(cmd.listDirs).mockResolvedValue([
      dir("/storage/emulated/0/Movies", "Movies"),
    ]);
    store.up();
    await flush();
    expect(cmd.listDirs).toHaveBeenLastCalledWith(null);
    expect(store.canGoUp).toBe(false);
  });

  it("确认后兑现路径并把面板复位", async () => {
    const store = useDirPickerStore();
    const pending = store.pick();
    await flush();
    store.enter(dir("/storage/emulated/0", "内部存储"));
    await flush();

    store.confirmHere();
    expect(await pending).toBe("/storage/emulated/0");
    expect(store.open).toBe(false);
    expect(store.trail).toHaveLength(1);
    expect(store.entries).toEqual([]);
  });

  it("取消得到 null", async () => {
    const store = useDirPickerStore();
    const pending = store.pick();
    await flush();
    store.cancel();
    expect(await pending).toBeNull();
  });

  it("读不到目录要报错，不能伪装成空目录", async () => {
    // 移动端最常见的「读不到」就是没授予存储权限，
    // 空列表会把用户引向「这个目录是空的」，方向完全反了。
    vi.mocked(cmd.listDirs).mockRejectedValue(
      new Error("read_dir failed: permission denied"),
    );
    const store = useDirPickerStore();
    void store.pick();
    await flush();
    expect(store.entries).toEqual([]);
    expect(store.errorText).toContain("读不到这个目录");
    expect(store.errorText).toContain("permission denied");
  });

  it("连点时不会背着上一个等待者", async () => {
    const store = useDirPickerStore();
    const first = store.pick();
    await flush();
    const second = store.pick();
    // 上一次没兑现就再次打开：先把它结掉，避免两个 waiter 互相覆盖谁也不响
    expect(await first).toBeNull();
    await flush();
    store.confirmHere();
    expect(await second).toBeNull();
  });
});

describe("桌面端：仍然只走原生对话框", () => {
  it("pick 直接转发给 selectDirectory，面板不出现", async () => {
    platform.isAndroid = false;
    const store = useDirPickerStore();
    await expect(store.pick()).resolves.toBe("D:\\电影");
    expect(store.open).toBe(false);
    expect(cmd.listDirs).not.toHaveBeenCalled();
  });
});
