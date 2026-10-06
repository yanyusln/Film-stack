// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ResumeDialog from "./ResumeDialog.vue";

/** 弹窗 Teleport 到 body，按钮只能从 document 里找 */
function button(label: string): HTMLButtonElement {
  const hit = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!hit) throw new Error(`按钮不存在: ${label}`);
  return hit;
}

function open(props: Record<string, unknown> = {}) {
  return mount(ResumeDialog, {
    attachTo: document.body,
    props: { open: true, videoId: "v1", position: 62, duration: 600, ...props },
  });
}

let mounted: VueWrapper | null = null;
function track(w: VueWrapper) {
  mounted = w;
  return w;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

describe("ResumeDialog", () => {
  it("关闭时不渲染任何内容", () => {
    const w = track(open({ open: false }));
    expect(document.body.textContent).not.toContain("继续上次播放");
    expect(w.html()).not.toContain("继续上次播放");
  });

  it("展示上次看到的时间", () => {
    track(open({ position: 3725 }));
    expect(document.body.textContent).toContain("1:02:05");
  });

  it("三个按钮各自 emit", async () => {
    const w = track(open());
    button("继续播放").click();
    await nextTick();
    button("从头播放").click();
    await nextTick();
    button("取消").click();
    await nextTick();
    expect(w.emitted("resume")).toEqual([[false]]);
    expect(w.emitted("restart")).toHaveLength(1);
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("勾选「本次不再询问」只影响本次：随 resume 上报，换视频后重置", async () => {
    const w = track(open());
    // 内容 Teleport 到 body，checkbox 要从 document 取
    const box = document.body.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await nextTick();
    button("继续播放").click();
    await nextTick();
    expect(w.emitted("resume")?.at(-1)).toEqual([true]);

    await w.setProps({ videoId: "v2" });
    expect(box.checked).toBe(false);
    button("继续播放").click();
    await nextTick();
    expect(w.emitted("resume")?.at(-1)).toEqual([false]);
  });
});
