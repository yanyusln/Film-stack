// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DragHandle from "./DragHandle.vue";

describe("DragHandle", () => {
  const w = mount(DragHandle);

  it("带 data-drag-handle 标记，供拖拽库识别起点", () => {
    expect(w.get("span").attributes("data-drag-handle")).toBeDefined();
  });

  it("六点用 SVG 绘制而非盲文字符（Android 字体缺字形会显示豆腐块）", () => {
    const svg = w.get("svg");
    expect(svg.attributes("width")).toBe("24");
    expect(svg.attributes("height")).toBe("24");
    expect(w.findAll("circle")).toHaveLength(6);
    expect(w.text()).not.toContain("⠿");
  });

  it("触控热区 44×44 且 touch-none（防被页面滚动吞掉）", () => {
    const classes = w.get("span").classes();
    expect(classes).toContain("h-11");
    expect(classes).toContain("w-11");
    expect(classes).toContain("touch-none");
  });
});
