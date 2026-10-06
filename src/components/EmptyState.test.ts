// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import EmptyState from "./EmptyState.vue";
import { EMPTY_STATES, type EmptyKind } from "@/composables/emptyStates";

const KINDS = Object.keys(EMPTY_STATES) as EmptyKind[];

describe("EmptyState", () => {
  it("四套空态都在（无分组 / 分组为空 / 目录无视频 / 搜索无结果）", () => {
    expect(KINDS).toEqual([
      "no-group",
      "group-empty",
      "folder-empty",
      "search-empty",
    ]);
  });

  it.each(KINDS)("%s 的文案取自规范表，且带主操作与文字链接", (kind) => {
    const w = mount(EmptyState, { props: { kind } });
    const spec = EMPTY_STATES[kind];
    expect(w.text()).toContain(spec.title);
    expect(w.text()).toContain(spec.hint);
    expect(w.text()).toContain(spec.action);
    expect(w.text()).toContain(spec.link);

    const buttons = w.findAll("button");
    expect(buttons).toHaveLength(2);
  });

  it("点击主操作与文字链接分别 emit", async () => {
    const w = mount(EmptyState, { props: { kind: "no-group" } });
    await w.findAll("button")[0].trigger("click");
    await w.findAll("button")[1].trigger("click");
    expect(w.emitted("action")).toHaveLength(1);
    expect(w.emitted("link")).toHaveLength(1);
  });

  it("插画按 compact 切换尺寸（移动端 160 / 桌面 240）", () => {
    const wide = mount(EmptyState, { props: { kind: "no-group" } });
    expect(wide.get("svg").classes()).toContain("h-32");
    const compact = mount(EmptyState, {
      props: { kind: "no-group", compact: true },
    });
    expect(compact.get("svg").classes()).toContain("h-24");
  });

  it("插画不出现云/会员/登录等意象：只用线稿描边，且无图片", () => {
    const w = mount(EmptyState, { props: { kind: "search-empty" } });
    expect(w.find("img").exists()).toBe(false);
    expect(w.get("svg").attributes("stroke")).toBe("var(--illu-line)");
    expect(w.text()).not.toContain("登录");
    expect(w.text()).not.toContain("会员");
  });
});
