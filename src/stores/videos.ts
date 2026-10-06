import { defineStore } from "pinia";
import { computed, ref } from "vue";
import * as cmd from "@/bridge/commands";
import type { VideoMeta } from "@/bridge/contracts";
import type { RootId, VideoId, VideoRecord } from "@/types/video";
import { sortByFileName } from "@/composables/playbackPolicy";

// 视频列表 store（W2-2/W2-4）：按根目录加载视频、按需请求缩略图。
// 缩略图并发与队列由 Rust 侧控制（并发 2、超时 30s、LRU 500MB），这里只做取数与状态记录。
const THUMB_BATCH = 24; // 首屏先请求前 24 项，避免一次灌入海量任务

/** 桥接层元数据 -> 前端展示记录（分组成员列表复用，缺 mtime 时补 0）。 */
export function toRecord(v: VideoMeta): VideoRecord {
  return {
    id: v.id as VideoId,
    rootId: v.rootId as RootId,
    path: v.path,
    name: v.name,
    size: v.size,
    mtime: 0,
    duration: v.duration,
    width: v.width,
    height: v.height,
    fingerprint: v.fingerprint ?? "",
    thumbnailPath: v.thumbnailPath,
    duplicateCount: v.duplicateCount,
    container: v.container ?? null,
  };
}

export const useVideosStore = defineStore("videos", () => {
  const items = ref<VideoRecord[]>([]);
  const selectedRootId = ref<RootId | null>(null);
  // 侧栏目录树下钻到的相对目录（'' = 根目录自身），网格只显示这一层（技术方案 §9.1 三视图）
  const currentDir = ref("");
  // PC 多选（设计稿「已选 2 个」）：选择只作用于当前目录视图，切目录即清空
  const selectedIds = ref<string[]>([]);
  const thumbState = ref<Record<string, "pending" | "ready" | "failed">>({});
  const thumbPath = ref<Record<string, string>>({});
  const thumbProgress = ref<Record<string, number>>({});
  const loading = ref(false);
  const errorText = ref("");

  const selectedCount = computed(() => selectedIds.value.length);
  const isSelected = (id: string) => selectedIds.value.includes(id);

  async function load(rootId: RootId) {
    loading.value = true;
    errorText.value = "";
    try {
      const list = await cmd.listVideos(rootId);
      // 后端是 SQLite 的 ORDER BY name（字节序，ep10 会排在 ep2 前）；
      // 这里统一成自然序，让网格顺序 = 文件夹连播顺序（F19 / 技术方案 §8.6）
      items.value = sortByFileName(list.map(toRecord));
      selectedRootId.value = rootId;
      currentDir.value = "";
      selectedIds.value = [];
      seedThumbs(list);
    } catch (e) {
      errorText.value = `加载视频失败：${String(e)}`;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 原地刷新：保持当前目录与已选集合。
   * 用户点空态里的「手动刷新」只是想把新扫到的条目取回来，不该被弹回根目录
   * （v1 反馈：刷新后位置重置，看起来像「刷新才出视频」）。
   */
  async function reload() {
    const id = selectedRootId.value;
    if (!id) return;
    const dir = currentDir.value;
    const picked = [...selectedIds.value];
    await load(id);
    currentDir.value = dir;
    // 目录/文件可能已被移走，选择集只保留仍在列表里的
    selectedIds.value = picked.filter((x) =>
      items.value.some((v) => v.id === x),
    );
  }

  function setDir(key: string) {
    if (currentDir.value === key) return;
    currentDir.value = key;
    selectedIds.value = [];
  }

  function toggleSelect(id: string) {
    selectedIds.value = isSelected(id)
      ? selectedIds.value.filter((x) => x !== id)
      : [...selectedIds.value, id];
  }

  function clearSelection() {
    selectedIds.value = [];
  }

  async function requestThumbs(limit: number) {
    const targets = items.value
      .filter((v) => thumbState.value[v.id] !== "ready")
      .slice(0, limit)
      .map((v) => v.id);
    await requestThumbByIds(targets);
  }

  async function requestThumbByIds(ids: string[]) {
    await Promise.all(ids.map((id) => requestThumb(id as VideoId)));
  }

  // 用后端返回的 thumbnail 状态预热，并为未就绪项排队请求。
  // 首页视频网格与分组成员列表共用（分组里的是同一批 video 记录）。
  function seedThumbs(list: VideoMeta[]) {
    for (const v of list) {
      if (v.thumbnailState === "ready" && v.thumbnailPath) {
        thumbState.value[v.id] = "ready";
        thumbPath.value[v.id] = v.thumbnailPath;
      } else {
        thumbState.value[v.id] = v.thumbnailState;
      }
    }
    const pending = list
      .filter((v) => thumbState.value[v.id] !== "ready")
      .slice(0, THUMB_BATCH)
      .map((v) => v.id);
    void requestThumbByIds(pending);
  }

  async function requestThumb(videoId: VideoId) {
    if (thumbState.value[videoId] === "ready") return;
    try {
      const p = await cmd.ensureThumb(videoId, (prog) => {
        thumbProgress.value[videoId] = prog.progress;
        if (prog.state === "ready" || prog.state === "failed") {
          thumbState.value[videoId] =
            prog.state === "ready" ? "ready" : "failed";
        }
      });
      thumbState.value[videoId] = "ready";
      thumbPath.value[videoId] = p;
    } catch {
      // 占位即可：失败（含 24h 内不重试）不打断列表
      thumbState.value[videoId] = "failed";
    }
  }

  return {
    items,
    selectedRootId,
    currentDir,
    selectedIds,
    selectedCount,
    thumbState,
    thumbPath,
    thumbProgress,
    loading,
    errorText,
    isSelected,
    load,
    reload,
    setDir,
    toggleSelect,
    clearSelection,
    requestThumb,
    requestThumbs,
    seedThumbs,
  };
});
