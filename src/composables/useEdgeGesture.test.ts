import { describe, expect, it } from "vitest";
import {
  clamp01,
  isDoubleTap,
  SEEK_STEP_SEC,
  sideOf,
  swipeDelta01,
  verticalIntent,
} from "./useEdgeGesture";

describe("sideOf", () => {
  it("左半屏 / 右半屏", () => {
    expect(sideOf(0, 800)).toBe("left");
    expect(sideOf(399, 800)).toBe("left");
    expect(sideOf(400, 800)).toBe("right");
    expect(sideOf(799, 800)).toBe("right");
  });
});

describe("isDoubleTap", () => {
  it("窗口内成立", () => {
    expect(isDoubleTap(1000, 1200)).toBe(true);
    expect(isDoubleTap(1000, 1300)).toBe(true);
  });

  it("超出窗口或不曾点击则不算", () => {
    expect(isDoubleTap(1000, 1301)).toBe(false);
    expect(isDoubleTap(null, 1000)).toBe(false);
  });

  it("双击步长：右侧 +10s，左侧 -10s", () => {
    const step = (side: "left" | "right") =>
      side === "right" ? SEEK_STEP_SEC : -SEEK_STEP_SEC;
    expect(step("right")).toBe(10);
    expect(step("left")).toBe(-10);
  });
});

describe("verticalIntent", () => {
  it("竖向位移为主才算竖滑", () => {
    expect(verticalIntent(2, -20)).toBe(true);
    expect(verticalIntent(-20, 2)).toBe(false);
  });

  it("位移不足不算", () => {
    expect(verticalIntent(1, 6)).toBe(false);
  });
});

describe("swipeDelta01", () => {
  it("上滑为正、下滑为负", () => {
    expect(swipeDelta01(-30, 100)).toBeGreaterThan(0);
    expect(swipeDelta01(30, 100)).toBeLessThan(0);
  });

  it("走完 60% 高度即满量程并夹到 ±1", () => {
    expect(swipeDelta01(-60, 100)).toBeCloseTo(1, 6);
    expect(swipeDelta01(60, 100)).toBeCloseTo(-1, 6);
    expect(swipeDelta01(-500, 100)).toBe(1);
    expect(swipeDelta01(500, 100)).toBe(-1);
  });
});

describe("clamp01", () => {
  it("夹在 0..1", () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(0.42)).toBeCloseTo(0.42, 6);
  });
});
