import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  childFolders,
  crumbsOf,
  dirKeyOf,
  findNode,
} from "./useFolderTree";

// 目录树派生（W9 PC 布局）：纯函数，只吃字符串，不需要 DOM 与 Tauri。
describe("dirKeyOf", () => {
  it("Windows 反斜杠路径取相对目录", () => {
    expect(dirKeyOf("D:\\剧集\\动画\\ep1.mp4", "D:\\剧集")).toBe("动画");
    expect(dirKeyOf("D:\\剧集\\4K\\电影\\a.mp4", "D:\\剧集")).toBe("4K/电影");
  });

  it("文件直接放在根目录时是空 key", () => {
    expect(dirKeyOf("D:\\剧集\\ep1.mp4", "D:\\剧集")).toBe("");
  });

  it("根路径末尾带分隔符、大小写不同都能对上", () => {
    expect(dirKeyOf("D:\\剧集\\动画\\a.mp4", "D:\\剧集\\")).toBe("动画");
    expect(dirKeyOf("d:\\剧集\\动画\\a.mp4", "D:\\剧集")).toBe("动画");
  });

  it("POSIX 路径同样处理", () => {
    expect(dirKeyOf("/mnt/v/剧集/动画/a.mp4", "/mnt/v/剧集")).toBe("动画");
  });

  it("带 Windows 长路径前缀时仍能对上（避免树与网格口径分叉）", () => {
    expect(dirKeyOf("\\\\?\\D:\\剧集\\动画\\a.mp4", "D:\\剧集")).toBe("动画");
    expect(dirKeyOf("\\\\?\\UNC\\nas\\库\\动画\\a.mp4", "\\\\nas\\库")).toBe(
      "动画",
    );
  });
});

describe("buildFolderTree", () => {
  it("根节点计数等于视频条数，中间节点按含子目录口径累加", () => {
    const tree = buildFolderTree(
      ["", "动画", "动画", "动画/合集", "4K"],
      "剧集",
    );
    expect(tree.name).toBe("剧集");
    expect(tree.count).toBe(5);
    const names = tree.children.map((c) => c.name);
    expect(names).toEqual(["4K", "动画"]); // 自然序：数字/字母在前
    const anime = findNode(tree, "动画");
    expect(anime?.count).toBe(3);
    expect(findNode(tree, "动画/合集")?.count).toBe(1);
    expect(findNode(tree, "动画/合集")?.depth).toBe(2);
  });

  it("同名目录不重复建节点", () => {
    const tree = buildFolderTree(["a/b", "a/b", "a/c"], "根");
    expect(findNode(tree, "a")?.children.map((c) => c.name)).toEqual([
      "b",
      "c",
    ]);
  });

  it("空列表只有根节点", () => {
    const tree = buildFolderTree([], "根");
    expect(tree.count).toBe(0);
    expect(tree.children).toEqual([]);
  });

  it("childFolders 只返回当前目录的直属子目录", () => {
    const tree = buildFolderTree(["a", "a/b"], "根");
    expect(childFolders(tree, "").map((n) => n.name)).toEqual(["a"]);
    expect(childFolders(tree, "a").map((n) => n.name)).toEqual(["b"]);
    expect(childFolders(tree, "a/b")).toEqual([]);
  });

  it("自然序：ep2 排在 ep10 前", () => {
    const tree = buildFolderTree(["ep10", "ep2"], "根");
    expect(tree.children.map((n) => n.name)).toEqual(["ep2", "ep10"]);
  });
});

describe("crumbsOf", () => {
  it("空 key 没有面包屑", () => {
    expect(crumbsOf("")).toEqual([]);
  });

  it("多级目录逐级给 key", () => {
    expect(crumbsOf("4K/电影/合集")).toEqual([
      { key: "4K", name: "4K" },
      { key: "4K/电影", name: "电影" },
      { key: "4K/电影/合集", name: "合集" },
    ]);
  });
});
