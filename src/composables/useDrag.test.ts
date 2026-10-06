import { describe, expect, it } from "vitest";
import {
  DRAG_TILT_DEG,
  evaluateGesture,
  resolveDropIndex,
  tiltDegrees,
  type DragRect,
} from "./useDrag";

// W3-3a：拖拽阈值与落点推导的纯函数用例（组件规范表 sheet2「拖拽手柄」行）。
const start = { x: 100, y: 100 };

// 与 y 轴成 deg 度、长度 len 的位移
function moveBy(deg: number, len: number) {
  const rad = (deg * Math.PI) / 180;
  return {
    x: start.x + Math.sin(rad) * len,
    y: start.y - Math.cos(rad) * len,
  };
}

describe("tiltDegrees", () => {
  it("主轴上无位移时视为纯横向 -> 90°（判为滚动）", () => {
    expect(tiltDegrees(10, 0, "y")).toBeCloseTo(90);
    expect(tiltDegrees(0, 10, "x")).toBeCloseTo(90);
  });

  it("沿轴位移为 0°", () => {
    expect(tiltDegrees(0, -10, "y")).toBeCloseTo(0);
    expect(tiltDegrees(10, 0, "x")).toBeCloseTo(0);
  });

  it("45° 斜位移两个方向都返回 45°", () => {
    expect(tiltDegrees(10, -10, "y")).toBeCloseTo(45);
    expect(tiltDegrees(10, -10, "x")).toBeCloseTo(45);
  });

  it("free 轴不参与偏离判定", () => {
    expect(tiltDegrees(10, 0, "free")).toBe(0);
  });
});

describe("evaluateGesture", () => {
  it("位移未过 8px 前保持未激活", () => {
    const cur = { x: start.x + 3, y: start.y - 4 }; // 5px
    expect(evaluateGesture(start, cur, { tiltDeg: 12, axis: "y" })).toBe(
      "inactive",
    );
  });

  it("满足阈值且沿轴 -> 激活", () => {
    expect(
      evaluateGesture(start, moveBy(0, 20), { tiltDeg: 12, axis: "y" }),
    ).toBe("active");
  });

  it("PC 允许 12°、拒绝更大偏离", () => {
    expect(
      evaluateGesture(start, moveBy(12, 30), {
        tiltDeg: DRAG_TILT_DEG.pc,
        axis: "y",
      }),
    ).toBe("active");
    expect(
      evaluateGesture(start, moveBy(13, 30), {
        tiltDeg: DRAG_TILT_DEG.pc,
        axis: "y",
      }),
    ).toBe("rejected");
  });

  it("手机阈值 8°：9° 即被判为滚动手势", () => {
    expect(
      evaluateGesture(start, moveBy(7, 30), {
        tiltDeg: DRAG_TILT_DEG.phone,
        axis: "y",
      }),
    ).toBe("active");
    expect(
      evaluateGesture(start, moveBy(9, 30), {
        tiltDeg: DRAG_TILT_DEG.phone,
        axis: "y",
      }),
    ).toBe("rejected");
  });

  it("平板阈值 10°", () => {
    expect(
      evaluateGesture(start, moveBy(10, 30), {
        tiltDeg: DRAG_TILT_DEG.tablet,
        axis: "y",
      }),
    ).toBe("active");
    expect(
      evaluateGesture(start, moveBy(11, 30), {
        tiltDeg: DRAG_TILT_DEG.tablet,
        axis: "y",
      }),
    ).toBe("rejected");
  });
});

describe("resolveDropIndex", () => {
  // 4 项列表，中线依次为 10 / 30 / 50 / 70
  const rects: DragRect[] = [
    { index: 0, mid: 10 },
    { index: 1, mid: 30 },
    { index: 2, mid: 50 },
    { index: 3, mid: 70 },
  ];

  it("未跨过任何中线时停留在原位", () => {
    expect(resolveDropIndex(rects, 2, 35)).toBe(2);
    expect(resolveDropIndex(rects, 2, 45)).toBe(2);
  });

  it("上移跨过多项中线时取最远的一项", () => {
    expect(resolveDropIndex(rects, 3, 25)).toBe(1);
    expect(resolveDropIndex(rects, 3, 5)).toBe(0);
  });

  it("下移跨过多项中线时取最远的一项", () => {
    expect(resolveDropIndex(rects, 0, 45)).toBe(1);
    expect(resolveDropIndex(rects, 0, 80)).toBe(3);
  });
});
