import type { GroupId } from "./video";

// 分组仅一级；parent_id 预留但 V1 不允许建立父子关系（技术方案 §6.1 / §7.3）。
export interface Group {
  id: GroupId;
  name: string;
  parentId: null;
  sortOrder: number;
}
