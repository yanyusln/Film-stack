import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as cmd from "@/bridge/commands";
import type { VideoMeta } from "@/bridge/contracts";
import type { RootId, VideoId } from "@/types/video";
import { useVideosStore } from "./videos";

// store 不直接碰 Tauri：桥接层整体替换，只验证取数、自然序与缩略图状态机（W7-2）。
vi.mock("@/bridge/commands", () => ({
  listVideos: vi.fn(),
  ensureThumb: vi.fn(),
}));

const ROOT = "r1" as RootId;

function meta(
  id: string,
  name: string,
  patch: Partial<VideoMeta> = {},
): VideoMeta {
  return {
    id,
    rootId: ROOT,
    name,
    path: `D:\\v\\${name}`,
    size: 1024,
    duration: null,
    width: null,
    height: null,
    mediaType: null,
    fingerprint: null,
    thumbnailState: "pending",
    thumbnailPath: null,
    duplicateCount: 1,
    container: null,
    ...patch,
  };
}

/** seedThumbs 里的请求是 fire-and-forget，等一拍再看结果 */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(cmd.listVideos).mockReset();
  vi.mocked(cmd.ensureThumb).mockReset();
  vi.mocked(cmd.ensureThumb).mockResolvedValue("D:\\thumbs\\x.jpg");
});

describe("useVideosStore.load", () => {
  it("按文件名自然序排列，ep2 排在 ep10 之前", async () => {
    // 后端是 SQLite 的 ORDER BY name（字节序），自然序由前端统一（F19 / 技术方案 §8.6）
    vi.mocked(cmd.listVideos).mockResolvedValue([
      meta("v1", "ep10.mp4"),
      meta("v2", "ep2.mp4"),
      meta("v3", "ep1.mp4"),
    ]);
    const store = useVideosStore();
    await store.load(ROOT);
    expect(store.items.map((v) => v.name)).toEqual([
      "ep1.mp4",
      "ep2.mp4",
      "ep10.mp4",
    ]);
    expect(store.selectedRootId).toBe(ROOT);
    expect(store.loading).toBe(false);
  });

  it("失败时保留上一次列表，只记录错误文案", async () => {
    vi.mocked(cmd.listVideos).mockResolvedValueOnce([meta("v1", "a.mp4")]);
    const store = useVideosStore();
    await store.load(ROOT);
    vi.mocked(cmd.listVideos).mockRejectedValueOnce(new Error("db locked"));
    await store.load(ROOT);
    expect(store.errorText).toContain("加载视频失败");
    expect(store.items.map((v) => v.name)).toEqual(["a.mp4"]);
    expect(store.loading).toBe(false);
  });
});

describe("useVideosStore 缩略图", () => {
  it("后端已就绪的直接复用路径，不再请求", async () => {
    vi.mocked(cmd.listVideos).mockResolvedValue([
      meta("v1", "a.mp4", {
        thumbnailState: "ready",
        thumbnailPath: "D:\\thumbs\\a.jpg",
      }),
      meta("v2", "b.mp4"),
    ]);
    const store = useVideosStore();
    await store.load(ROOT);
    await settle();
    expect(store.thumbState["v1"]).toBe("ready");
    expect(store.thumbPath["v1"]).toBe("D:\\thumbs\\a.jpg");
    expect(vi.mocked(cmd.ensureThumb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cmd.ensureThumb).mock.calls[0][0]).toBe("v2");
  });

  it("首屏最多预热 24 项，避免一次灌入海量抽帧任务", async () => {
    const list = Array.from({ length: 30 }, (_, i) =>
      meta(`v${i}`, `${String(i).padStart(2, "0")}.mp4`),
    );
    vi.mocked(cmd.listVideos).mockResolvedValue(list);
    const store = useVideosStore();
    await store.load(ROOT);
    await settle();
    expect(vi.mocked(cmd.ensureThumb)).toHaveBeenCalledTimes(24);
  });

  it("抽帧失败降级为 failed，不打断列表", async () => {
    vi.mocked(cmd.listVideos).mockResolvedValue([meta("v1", "a.mp4")]);
    vi.mocked(cmd.ensureThumb).mockRejectedValue(new Error("ffmpeg 缺失"));
    const store = useVideosStore();
    await store.load(ROOT);
    await settle();
    expect(store.thumbState["v1"]).toBe("failed");
    expect(store.items).toHaveLength(1);
    expect(store.errorText).toBe("");
  });

  it("已 ready 的不会重复请求", async () => {
    vi.mocked(cmd.listVideos).mockResolvedValue([meta("v1", "a.mp4")]);
    const store = useVideosStore();
    await store.load(ROOT);
    await settle();
    await store.requestThumb("v1" as VideoId);
    expect(vi.mocked(cmd.ensureThumb)).toHaveBeenCalledTimes(1);
  });
});
