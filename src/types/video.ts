// 视频与标识类型（技术方案 §7.1）。品牌类型防止混用裸字符串。
export type VideoId = string & { readonly __brand: "VideoId" };
export type GroupId = string & { readonly __brand: "GroupId" };
export type RootId = string & { readonly __brand: "RootId" };

export interface VideoRecord {
  id: VideoId;
  rootId: RootId;
  path: string;
  name: string;
  size: number;
  mtime: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  fingerprint: string;
  thumbnailPath: string | null;
  duplicateCount: number;
  /** 真实容器（扫描时读文件头判定）：列表页据此提前标出放不了的文件 */
  container: string | null;
}
