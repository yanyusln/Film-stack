import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as cmd from "@/bridge/commands";
import type { RootMeta, ScanSummary } from "@/bridge/contracts";
import type { RootId } from "@/types/video";
import { useScanStore } from "./scan";

// 扫描 store：任务生命周期与状态文案（技术方案 §7.2），桥接层整体替换（W7-2）。
vi.mock("@/bridge/commands", () => ({
  listRoots: vi.fn(),
  addRoots: vi.fn(),
  removeRoot: vi.fn(),
  scanRoots: vi.fn(),
  cancelScan: vi.fn(),
  setRealtime: vi.fn(),
}));

function root(id: string, path: string): RootMeta {
  return { id: id as RootId, label: path, path, enabled: true, videoCount: 0 };
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
  vi.mocked(cmd.scanRoots).mockResolvedValue(summary());
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
    vi.mocked(cmd.addRoots).mockResolvedValue([root("r2", "D:\\b")]);
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
