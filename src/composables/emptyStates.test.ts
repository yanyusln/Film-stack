import { describe, expect, it } from "vitest";
import { EMPTY_KINDS, EMPTY_STATES } from "./emptyStates";

// 文案逐字固定（技术方案 §10.3）：任何改写都要先改方案，测试在这里兜一道。
describe("四套空状态", () => {
  it("四套齐全", () => {
    expect(EMPTY_KINDS).toEqual([
      "no-group",
      "group-empty",
      "folder-empty",
      "search-empty",
    ]);
  });

  it("主文案与方案逐字一致", () => {
    expect(EMPTY_STATES["no-group"].title).toBe("还没有分组");
    expect(EMPTY_STATES["group-empty"].title).toBe("这个分组还是空的");
    expect(EMPTY_STATES["folder-empty"].title).toBe("当前目录没有可播放的视频");
    expect(EMPTY_STATES["search-empty"].title).toBe("没有找到匹配的视频");
  });

  it("每套都是一主操作 + 一文字链接，且都有次文案", () => {
    for (const kind of EMPTY_KINDS) {
      const s = EMPTY_STATES[kind];
      expect(s.action.length).toBeGreaterThan(0);
      expect(s.link.length).toBeGreaterThan(0);
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.action).not.toBe(s.link);
    }
  });

  it("次操作取自方案给定的动作", () => {
    expect(EMPTY_STATES["no-group"].link).toBe("从视频页添加");
    expect(EMPTY_STATES["group-empty"].link).toBe("取消分组");
    expect(EMPTY_STATES["folder-empty"].link).toBe("重新选择目录");
    expect(EMPTY_STATES["search-empty"].link).toBe("检查关键词");
  });
});
