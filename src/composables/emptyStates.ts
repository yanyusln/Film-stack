// 四套空状态（技术方案 §10.3 / F21）：文案与插画意象逐字固定，改一个字都要回到方案对齐。
// 单独成模块是为了让文案可被单测锁住，避免各视图各写一份导致漂移。
export type EmptyKind =
  "no-group" | "group-empty" | "folder-empty" | "search-empty";

export interface EmptySpec {
  kind: EmptyKind;
  /** 主文案：16px / 500，逐字固定 */
  title: string;
  /** 次文案：14px / 400 */
  hint: string;
  /** 主操作，仅一个 */
  action: string;
  /** 次操作，仅一个文字链接 */
  link: string;
}

export const EMPTY_STATES: Record<EmptyKind, EmptySpec> = {
  "no-group": {
    kind: "no-group",
    title: "还没有分组",
    hint: "把常看的影片收进分组，下次直接连播。",
    action: "新建分组",
    link: "从视频页添加",
  },
  "group-empty": {
    kind: "group-empty",
    title: "这个分组还是空的",
    hint: "添加影片后就能按分组顺序连播。",
    action: "添加视频",
    link: "取消分组",
  },
  "folder-empty": {
    kind: "folder-empty",
    title: "当前目录没有可播放的视频",
    hint: "可以刷新一次，或换一个目录再看。",
    action: "手动刷新",
    link: "重新选择目录",
  },
  "search-empty": {
    kind: "search-empty",
    title: "没有找到匹配的视频",
    hint: "换个关键词，或把筛选条件清掉。",
    action: "清除筛选",
    link: "检查关键词",
  },
};

export const EMPTY_KINDS = Object.keys(EMPTY_STATES) as EmptyKind[];
