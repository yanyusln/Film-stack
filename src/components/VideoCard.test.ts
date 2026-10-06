// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import VideoCard from "./VideoCard.vue";
import DupBadge from "./DupBadge.vue";
import type { RootId, VideoId, VideoRecord } from "@/types/video";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

function video(patch: Partial<VideoRecord> = {}): VideoRecord {
  return {
    id: "v1" as VideoId,
    rootId: "r1" as RootId,
    path: "D:\\剧集\\ep2.mp4",
    name: "ep2.mp4",
    size: 1024,
    mtime: 0,
    duration: 62,
    width: null,
    height: null,
    fingerprint: "fp",
    thumbnailPath: null,
    duplicateCount: 1,
    container: null,
    ...patch,
  };
}

describe("VideoCard", () => {
  it("时长按 mm:ss 显示；超过 1 小时才带小时", () => {
    const w = mount(VideoCard, {
      props: {
        video: video({ duration: 62 }),
        thumbUrl: null,
        thumbState: "pending",
      },
    });
    expect(w.text()).toContain("01:02");
    expect(w.text()).not.toContain("0:01:02");
  });

  it("没有时长就不显示时长角标", () => {
    const w = mount(VideoCard, {
      props: {
        video: video({ duration: null }),
        thumbUrl: null,
        thumbState: "pending",
      },
    });
    expect(w.text()).not.toContain("01:02");
  });

  it("名称与路径都展示（路径灰 11px 由样式承担，这里只验内容）", () => {
    const w = mount(VideoCard, {
      props: { video: video(), thumbUrl: null, thumbState: "pending" },
    });
    expect(w.text()).toContain("ep2.mp4");
    expect(w.text()).toContain("D:\\剧集\\ep2.mp4");
  });

  it("未就绪显示占位文案：生成中 / 无封面", () => {
    const w = mount(VideoCard, {
      props: { video: video(), thumbUrl: null, thumbState: "pending" },
    });
    expect(w.text()).toContain("封面生成中");
    expect(w.find("img").exists()).toBe(false);
  });

  it("抽帧失败显示「无封面」，不显示裂图", () => {
    const w = mount(VideoCard, {
      props: { video: video(), thumbUrl: null, thumbState: "failed" },
    });
    expect(w.text()).toContain("无封面");
    expect(w.find("img").exists()).toBe(false);
  });

  it("有缩略图时走转换后的资源地址", () => {
    const w = mount(VideoCard, {
      props: {
        video: video(),
        thumbUrl: "D:\\thumbs\\a.jpg",
        thumbState: "ready",
      },
    });
    expect(w.get("img").attributes("src")).toBe("asset://D:\\thumbs\\a.jpg");
  });

  it("封面加载失败回落到占位（未授权 / 被 LRU 清掉）", async () => {
    const w = mount(VideoCard, {
      props: {
        video: video(),
        thumbUrl: "D:\\thumbs\\a.jpg",
        thumbState: "ready",
      },
    });
    await w.get("img").trigger("error");
    expect(w.find("img").exists()).toBe(false);
    expect(w.text()).toContain("无封面");
  });

  it("放不了的容器提前挂角标，能播的容器不挂", () => {
    const avi = mount(VideoCard, {
      props: {
        // 扩展名是 .mp4、容器是 avi：这类「看着没问题却放不了」的最需要提前标
        video: video({ container: "avi" }),
        thumbUrl: null,
        thumbState: "pending",
      },
    });
    expect(avi.text()).toContain("AVI");
    expect(avi.get("span[title]").attributes("title")).toContain("不支持");

    const mp4 = mount(VideoCard, {
      props: {
        video: video({ container: "mp4 (isom)" }),
        thumbUrl: null,
        thumbState: "pending",
      },
    });
    expect(mp4.text()).not.toContain("AVI");
  });

  it("重复数 > 1 才挂角标（C6：只标不改名）", () => {
    const one = mount(VideoCard, {
      props: {
        video: video({ duplicateCount: 1 }),
        thumbUrl: null,
        thumbState: "pending",
      },
    });
    expect(one.findComponent(DupBadge).exists()).toBe(false);

    const many = mount(VideoCard, {
      props: {
        video: video({ duplicateCount: 3 }),
        thumbUrl: null,
        thumbState: "pending",
      },
    });
    expect(many.findComponent(DupBadge).props("count")).toBe(3);
    expect(many.text()).not.toContain("重复(3)");
  });
});
