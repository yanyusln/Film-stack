// 前后端共享 TS 契约：所有平台差异必须先出现在此处（技术方案 §11.3）。
// 具体命令封装见 src/bridge/commands.ts（W1-4 起接入）。
import type { RootId } from "@/types/video";

export type ScanMode = "incremental" | "manual";

export interface RootMeta {
  id: RootId;
  label: string;
  path: string;
  enabled: boolean;
  /** 该根下 `missing = 0` 的视频数；侧栏目录树显示「电影 (4)」。旧桩/旧库可能缺省，读取处按 0 兜底。 */
  videoCount: number;
}

/**
 * 目录浏览的一项（`list_dirs`）。
 * 移动端 dialog 插件没有目录选择器，选根目录只能靠它逐级下钻；桌面端用不上。
 */
export interface DirEntryView {
  /** 完整路径：继续下钻或充当根目录都用这个值 */
  path: string;
  /** 目录名，用于展示 */
  name: string;
}

export interface ScanInput {
  // 前端生成的任务标识，用于 cancel_scan 精确取消（技术方案 §8.1）
  taskId: string;
  rootIds: string[];
  mode: ScanMode;
  ignoreExt: string[];
  maxDepth: number;
}

export interface ScanProgress {
  processed: number;
  total: number;
}

export interface ScanSummary {
  roots: number;
  added: number;
  updated: number;
  removed: number;
  errors: string[];
}

// 分组元数据（W3-1）：V1 仅一级，parentId 恒为 null（字段预留）。
export interface GroupMeta {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

// 视频元数据（含重复计数），供视频网格 / 重复角标使用（W2-4/W3）。
export interface VideoMeta {
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
  /** 真实容器（扫描时读文件头判定，非扩展名）：`avi` / `mp4 (isom)` …；老数据未知为 null */
  container: string | null;
}

// 分组排序提交结果（W3-2）：written 为实际落库条数（只写变化项），rebuilt 表示触发了 1000 步长重建。
export interface SortOrderResult {
  groupId: string;
  written: number;
  rebuilt: boolean;
}

export interface ThumbProgress {
  videoId: string;
  state: "pending" | "ready" | "failed";
  progress: number;
}

// 播放进度（W4，技术方案 §8.6）：末尾 30s 的记录由后端自动丢弃。
export interface PlayProgress {
  videoId: string;
  position: number;
  duration: number;
  updatedAt: number;
}

// ---- 动态资源放行（W4 前置）----
// 静态 scope 只覆盖 $APPDATA/thumbs/**，运行时选择的根目录/外挂字幕等需按规则动态授权。
export type AssetKind =
  "video" | "subtitle" | "cover" | "thumb" | "font" | "config";

export type GrantMode = "dir_recursive" | "file";

export interface AssetRuleView {
  kind: AssetKind;
  exts: string[];
  mode: GrantMode;
  enabled: boolean;
}

/** 播放源自检结果（只读读文件头，不依赖外部二进制）。 */
export interface VideoProbe {
  path: string;
  exists: boolean;
  size: number | null;
  /** mp4 / matroska / avi / flv / asf / mpeg-ts / null */
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** 视频编码是否受内置播放器支持（null = 没探出来）：决定转封装还是重编码 */
  videoSupported: boolean | null;
  /** 编码层面：不在解码白名单内时的人话提示 + 怎么救 */
  unsupportedHint: string | null;
  /** 容器层面：不在 HTML5 <video> 接受类型内时的提示（mp4/webm 为 null） */
  containerHint: string | null;
  /** 可复制的转换命令（只给字符串，应用不执行、不写盘）；放不了又救得回时才有 */
  suggestCommand: string | null;
  note: string | null;
}

/** 转封装结果：产物在**应用缓存**里，源文件不动。 */
export interface RemuxResult {
  /** `cached`（命中缓存）/ `remuxed`（刚转好）/ `skipped`（不用转）/ `error` */
  status: "cached" | "remuxed" | "skipped" | "error";
  /** 可播的缓存文件；`skipped` / `error` 时为 null */
  path: string | null;
  /**
   * `error` 的原因：`unsupported_platform` / `ffmpeg_missing` / `ffmpeg_failed` /
   * `source_missing` / `timeout` / `io_error:*`
   * 前两者必须分开：`unsupported_platform` = Android / iOS 上没有 ffmpeg 这回事（给命令是骗人）；
   * `ffmpeg_missing` = 平台支持但机器上没找到（桌面装一个即可）。
   */
  reason: string | null;
}

/** 转封装进度（Channel 流式推送）：转封装是整文件读写，没有反馈就等于卡死。 */
export interface RemuxProgress {
  /** 已写出字节 */
  done: number;
  /** 源文件大小（分母；产物可能略大于它） */
  total: number;
  /** 0–99，100% 由「转好了」那一瞬间说话 */
  pct: number;
}

export interface AssetGrant {
  path: string;
  kind: AssetKind | null;
  mode: GrantMode | null;
  applied: boolean;
  // granted / already_allowed / kind_not_allowed / denied_protected / skipped_mobile / path_missing / scope_error
  reason: string;
}
