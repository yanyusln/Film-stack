// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import SpeedMenu from "./SpeedMenu.vue";
import {
  PLAYBACK_RATES,
  type PlaybackRate,
} from "@/composables/playbackPolicy";

let w: VueWrapper | null = null;

function open(rate: PlaybackRate = 1) {
  // visible 与真实用法一致（控制栏可见时才允许展开）
  w = mount(SpeedMenu, {
    attachTo: document.body,
    props: { rate, visible: true },
  });
  return w;
}

function itemsOf(wrapper: VueWrapper) {
  return wrapper.findAll('[role="menuitemradio"]');
}

afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = "";
});

describe("SpeedMenu", () => {
  it("默认收起，aria-expanded 与展开状态同步", async () => {
    const wrapper = open();
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("false");
    await wrapper.get("button").trigger("click");
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("true");
    expect(itemsOf(wrapper)).toHaveLength(6);
  });

  it("六档倍速，当前档位带 aria-checked", async () => {
    const wrapper = open(1.5 as 1.5);
    await wrapper.get("button").trigger("click");
    const checked = itemsOf(wrapper).filter(
      (i) => i.attributes("aria-checked") === "true",
    );
    expect(checked).toHaveLength(1);
    expect(checked[0].text()).toBe("1.5x");
    expect(itemsOf(wrapper).map((i) => i.text())).toEqual([
      "0.5x",
      "0.75x",
      "1x",
      "1.25x",
      "1.5x",
      "2x",
    ]);
  });

  it("点击档位 emit select 并收起", async () => {
    const wrapper = open();
    await wrapper.get("button").trigger("click");
    await itemsOf(wrapper)[4].trigger("click");
    expect(wrapper.emitted("select")).toEqual([[1.5]]);
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("false");
  });

  it("键盘：方向键移动、Enter 选中、Esc 关闭", async () => {
    const wrapper = open();
    const root = wrapper.get("div");
    await root.trigger("keydown", { key: "ArrowDown" }); // 收起态也能展开
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("true");
    await root.trigger("keydown", { key: "ArrowDown" }); // 1x -> 1.25x
    await root.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("select")).toEqual([[1.25]]);

    await root.trigger("keydown", { key: "ArrowDown" });
    await root.trigger("keydown", { key: "Escape" });
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("false");
  });

  it("控制栏淡出时连带收起，不留悬空浮层", async () => {
    const wrapper = open();
    await wrapper.get("button").trigger("click");
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("true");
    await wrapper.setProps({ visible: false });
    await nextTick();
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("false");
  });

  it("点击外部收起", async () => {
    const wrapper = open();
    await wrapper.get("button").trigger("click");
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("false");
  });

  it("档位与常量表一致，不新增未定义的倍速", () => {
    expect(PLAYBACK_RATES).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
  });
});
