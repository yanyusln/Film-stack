// E2E 打桩：真机 Tauri 二进制不在本轮范围内（需要构建产物 + WebView2 真机），
// 这里只把 IPC 层换成可控假实现；前端路由、store、组件全部跑真代码。
//
// 两条不打桩的边界：
// ① 命令没在下面表里登记就直接 reject，避免测试悄悄跑到未打桩的后端；
// ② convertFileSrc 返回空串——asset:// 不是浏览器协议，媒体解码不在 E2E 范围内，
//    播放页的时长/续播靠 dispatchEvent("loadedmetadata") 驱动（见 player.spec.ts）。
import type { Page } from "@playwright/test";

export interface E2ERoot {
  id: string;
  label: string;
  path: string;
  enabled: boolean;
  /** 侧栏目录树显示「剧集 (3)」；缺省时前端按 0 兜底 */
  videoCount?: number;
}

export interface E2EVideo {
  id: string;
  rootId: string;
  name: string;
  path: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  mediaType: string | null;
  fingerprint: string | null;
  thumbnailState: "pending" | "ready" | "failed";
  thumbnailPath: string | null;
  duplicateCount: number;
  container: string | null;
}

export interface E2EProgress {
  videoId: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface E2EScanStep {
  processed: number;
  total: number;
}

export interface E2ESummary {
  roots: number;
  added: number;
  updated: number;
  removed: number;
  errors: string[];
}

export interface E2EFixtures {
  roots?: E2ERoot[];
  videos?: Record<string, E2EVideo[]>;
  progress?: Record<string, E2EProgress | null>;
  scan?: { steps: E2EScanStep[]; summary: E2ESummary };
  /** 目录选择对话框的返回值（null = 用户取消） */
  pickDir?: string | null;
  addRootsResult?: E2ERoot[];
  /**
   * 扫描「完成」后才出现在 list_videos 里的条目（按根分组）。
   * 用来复现真实时序：扫描分批提交，扫描途中点根目录只能拿到一部分，
   * 扫描结束后靠 store 的自动刷新才补齐（否则目录树会停在半成品快照）。
   */
  scannedVideos?: Record<string, E2EVideo[]>;
  /** 扫描完成后 add_roots/list_roots 返回的根（含刷新的 videoCount） */
  scannedRoots?: E2ERoot[];
}

/**
 * 在页面里装好 `window.__TAURI_INTERNALS__`。
 * Channel 的投递方式照 @tauri-apps/api v2 的实现来：`transformCallback` 注册回调，
 * 之后按 `{ index, message }` 递增投递，index 必须从 0 开始。
 */
function tauriMock(fixtures: E2EFixtures): void {
  const fx = fixtures ?? {};
  const callbacks = new Map<number, (m: unknown) => void>();
  let seq = 0;

  function emit(channel: unknown, index: number, message: unknown): void {
    const id =
      typeof channel === "object" && channel !== null && "id" in channel
        ? Number((channel as { id: number }).id)
        : Number(String(channel).replace("__CHANNEL__:", ""));
    callbacks.get(id)?.({ index, message });
  }

  const grant = {
    path: "",
    kind: "video",
    mode: "dir_recursive",
    applied: true,
    reason: "granted",
  };

  // 扫描是一次性的：完成后 list_roots / list_videos 才切到「扫完」的那份数据
  let scanDone = false;
  const rootsNow = (): E2ERoot[] =>
    scanDone && fx.scannedRoots ? fx.scannedRoots : (fx.roots ?? []);
  const videosNow = (rootId: string): E2EVideo[] => {
    const base = fx.videos?.[rootId] ?? [];
    const extra = scanDone ? (fx.scannedVideos?.[rootId] ?? []) : [];
    return [...base, ...extra];
  };

  const handlers: Record<
    string,
    (args: Record<string, unknown>) => unknown | Promise<unknown>
  > = {
    list_roots: () => rootsNow(),
    add_roots: () => fx.addRootsResult ?? [],
    remove_root: () => undefined,
    cancel_scan: () => undefined,
    set_realtime: () => undefined,
    list_videos: (args) => videosNow(String(args.rootId)),
    list_groups: () => [],
    list_group_items: () => [],
    get_progress: (args) => fx.progress?.[String(args.videoId)] ?? null,
    save_progress: () => true,
    clear_progress: () => undefined,
    ensure_thumb: async (args) => {
      const videoId = String(args.videoId);
      emit(args.onProgress, 0, { videoId, state: "pending", progress: 0 });
      emit(args.onProgress, 1, { videoId, state: "ready", progress: 100 });
      return "";
    },
    scan_roots: async (args) => {
      const steps = fx.scan?.steps ?? [];
      for (let i = 0; i < steps.length; i += 1) {
        emit(args.onEvent, i, steps[i]);
        await new Promise((r) => setTimeout(r, 10));
      }
      scanDone = true;
      return (
        fx.scan?.summary ?? {
          roots: 1,
          added: 0,
          updated: 0,
          removed: 0,
          errors: [],
        }
      );
    },
    grant_asset_root: () => grant,
    list_asset_rules: () => [],
    // 转封装：E2E 不背真二进制，桩成"不用转"，前端照原路径播
    remux_to_cache: () => ({ status: "skipped", path: null, reason: null }),
    // 设置页的缓存卡片：空占用，清除成功
    remux_cache_stats: () => ({ totalBytes: 0, fileCount: 0 }),
    clear_remux_cache: () => ({ totalBytes: 0, fileCount: 0 }),
    "plugin:dialog|open": () => fx.pickDir ?? null,
  };

  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    transformCallback(cb: (m: unknown) => void): number {
      const id = (seq += 1);
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number): void {
      callbacks.delete(id);
    },
    invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
      const h = handlers[cmd];
      if (!h) return Promise.reject(new Error(`未打桩的命令: ${cmd}`));
      return Promise.resolve().then(() => h(args ?? {}));
    },
    convertFileSrc: (): string => "",
  };
  w.isTauri = true;
}

export async function installTauriMock(
  page: Page,
  fixtures: E2EFixtures,
): Promise<void> {
  await page.addInitScript(tauriMock, fixtures);
}

/** 媒体钩子：asset:// 在浏览器里加载不了，手动喂时长并触发元数据事件。 */
export async function fakeLoadedMetadata(
  page: Page,
  duration: number,
): Promise<void> {
  await page.evaluate((d) => {
    const v = document.querySelector("video");
    if (!v) throw new Error("播放页没有 video 元素");
    Object.defineProperty(v, "duration", { value: d, configurable: true });
    v.dispatchEvent(new Event("loadedmetadata"));
  }, duration);
}

export function video(
  patch: Partial<E2EVideo> & { id: string; name: string },
): E2EVideo {
  return {
    rootId: "r1",
    path: `D:\\剧集\\${patch.name}`,
    size: 1024,
    duration: 600,
    width: 1920,
    height: 1080,
    mediaType: "video/mp4",
    fingerprint: `fp-${patch.id}`,
    thumbnailState: "pending",
    thumbnailPath: null,
    duplicateCount: 1,
    container: null,
    ...patch,
  };
}
