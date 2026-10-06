import { describe, expect, it } from "vitest";
import { chunkRows, itemIndex, rowCount } from "./useVirtualGrid";

describe("chunkRows", () => {
  it("按列数切行，末行保留余数", () => {
    const rows = chunkRows([1, 2, 3, 4, 5], 2);
    expect(rows).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("空列表没有行", () => {
    expect(chunkRows([], 4)).toEqual([]);
  });

  it("列数非法时退化为 1 列，不抛错", () => {
    expect(chunkRows([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunkRows([1, 2], -3)).toEqual([[1], [2]]);
    expect(chunkRows([1, 2], 1.9)).toEqual([[1], [2]]);
  });

  it("不改动原数组", () => {
    const src = [3, 1, 2];
    chunkRows(src, 2);
    expect(src).toEqual([3, 1, 2]);
  });
});

describe("rowCount", () => {
  it.each([
    [0, 4, 0],
    [1, 4, 1],
    [4, 4, 1],
    [5, 4, 2],
    [100_000, 4, 25_000],
  ])("count=%i columns=%i", (count, cols, expected) => {
    expect(rowCount(count, cols)).toBe(expected);
  });

  it("负数条数按 0 处理", () => {
    expect(rowCount(-5, 3)).toBe(0);
  });
});

describe("itemIndex", () => {
  it("行内列偏移换算回原下标", () => {
    expect(itemIndex(2, 1, 3)).toBe(7);
    expect(itemIndex(0, 0, 3)).toBe(0);
  });
});
