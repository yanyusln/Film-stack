// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DupBadge from "./DupBadge.vue";

function tipOpacity(w: ReturnType<typeof mount>) {
  return (w.get('[role="tooltip"]').element as HTMLElement).style.opacity;
}

describe("DupBadge", () => {
  // C6：重复只做角标，文件名后不追加「·重复(N)」文字，气泡文案固定
  it("气泡文案严格为「该文件共有 N 处副本」", () => {
    const w = mount(DupBadge, { props: { count: 3 } });
    expect(w.get('[role="tooltip"]').text()).toBe("该文件共有 3 处副本");
  });

  it("默认隐藏，hover 才淡入", async () => {
    const w = mount(DupBadge, { props: { count: 2 } });
    expect(tipOpacity(w)).toBe("0");
    await w.trigger("mouseenter");
    expect(tipOpacity(w)).toBe("1");
    await w.trigger("mouseleave");
    expect(tipOpacity(w)).toBe("0");
  });

  it("长按出气泡，松手收起（触屏等价路径）", async () => {
    const w = mount(DupBadge, { props: { count: 2 } });
    await w.trigger("touchstart");
    expect(tipOpacity(w)).toBe("1");
    await w.trigger("touchend");
    expect(tipOpacity(w)).toBe("0");
  });

  it("两个半透明重叠胶片 20×20，粉描边 1.5px", () => {
    const w = mount(DupBadge, { props: { count: 2 } });
    const svg = w.get("svg");
    expect(svg.attributes("width")).toBe("20");
    expect(svg.attributes("height")).toBe("20");
    const rects = w.findAll("rect");
    expect(rects).toHaveLength(2);
    for (const r of rects) {
      expect(r.attributes("stroke")).toBe("#FB7299");
      expect(r.attributes("stroke-width")).toBe("1.5");
    }
  });
});
