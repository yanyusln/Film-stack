import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as cmd from "@/bridge/commands";
import type { RemuxResult } from "@/bridge/contracts";
import { usePlayerStore } from "./player";
import { useUiStore } from "./ui";

// 播放 store 只做会话状态与落库决策：桥接层整体替换，媒体元素用最小替身（W7-2）。
vi.mock("@/bridge/commands", () => ({
  getProgress: vi.fn(),
  saveProgress: vi.fn(),
  clearProgress: vi.fn(),
  grantAssetRoot: vi.fn(),
  probeVideo: vi.fn(),
  remuxToCache: vi.fn(),
}));

// convertFileSrc 走 navigator/UA 判定，node 环境直接给确定性结果
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: vi.fn(),
  Channel: class {},
}));

/** 只实现 store 会碰到的字段，避免引入 DOM */
function fakeEl(currentTime = 0, duration = 600) {
  return {
    currentTime,
    duration,
    paused: true,
    playbackRate: 1,
    volume: 1,
    muted: false,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  } as unknown as HTMLVideoElement;
}

/** id 按入参下标生成：v0 是第一个名字（未排序） */
function list(...names: string[]) {
  return names.map((name, i) => ({
    id: `v${i}`,
    name,
    path: `D:\\v\\${name}`,
    duration: 600,
  }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(cmd.getProgress).mockReset();
  vi.mocked(cmd.saveProgress).mockReset();
  vi.mocked(cmd.clearProgress).mockReset();
  vi.mocked(cmd.grantAssetRoot).mockReset();
  vi.mocked(cmd.probeVideo).mockReset();
  vi.mocked(cmd.remuxToCache).mockReset();
  vi.mocked(cmd.remuxToCache).mockResolvedValue({
    status: "skipped",
    path: null,
    reason: null,
  });
  vi.mocked(cmd.getProgress).mockResolvedValue(null);
  vi.mocked(cmd.saveProgress).mockResolvedValue(true);
  vi.mocked(cmd.clearProgress).mockResolvedValue(undefined);
  vi.mocked(cmd.grantAssetRoot).mockResolvedValue({
    path: "D:\\v",
    kind: "video",
    mode: "dir_recursive",
    applied: true,
    reason: "granted",
  });
});

describe("播放列表顺序", () => {
  it("文件夹序按文件名自然序：ep2 在 ep10 之前", async () => {
    const store = usePlayerStore();
    // 入参顺序是 ep10 / ep2 / ep1，点开的是 ep2（v1）：重排后仍要落在同一个视频上
    await store.openPlaylist(
      list("ep10.mp4", "ep2.mp4", "ep1.mp4"),
      "folder",
      "剧集",
      "v1",
    );
    expect(store.playlist.map((v) => v.name)).toEqual([
      "ep1.mp4",
      "ep2.mp4",
      "ep10.mp4",
    ]);
    expect(store.current?.name).toBe("ep2.mp4");
    expect(store.src).toBe("asset://D:\\v\\ep2.mp4");
  });

  it("分组序保持后端 sort_order，不做前端重排", async () => {
    const store = usePlayerStore();
    await store.openPlaylist(list("b.mp4", "a.mp4"), "group", "收藏", "v0");
    expect(store.playlist.map((v) => v.name)).toEqual(["b.mp4", "a.mp4"]);
    expect(store.sourceKind).toBe("group");
  });

  it("startId 找不到时退到第一项；空列表无当前项", async () => {
    const store = usePlayerStore();
    await store.openPlaylist(list("a.mp4"), "folder", "x", "不存在");
    expect(store.index).toBe(0);
    await store.openPlaylist([], "folder", "x", "");
    expect(store.index).toBe(-1);
    expect(store.current).toBeNull();
    expect(store.src).toBeNull();
  });
});

describe("播放源授权（asset 协议）", () => {
  function granted(p: string, applied: boolean, reason: string) {
    return {
      path: p,
      kind: null,
      mode: null,
      applied,
      reason,
    };
  }

  it("开播前先放行所在目录（不是文件），拿到结果再切源", async () => {
    const store = usePlayerStore();
    const calls: string[] = [];
    vi.mocked(cmd.grantAssetRoot).mockImplementation(async (p: string) => {
      calls.push(p);
      return granted(p, true, "granted");
    });
    await store.openPlaylist(
      list("ep10.mp4", "ep2.mp4"),
      "folder",
      "剧集",
      "v1",
    );
    expect(calls).toEqual(["D:\\v"]);
    expect(store.assetGrant?.applied).toBe(true);
  });

  it("目录没放行成功就退一步只放行这一个文件", async () => {
    const store = usePlayerStore();
    const calls: string[] = [];
    vi.mocked(cmd.grantAssetRoot).mockImplementation(async (p: string) => {
      calls.push(p);
      return granted(p, false, "kind_not_allowed");
    });
    await store.openPlaylist(list("a.mp4"), "folder", "x", "v0");
    expect(calls).toEqual(["D:\\v", "D:\\v\\a.mp4"]);
    expect(store.assetGrant?.reason).toBe("kind_not_allowed");
  });

  it("自检读文件头拿编码，切源时清空上一次结果", async () => {
    const store = usePlayerStore();
    await store.openPlaylist(list("a.mp4"), "folder", "x", "v0");
    expect(store.probeResult).toBeNull();
    vi.mocked(cmd.probeVideo).mockResolvedValue({
      path: "D:\\v\\a.mp4",
      exists: true,
      size: 10,
      container: "mp4 (isom)",
      videoCodec: "hevc (h.265)",
      audioCodec: "aac",
      videoSupported: false,
      unsupportedHint: "不在白名单内",
      containerHint: null,
      suggestCommand: null,
      note: null,
    });
    await store.diagnose();
    expect(vi.mocked(cmd.probeVideo)).toHaveBeenCalledWith("D:\\v\\a.mp4");
    expect(store.probeResult?.videoCodec).toBe("hevc (h.265)");
    await store.openIndex(0);
    expect(store.probeResult).toBeNull();
  });
});

describe("转封装：容器放不了但编码救得回", () => {
  const avi = () => [{ ...list("a.mp4")[0], container: "avi" }];
  const cached = (status: string, path: string | null) =>
    ({
      status,
      path,
      reason: path ? null : "ffmpeg_missing",
    }) as unknown as Awaited<ReturnType<typeof cmd.remuxToCache>>;

  it("容器已知放不了：进页面就转，播缓存里的那份", async () => {
    const store = usePlayerStore();
    vi.mocked(cmd.remuxToCache).mockResolvedValue(
      cached("remuxed", "C:\\cache\\abc.mp4"),
    );
    await store.openPlaylist(avi(), "folder", "x", "v0");
    expect(vi.mocked(cmd.remuxToCache)).toHaveBeenCalledWith(
      "D:\\v\\a.mp4",
      expect.any(Function), // 第二个参数是进度回调（Channel 封装）
    );
    expect(store.remuxState).toBe("ready");
    expect(store.src).toBe("asset://C:\\cache\\abc.mp4");
  });

  it("已知放不了：点击当刻就进准备态、不下发 src（不等授权/转封装）", () => {
    const store = usePlayerStore();
    vi.mocked(cmd.remuxToCache).mockReturnValue(
      new Promise<RemuxResult>(() => undefined),
    );
    // 不 await：调用返回的同一 tick 里界面就必须能显示「准备中」，
    // 否则点击后首页一动不动（真机反馈的「停顿」）
    void store.openPlaylist(avi(), "folder", "x", "v0");
    expect(store.remuxState).toBe("preparing");
    expect(store.src).toBeNull();
    expect(store.current?.id).toBe("v0");
  });

  it("转封装进行中不下发 src（不能先闪一次失败再突然能播）", async () => {
    const store = usePlayerStore();
    let release = () => {};
    vi.mocked(cmd.remuxToCache).mockImplementation(
      () =>
        new Promise<RemuxResult>((resolve) => {
          release = () => resolve(cached("remuxed", "C:\\cache\\abc.mp4"));
        }),
    );
    const opened = store.openPlaylist(avi(), "folder", "x", "v0");
    // 等到 remux 挂起（清空微任务队列）
    await new Promise((r) => setTimeout(r, 0));
    expect(store.remuxState).toBe("working");
    expect(store.src).toBeNull();
    release();
    await opened;
    expect(store.src).toBe("asset://C:\\cache\\abc.mp4");
  });

  it("进度能到界面上，转好后收起", async () => {
    const store = usePlayerStore();
    let emit: (p: {
      done: number;
      total: number;
      pct: number;
    }) => void = () => {};
    let release = () => {};
    vi.mocked(cmd.remuxToCache).mockImplementation((_path, onProgress) => {
      emit = (onProgress ?? (() => {})) as typeof emit;
      return new Promise<RemuxResult>((resolve) => {
        release = () => resolve(cached("remuxed", "C:\\cache\\abc.mp4"));
      });
    });
    const opened = store.openPlaylist(avi(), "folder", "x", "v0");
    await new Promise((r) => setTimeout(r, 0));
    // 进行中收到进度：几十秒的等待必须有数字在动
    emit({ done: 200, total: 1000, pct: 20 });
    expect(store.remuxProgress).toEqual({ done: 200, total: 1000, pct: 20 });
    release();
    await opened;
    expect(store.remuxProgress).toBeNull();
  });

  it("本来能播的文件不该惊动 ffmpeg", async () => {
    const store = usePlayerStore();
    await store.openPlaylist(
      [{ ...list("a.mp4")[0], container: "mp4 (isom)" }],
      "folder",
      "x",
      "v0",
    );
    expect(vi.mocked(cmd.remuxToCache)).not.toHaveBeenCalled();
    // 也不该进准备态：普通文件保持「点了就播」，不白闪一层遮罩
    expect(store.remuxState).toBe("idle");
    expect(store.src).toBe("asset://D:\\v\\a.mp4");
  });

  it("连点两张放不了的卡片：后点的作数，前一条链不重复转", async () => {
    const store = usePlayerStore();
    const releases: Array<() => void> = [];
    vi.mocked(cmd.remuxToCache).mockImplementation(
      () =>
        new Promise<RemuxResult>((resolve) => {
          releases.push(() => resolve(cached("remuxed", "C:\\cache\\x.mp4")));
        }),
    );
    // 注意 id 要真的不同：list() 每次调用都从 v0 开始编号
    const two = [
      { ...list("a.mp4")[0], container: "avi" },
      { ...list("b.mp4")[0], id: "v1", container: "avi" },
    ];
    const first = store.openPlaylist(two, "folder", "x", "v0");
    const second = store.openPlaylist(two, "folder", "x", "v1");
    await new Promise((r) => setTimeout(r, 0));
    // 前一条链已被取代：只应发出一次转封装（不能两个文件同时转、互相覆盖状态）
    expect(releases).toHaveLength(1);
    releases[0]?.();
    await Promise.all([first, second]);
    expect(store.current?.id).toBe("v1");
  });

  it("转失败就退回原路径，不假装能播（并说出原因）", async () => {
    const store = usePlayerStore();
    vi.mocked(cmd.remuxToCache).mockResolvedValue(cached("error", null));
    await store.openPlaylist(avi(), "folder", "x", "v0");
    expect(store.remuxState).toBe("failed");
    expect(store.src).toBe("asset://D:\\v\\a.mp4");
    // 原因码必须往上传：真机曾出现「秒失败但界面什么都不说」，只能翻缓存目录反推
    expect(store.remuxReason).toBe("ffmpeg_missing");
  });

  it("invoke 抛错要与 Rust 报错区分开", async () => {
    const store = usePlayerStore();
    // 命令没注册 / 参数序列化失败：桥接层 reject，不是 Rust 返回的 error
    vi.mocked(cmd.remuxToCache).mockRejectedValue(
      new Error("command not found"),
    );
    await store.openPlaylist(avi(), "folder", "x", "v0");
    expect(store.remuxState).toBe("failed");
    expect(store.remuxReason).toBe("invoke_failed");
    expect(store.src).toBe("asset://D:\\v\\a.mp4");
  });

  it("老数据没容器：自检说救得回也补一次（不预转、不猜）", async () => {
    const store = usePlayerStore();
    await store.openPlaylist(list("a.mp4"), "folder", "x", "v0");
    expect(vi.mocked(cmd.remuxToCache)).not.toHaveBeenCalled();

    vi.mocked(cmd.probeVideo).mockResolvedValue({
      path: "D:\\v\\a.mp4",
      exists: true,
      size: 10,
      container: "avi",
      videoCodec: "h264",
      audioCodec: "mp3",
      videoSupported: true,
      unsupportedHint: null,
      containerHint: "avi 不在接受类型内",
      suggestCommand: 'ffmpeg -i "a" -c copy "a_remux.mp4"',
      note: null,
    });
    vi.mocked(cmd.remuxToCache).mockResolvedValue(
      cached("remuxed", "C:\\cache\\late.mp4"),
    );
    await store.diagnose();
    await store.prepareSource();
    expect(vi.mocked(cmd.remuxToCache)).toHaveBeenCalledTimes(1);
    expect(store.src).toBe("asset://C:\\cache\\late.mp4");
  });
});

describe("进度落库", () => {
  it("末尾 30s 不写库（C5）", async () => {
    const store = usePlayerStore();
    store.attach(fakeEl(580, 600));
    await store.openPlaylist(list("a.mp4"), "folder", "x", "v0");
    store.onMeta(600);
    store.onTimeUpdate(580);
    expect(vi.mocked(cmd.saveProgress)).not.toHaveBeenCalled();
  });

  it("拖动/离开等即时写入会跳过节流但保留末尾判定", async () => {
    const store = usePlayerStore();
    const el = fakeEl(0, 600);
    store.attach(el);
    await store.openPlaylist(list("a.mp4"), "folder", "x", "v0");
    store.onMeta(600);
    store.seekTo(120);
    expect(el.currentTime).toBe(120);
    expect(vi.mocked(cmd.saveProgress)).toHaveBeenCalledWith("v0", 120, 600);
  });

  it("关闭时兜住最后一次位置", async () => {
    const store = usePlayerStore();
    store.attach(fakeEl(0, 600));
    await store.openPlaylist(list("a.mp4"), "folder", "x", "v0");
    store.onMeta(600);
    store.onTimeUpdate(42);
    await store.close();
    expect(vi.mocked(cmd.saveProgress)).toHaveBeenCalledWith("v0", 42, 600);
    expect(store.playing).toBe(false);
  });
});

describe("结束策略", () => {
  it("单曲循环恒重播，不进下一曲", async () => {
    const store = usePlayerStore();
    const el = fakeEl(0, 600);
    store.attach(el);
    await store.openPlaylist(list("a.mp4", "b.mp4"), "folder", "x", "v0");
    store.setLoopMode("single");
    await store.onEnded();
    expect(store.index).toBe(0);
    expect(el.currentTime).toBe(0);
    expect(el.play).toHaveBeenCalled();
    expect(vi.mocked(cmd.clearProgress)).not.toHaveBeenCalled();
  });

  it("开关关闭：播完停在当前时间并落库", async () => {
    const store = usePlayerStore();
    store.attach(fakeEl(0, 600));
    await store.openPlaylist(list("a.mp4", "b.mp4"), "folder", "x", "v0");
    useUiStore().setAutoAdvance(false);
    store.onMeta(600);
    store.onTimeUpdate(100);
    await store.onEnded();
    expect(store.index).toBe(0);
    expect(store.playing).toBe(false);
    expect(vi.mocked(cmd.saveProgress)).toHaveBeenCalledWith("v0", 100, 600);
  });

  it("开关开启：清掉看完的记录再进下一曲", async () => {
    const store = usePlayerStore();
    store.attach(fakeEl(0, 600));
    await store.openPlaylist(list("a.mp4", "b.mp4"), "folder", "x", "v0");
    useUiStore().setAutoAdvance(true);
    await store.onEnded();
    expect(store.index).toBe(1);
    expect(vi.mocked(cmd.clearProgress)).toHaveBeenCalledWith("v0");
  });
});

describe("续播", () => {
  it("本次不再询问只影响当前视频", async () => {
    const store = usePlayerStore();
    vi.mocked(cmd.getProgress).mockResolvedValue({
      videoId: "v0",
      position: 60,
      duration: 600,
      updatedAt: 0,
    });
    await store.openPlaylist(list("a.mp4", "b.mp4"), "folder", "x", "v0");
    expect(store.resumeDecision().action).toBe("ask");
    store.markSkipOnce();
    expect(store.resumeDecision().skip).toBe(true);
    expect(store.resumeDecision().action).toBe("resume");
  });

  it("没有历史记录时直接开播", async () => {
    const store = usePlayerStore();
    await store.openPlaylist(list("a.mp4"), "folder", "x", "v0");
    expect(store.resumeDecision()).toEqual({ action: "play", skip: false });
  });

  it("读进度失败不阻塞播放", async () => {
    const store = usePlayerStore();
    vi.mocked(cmd.getProgress).mockRejectedValue(new Error("x"));
    await store.openPlaylist(list("a.mp4"), "folder", "x", "v0");
    expect(store.progress).toBeNull();
    expect(store.resumeDecision().action).toBe("play");
  });
});
