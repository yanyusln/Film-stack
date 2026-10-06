// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import PlayerControls from "./PlayerControls.vue";
import type { LoopMode } from "@/composables/playbackPolicy";

const BASE = {
  playing: false,
  currentTime: 60,
  duration: 600,
  rate: 1 as const,
  volume: 0.8,
  muted: false,
  loopMode: "list" as LoopMode,
  hasPrev: true,
  hasNext: true,
  visible: true,
  locked: false,
  pipVisible: false,
};

function mountControls(patch: Partial<typeof BASE> = {}) {
  return mount(PlayerControls, { props: { ...BASE, ...patch } });
}

function btn(w: ReturnType<typeof mountControls>, label: string) {
  const hit = w.findAll("button").find((b) => b.text() === label);
  if (!hit) throw new Error(`按钮不存在: ${label}`);
  return hit;
}

describe("PlayerControls", () => {
  it("时间文本为「当前 / 总长」", () => {
    const w = mountControls();
    expect(w.text()).toContain("01:00 / 10:00");
  });

  it("拖动进度条 emit 目标秒数", async () => {
    const w = mountControls();
    await w.get('input[aria-label="播放进度"]').setValue("123.4");
    expect(w.emitted("seekTo")).toEqual([[123.4]]);
  });

  it("进度条没有悬浮缩略图（V1 不做）", () => {
    const w = mountControls();
    expect(w.html()).not.toContain("thumb");
  });

  it("播放/暂停文案随状态切换", async () => {
    const w = mountControls({ playing: false });
    expect(btn(w, "播放").exists()).toBe(true);
    await btn(w, "播放").trigger("click");
    expect(w.emitted("toggle")).toHaveLength(1);
    await w.setProps({ playing: true });
    expect(btn(w, "暂停").exists()).toBe(true);
  });

  it("首尾禁用上一个/下一个", () => {
    const w = mountControls({ hasPrev: false, hasNext: false });
    expect(btn(w, "上一个").attributes("disabled")).toBeDefined();
    expect(btn(w, "下一个").attributes("disabled")).toBeDefined();
  });

  it("循环模式按钮在 不循环→单曲→列表 之间循环", async () => {
    const w = mountControls({ loopMode: "off" });
    expect(btn(w, "不循环").exists()).toBe(true);
    await btn(w, "不循环").trigger("click");
    expect(w.emitted("setLoop")).toEqual([["single"]]);
    await w.setProps({ loopMode: "single" });
    await btn(w, "单曲循环").trigger("click");
    expect(w.emitted("setLoop")?.at(-1)).toEqual(["list"]);
    await w.setProps({ loopMode: "list" });
    await btn(w, "列表循环").trigger("click");
    expect(w.emitted("setLoop")?.at(-1)).toEqual(["off"]);
  });

  it("画中画只在 Android 出现（PC V1 不做）", () => {
    expect(mountControls({ pipVisible: false }).text()).not.toContain("画中画");
    expect(mountControls({ pipVisible: true }).text()).toContain("画中画");
  });

  it("控制栏淡出：不可见时透明且不接收点击", async () => {
    const w = mountControls({ visible: true });
    expect(w.get("div").classes()).toContain("opacity-100");
    await w.setProps({ visible: false });
    expect(w.get("div").classes()).toContain("opacity-0");
    expect(w.get("div").classes()).toContain("pointer-events-none");
  });

  it("音量条 emit 0..1", async () => {
    const w = mountControls();
    await w.get('input[aria-label="音量"]').setValue("0.35");
    expect(w.emitted("setVolume")).toEqual([[0.35]]);
  });
});
