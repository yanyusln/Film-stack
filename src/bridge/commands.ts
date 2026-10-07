// Tauri 命令封装：与契约（contracts.ts）一一对应。窗口名与命令名见技术方案 §17.1。
import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  RootMeta,
  ScanInput,
  ScanSummary,
  ScanProgress,
  VideoMeta,
  ThumbProgress,
  GroupMeta,
  SortOrderResult,
  AssetRuleView,
  AssetGrant,
  VideoProbe,
  RemuxResult,
  RemuxProgress,
  PlayProgress,
  DirEntryView,
} from "./contracts";

export function listRoots(): Promise<RootMeta[]> {
  return invoke<RootMeta[]>("list_roots");
}

/**
 * 列出一层子目录（`path` 传 null 时给存储根候选，Android 起手用它）。
 * 这是移动端唯一的选目录入口——dialog 插件在移动端没有目录选择器。
 * 读不到会 reject（而不是给空数组），界面据此区分「没权限」与「空目录」。
 */
export function listDirs(path: string | null): Promise<DirEntryView[]> {
  return invoke<DirEntryView[]>("list_dirs", { path });
}

export function addRoots(paths: string[]): Promise<RootMeta[]> {
  return invoke<RootMeta[]>("add_roots", { paths });
}

export function removeRoot(rootId: string): Promise<void> {
  return invoke("remove_root", { rootId });
}

export function cancelScan(taskId: string): Promise<void> {
  return invoke("cancel_scan", { taskId });
}

export function setRealtime(enabled: boolean): Promise<void> {
  return invoke("set_realtime", { enabled });
}

// 列出某根目录下的视频（W2-4/W3）。返回含 duplicateCount 的元数据。
export function listVideos(rootId: string): Promise<VideoMeta[]> {
  return invoke<VideoMeta[]>("list_videos", { rootId });
}

// ---- 分组（W3-1）----
export function createGroup(name: string): Promise<GroupMeta> {
  return invoke<GroupMeta>("create_group", { name });
}

export function listGroups(): Promise<GroupMeta[]> {
  return invoke<GroupMeta[]>("list_groups");
}

// 多归属：同一视频可加入多个分组；返回实际新增引用数。
export function addToGroup(
  groupId: string,
  videoIds: string[],
): Promise<number> {
  return invoke<number>("add_to_group", { groupId, videoIds });
}

// 只删引用，不删视频文件/记录。
export function removeFromGroup(
  groupId: string,
  videoId: string,
): Promise<void> {
  return invoke("remove_from_group", { groupId, videoId });
}

// 小数排序：(prev + next) / 2，由调用方计算后传入。
export function setGroupOrder(
  groupId: string,
  videoId: string,
  sortOrder: number,
): Promise<void> {
  return invoke("set_group_order", { groupId, videoId, sortOrder });
}

// 整列提交排序（W3-2）：只写变化项；失败由 Rust 事务回滚，前端回滚内存顺序。
export function setSortOrder(
  groupId: string,
  ordered: string[],
): Promise<SortOrderResult> {
  return invoke<SortOrderResult>("set_sort_order", { groupId, ordered });
}

export function listGroupItems(groupId: string): Promise<VideoMeta[]> {
  return invoke<VideoMeta[]>("list_group_items", { groupId });
}

// 删除分组：级联删除引用，videos 不受影响。
export function removeGroup(groupId: string): Promise<void> {
  return invoke("remove_group", { groupId });
}

// 获取/生成缩略图（W2-2）。onProgress 接收抽帧进度（>500MB 文件才有中间进度）。
export function ensureThumb(
  videoId: string,
  onProgress: (p: ThumbProgress) => void,
): Promise<string> {
  const channel = new Channel<ThumbProgress>();
  channel.onmessage = onProgress;
  return invoke<string>("ensure_thumb", { videoId, onProgress: channel });
}

// onEvent 对应 Rust 命令的 on_event: Channel<ScanProgress>（Tauri 自动 camel/snake 转换）
export function scanRoots(
  input: ScanInput,
  onProgress: (p: ScanProgress) => void,
): Promise<ScanSummary> {
  const channel = new Channel<ScanProgress>();
  channel.onmessage = onProgress;
  return invoke<ScanSummary>("scan_roots", { input, onEvent: channel });
}

// ---- 播放进度（W4）----
export function getProgress(videoId: string): Promise<PlayProgress | null> {
  return invoke<PlayProgress | null>("get_progress", { videoId });
}

// 命中末尾 30s 时后端改为清库并返回 false。
export function saveProgress(
  videoId: string,
  position: number,
  duration: number,
): Promise<boolean> {
  return invoke<boolean>("save_progress", { videoId, position, duration });
}

export function clearProgress(videoId: string): Promise<void> {
  return invoke("clear_progress", { videoId });
}

// ---- 动态资源放行 ----
// add_roots 内部已为根目录补授权；本命令用于运行时额外授权（如用户手动挑的外挂字幕/字体文件）。
export function grantAssetRoot(root: string): Promise<AssetGrant> {
  return invoke<AssetGrant>("grant_asset_root", { root });
}

// 播放失败时的自检：文件在不在、多大、什么编码（只读文件头，不需要 ffmpeg）。
export function probeVideo(path: string): Promise<VideoProbe> {
  return invoke<VideoProbe>("probe_video", { path });
}

// ---- 移动端媒体服务（回环 HTTP）----
// Android 上 <video> 的请求不进 WebView 的 shouldInterceptRequest，asset 协议供不了视频；
// 改由 Rust 侧的本机服务（127.0.0.1）供给。桌面端不启动该服务，调用会 reject，调用方需容错。
export function mediaServerPort(): Promise<number> {
  return invoke<number>("media_server_port");
}

// 把「放不了但救得回」的文件转封装到应用缓存（源文件一个字节都不动）。
// 没有 ffmpeg / 救不回来时返回 error/skipped，前端据此退回手动方案。
// onProgress 收流式进度：整文件读写可能跑几十秒，界面必须说清「在转、转了多少」。
export function remuxToCache(
  path: string,
  onProgress?: (p: RemuxProgress) => void,
): Promise<RemuxResult> {
  const channel = new Channel<RemuxProgress>();
  channel.onmessage = (p) => onProgress?.(p);
  return invoke<RemuxResult>("remux_to_cache", { path, onProgress: channel });
}

// 当前生效的放行规则表，供前端核对范围/排障（iOS/Android 不适用本机制）。
export function listAssetRules(): Promise<AssetRuleView[]> {
  return invoke<AssetRuleView[]>("list_asset_rules");
}

// ---- 转封装缓存（设置页）----
export interface RemuxCacheStats {
  totalBytes: number;
  fileCount: number;
}

export function remuxCacheStats(): Promise<RemuxCacheStats> {
  return invoke<RemuxCacheStats>("remux_cache_stats");
}

// 返回清除前的占用，界面据此提示「已释放多少」。
export function clearRemuxCache(): Promise<RemuxCacheStats> {
  return invoke<RemuxCacheStats>("clear_remux_cache");
}
