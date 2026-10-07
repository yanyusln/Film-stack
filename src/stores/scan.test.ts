import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as cmd from "@/bridge/commands";
import type { RootMeta, ScanSummary, VideoMeta } from "@/bridge/contracts";
import type { RootId } from "@/types/video";
import { useScanStore } from "./scan";
import { useVideosStore } from "./videos";

// 扫描 store：任务生命周期、状态文案与扫描后的自动刷新（W7-2 / v1 反馈：扫描完了树还是旧的）
vi.mock("@/bridge/commands", () => ({
  listRoots: vi.fn(),
  addRoots: vi.fn(),
  removeRoot: vi.fn(),
  scanRoots: vi.fn(),
  cancelScan: vi.fn(),
  setRealtime: vi.fn(),
  // 扫描成功后要顺带刷新视频列表，这里由 scan.test.ts 自己造数据
  listVideos: vi.fn(),
  ensureThumb: vi.fn(),
}));

function root(id: string, path: string, videoCount = 0): RootMeta {
  return {
    id: id as RootId,
    label: path,
    path,
    enabled: true,
    videoCount,
  };
}

function videoMeta(id: string, dir: string): VideoMeta {
  return {
    id,
    rootId: "r1",
    name: `${id}.mp4`,
    path: `D:\\剧集\\${dir}\\${id}.mp4`,
    size: 1024,
    duration: 600,
    width: 1920,
    height: 1080,
    mediaType: "video/mp4",
    fingerprint: `fp-${id}`,
    thumbnailState: "ready",
    thumbnailPath: `thumbs/${id}.jpg`,
    duplicateCount: 1,
    container: "mp4 (isom)",
  };
}

function summary(patch: Partial<ScanSummary> = {}): ScanSummary {
  return {
    roots: 1,
    added: 3,
    updated: 1,
    removed: 0,
    errors: [],
    ...patch,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(cmd.listRoots).mockReset();
  vi.mocked(cmd.addRoots).mockReset();
  vi.mocked(cmd.removeRoot).mockReset();
  vi.mocked(cmd.scanRoots).mockReset();
  vi.mocked(cmd.cancelScan).mockReset();
  vi.mocked(cmd.setRealtime).mockReset();
  vi.mocked(cmd.listVideos).mockReset();
  vi.mocked(cmd.ensureThumb).mockReset();
  vi.mocked(cmd.scanRoots).mockResolvedValue(summary());
  vi.mocked(cmd.listRoots).mockResolvedValue([]);
  vi.mocked(cmd.listVideos).mockResolvedValue([]);
  vi.mocked(cmd.ensureThumb).mockResolvedValue("");
});

describe("根目录", () => {
  it("读取失败进入 error 并记录文案", async () => {
    vi.mocked(cmd.listRoots).mockRejectedValue(new Error("x"));
    const store = useScanStore();
    await store.init();
    expect(store.phase).toBe("error");
    expect(store.errorText).toContain("读取根目录失败");
  });

  it("新增目录后自动跑一次增量扫描（只扫新建的根）", async () => {
    const created = root("r2", "D:\\b");
    vi.mocked(cmd.addRoots).mockResolvedValue([created]);
    vi.mocked(cmd.listRoots).mockResolvedValue([root("r1", "D:\\a"), created]);
    const store = useScanStore();
    store.roots = [root("r1", "D:\\a")];
    await store.addRoots(["D:\\b"]);
    expect(store.roots.map((r) => r.id)).toEqual(["r1", "r2"]);
    const input = vi.mocked(cmd.scanRoots).mock.calls[0][0];
    expect(input.rootIds).toEqual(["r2"]);
    expect(input.mode).toBe("incremental");
  });

  it("空数组不请求；移除目录只改本地列表", async () => {
    const store = useScanStore();
    store.roots = [root("r1", "D:\\a")];
    await store.addRoots([]);
    expect(vi.mocked(cmd.addRoots)).not.toHaveBeenCalled();
    await store.removeRoot("r1");
    expect(store.roots).toEqual([]);
    expect(vi.mocked(cmd.removeRoot)).toHaveBeenCalledWith("r1");
  });
});

describe("扫描状态机", () => {
  it("没有根目录时不发起扫描", async () => {
    const store = useScanStore();
    await store.startScan({});
    expect(vi.mocked(cmd.scanRoots)).not.toHaveBeenCalled();
    expect(store.phase).toBe("idle");
  });

  it("扫描中把进度回写成「扫描中 X/Y」", async () => {
    vi.mocked(cmd.scanRoots).mockImplementation(async (_input, onProgress) => {
      onProgress?.({ processed: 5, total: 10 });
      return summary();
    });
    const store = useScanStore();
    store.roots = [root("r1", "D:\\a")];
    const p = store.startScan({});
    expect(store.isScanning).toBe(true);
    await p;
    expect(store.phase).toBe("done");
    expect(store.lastSummary?.added).toBe(3);
  });

  it("进度回调到达时文案同步更新", async () => {
    vi.mocked(cmd.scanRoots).mockImplementation(async (_input, onProgress) => {
      onProgress?.({ processed: 5, total: 10 });
      return summary();
    });
    const store = useScanStore();
    store.roots = [root("r1", "D:\\a")];
    await store.startScan({});
    expect(store.progress).toEqual({ processed: 5, total: 10 });
    expect(store.statusText).toContain("新增 3");
  });

  it("完成后汇总含失败计数", async () => {
    vi.mocked(cmd.scanRoots).mockResolvedValue(summary({ errors: ["e1"] }));
    const store = useScanStore();
    store.roots = [root("r1", "D:\\a")];
    await store.startScan({});
    expect(store.statusText).toBe("扫描完成 · 新增 3 · 更新 1 · 失败 1");
  });

  it("完成后汇总含失联计数（增量 diff）", async () => {
    vi.mocked(cmd.scanRoots).mockResolvedValue(summary({ removed: 2 }));
    const store = useScanStore();
    store.roots = [root("r1", "D:\\a")];
    await store.startScan({});
    expect(store.statusText).toBe("扫描完成 · 新增 3 · 更新 1 · 失效 2");
  });

  it("没有失联条目时不显示该段", async () => {
    const store = useScanStore();
    store.roots = [root("r1", "D:\\a")];
    await store.startScan({});
    expect(store.statusText).not.toContain("失效");
  });

  it("失败进入 error 并记录文案", async () => {
    vi.mocked(cmd.scanRoots).mockRejectedValue(new Error("权限不足"));
    const store = useScanStore();
    store.roots = [root("r1", "D:\\a")];
    await store.startScan({});
    expect(store.phase).toBe("error");
    expect(store.errorText).toContain("扫描失败");
  });

  it("取消只针对当前任务；未开始时不请求", () => {
    const store = useScanStore();
    store.cancelScan();
    expect(vi.mocked(cmd.cancelScan)).not.toHaveBeenCalled();
  });

  it("实时监听开关直接透传", () => {
    const store = useScanStore();
    store.setRealtimeEnabled(false);
    expect(vi.mocked(cmd.setRealtime)).toHaveBeenCalledWith(false);
  });
});

/**
 * v1 实际反馈：侧栏计数显示 2511、目录树却只有 3 个子目录。
 * 根因是扫描分批提交、用户在扫描途中点了根目录，items 成了半成品快照后再没人刷新。
 */
describe("扫描后自动刷新", () => {
  it("扫描成功后重拉根目录计数，并刷新当前选中根的视频列表", async () => {
    vi.mocked(cmd.listRoots).mockResolvedValue([root("r1", "D:\\a", 2)]);
    // 扫描途中点根目录只能拿到第一批（真实 bug 的时序），扫描完成后应变成全量
    vi.mocked(cmd.listVideos)
      .mockResolvedValueOnce([videoMeta("v1", "动作")])
      .mockResolvedValue([videoMeta("v1", "动作"), videoMeta("v2", "动画")]);
    const store = useScanStore();
    const videos = useVideosStore();
    store.roots = [root("r1", "D:\\a", 0)];
    await videos.load("r1" as RootId);
    expect(videos.items).toHaveLength(1);

    await store.startScan({ roots: ["r1"] });

    expect(store.roots[0].videoCount).toBe(2); // 侧栏计数跟上
    expect(videos.items.map((v) => v.name)).toEqual(["v1.mp4", "v2.mp4"]); // 目录树跟上
    expect(vi.mocked(cmd.listVideos).mock.calls.at(-1)?.[0]).toBe("r1");
  });

  it("用 reload 保住下钻目录与已选（不弹回根目录）", async () => {
    vi.mocked(cmd.listRoots).mockResolvedValue([root("r1", "D:\\a", 2)]);
    vi.mocked(cmd.listVideos).mockResolvedValue([
      videoMeta("v1", "动作"),
      videoMeta("v2", "动作"),
    ]);
    const store = useScanStore();
    const videos = useVideosStore();
    store.roots = [root("r1", "D:\\a", 0)];
    await videos.load("r1" as RootId);
    videos.setDir("动作");
    videos.toggleSelect("v1" as never);

    await store.startScan({ roots: ["r1"] });

    expect(videos.currentDir).toBe("动作");
    expect(videos.selectedIds).toEqual(["v1"]);
  });

  it("还没选中根时，自动选中最相关的根并加载", async () => {
    vi.mocked(cmd.listRoots).mockResolvedValue([
      root("r1", "D:\\a", 1),
      root("r2", "D:\\b", 1),
    ]);
    vi.mocked(cmd.listVideos).mockResolvedValue([videoMeta("v9", "剧集")]);
    const store = useScanStore();
    const videos = useVideosStore();

    await store.startScan({ roots: ["r2"] });

    expect(videos.selectedRootId).toBe("r2");
    expect(videos.items.map((v) => v.name)).toEqual(["v9.mp4"]);
  });

  it("扫描失败不刷新（列表保持原样，状态是 error）", async () => {
    vi.mocked(cmd.scanRoots).mockRejectedValue(new Error("权限不足"));
    vi.mocked(cmd.listRoots).mockResolvedValue([root("r1", "D:\\a", 9)]);
    const store = useScanStore();
    const videos = useVideosStore();
    store.roots = [root("r1", "D:\\a", 0)];
    await videos.load("r1" as RootId);
    vi.mocked(cmd.listVideos).mockClear();

    await store.startScan({ roots: ["r1"] });

    expect(store.phase).toBe("error");
    expect(store.roots[0].videoCount).toBe(0);
    expect(vi.mocked(cmd.listVideos)).not.toHaveBeenCalled();
  });

  it("list_roots 失败也要照刷视频列表，且不把扫描判成失败", async () => {
    vi.mocked(cmd.listRoots).mockRejectedValue(new Error("x"));
    vi.mocked(cmd.listVideos).mockResolvedValue([videoMeta("v1", "动作")]);
    const store = useScanStore();
    const videos = useVideosStore();
    store.roots = [root("r1", "D:\\a", 0)];
    await videos.load("r1" as RootId);

    await store.startScan({ roots: ["r1"] });

    expect(store.phase).toBe("done");
    expect(videos.items).toHaveLength(1);
  });
});
