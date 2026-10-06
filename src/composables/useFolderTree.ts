// 目录树派生（技术方案 §9.1 三视图之「目录树」）：把已加载的 videos[].path 折成树。
// 纯计算、只读，不新增后端命令、不碰磁盘（C1）；节点计数按「该目录含子目录的视频数」。
import { naturalCompare } from "@/composables/playbackPolicy";

export interface FolderNode {
  /** 相对根目录的目录 key（POSIX 风格），`""` 表示根自身 */
  key: string;
  /** 显示名；根节点由调用方传 label */
  name: string;
  /** 该目录（含子目录）下的视频数 */
  count: number;
  depth: number;
  children: FolderNode[];
}

export interface Crumb {
  key: string;
  name: string;
}

const SEPARATORS = /[\\/]+/;

/** 去掉 Windows 长路径前缀（`\\?\` / `\\?\UNC\`）与尾部分隔符，便于前缀比较。 */
function normalize(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

/** 视频所属目录的相对 key；文件直接放在根目录时返回 `""`。 */
export function dirKeyOf(filePath: string, rootPath: string): string {
  const normRoot = normalize(rootPath).replace(/[\\/]+$/, "");
  const file = normalize(filePath);
  let rel = file;
  // Windows 路径大小写不敏感，macOS 默认也不敏感；统一小写比较更稳
  if (normRoot && file.toLowerCase().startsWith(normRoot.toLowerCase())) {
    rel = file.slice(normRoot.length);
  }
  const parts = rel.split(SEPARATORS).filter(Boolean);
  parts.pop(); // 末段是文件名
  return parts.join("/");
}

/**
 * 构建目录树。
 * @param dirKeys 每条视频的所在目录（可重复，`""` 表示根目录下的视频）
 * @param rootName 根节点显示名（一般是根目录 label）
 */
export function buildFolderTree(dirKeys: string[], rootName = ""): FolderNode {
  const root: FolderNode = {
    key: "",
    name: rootName,
    count: dirKeys.length,
    depth: 0,
    children: [],
  };
  const index = new Map<string, FolderNode>([["", root]]);

  for (const dir of dirKeys) {
    const parts = dir.split("/").filter(Boolean);
    let parent = root;
    let acc = "";
    for (const [i, part] of parts.entries()) {
      acc = acc ? `${acc}/${part}` : part;
      let node = index.get(acc);
      if (!node) {
        node = { key: acc, name: part, count: 0, depth: i + 1, children: [] };
        index.set(acc, node);
        parent.children.push(node);
      }
      // 每有一条视频落在这个目录下，沿途每一级都 +1（含子目录口径）
      node.count += 1;
      parent = node;
    }
  }

  sortTree(root);
  return root;
}

function sortTree(node: FolderNode): void {
  node.children.sort((a, b) => naturalCompare(a.name, b.name));
  for (const c of node.children) sortTree(c);
}

/** 按 key 找节点；空 key 返回根节点。 */
export function findNode(tree: FolderNode, dirKey: string): FolderNode | null {
  if (!dirKey) return tree;
  let node: FolderNode | undefined = tree;
  for (const part of dirKey.split("/").filter(Boolean)) {
    node = node?.children.find((c) => c.name === part);
    if (!node) return null;
  }
  return node ?? null;
}

/** 当前目录的直属子目录（文件夹卡片视图用）。 */
export function childFolders(tree: FolderNode, dirKey: string): FolderNode[] {
  return findNode(tree, dirKey)?.children ?? [];
}

/** 面包屑：`""` -> []，`"a/b"` -> [{a},{a/b}]。 */
export function crumbsOf(dirKey: string): Crumb[] {
  const out: Crumb[] = [];
  let acc = "";
  for (const part of dirKey.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ key: acc, name: part });
  }
  return out;
}
