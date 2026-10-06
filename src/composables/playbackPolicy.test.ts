import { describe, expect, it } from "vitest";
import {
  decideResume,
  endedAction,
  formatTime,
  keepPosition,
  naturalCompare,
  nextIndex,
  prevIndex,
  shouldPersist,
  sortByFileName,
  type ResumePreference,
} from "./playbackPolicy";

describe("decideResume", () => {
  const cases: Array<[ResumePreference, boolean, string]> = [
    ["ask", false, "ask"],
    ["resume", false, "resume"],
    ["restart", false, "restart"],
    ["ask", true, "resume"],
  ];

  it.each(cases)("preference=%s skipOnce=%s", (pref, skip, expected) => {
    expect(
      decideResume({ videoId: "v", position: 60, duration: 600 }, pref, skip)
        .action,
    ).toBe(expected);
  });

  // C5：pos >= duration - 30 即落入末尾窗口，边界值 570 起不再询问（技术方案 §14.2 同边界）
  it.each([
    [569, "ask"],
    [570, "restart"],
    [571, "restart"],
  ])("duration=600 position=%i", (position, expected) => {
    expect(
      decideResume({ videoId: "v", position, duration: 600 }, "ask").action,
    ).toBe(expected);
  });

  it("末尾 30s 一律从头，不受偏好影响", () => {
    for (const pref of ["ask", "resume", "restart"] as ResumePreference[]) {
      expect(
        decideResume({ videoId: "v", position: 571, duration: 600 }, pref)
          .action,
      ).toBe("restart");
    }
  });

  it("没有可用进度时直接播，不弹窗", () => {
    expect(
      decideResume({ videoId: "v", position: 0, duration: 600 }, "ask").action,
    ).toBe("play");
    expect(
      decideResume({ videoId: "v", position: 10, duration: 0 }, "ask").action,
    ).toBe("play");
  });
});

describe("keepPosition", () => {
  it("末尾 30s 之外保留", () => {
    expect(keepPosition(0, 600)).toBe(true);
    expect(keepPosition(569.9, 600)).toBe(true);
    expect(keepPosition(570, 600)).toBe(false);
  });

  it("时长未知时保留", () => {
    expect(keepPosition(1, 0)).toBe(true);
  });
});

describe("shouldPersist", () => {
  const base = {
    nowMs: 10_000,
    lastSaveMs: 0,
    lastSavedPosition: 0,
    position: 6,
  };

  it("位移超阈值可写", () => {
    expect(shouldPersist(base)).toBe(true);
  });

  it("位移不足且未切状态不写", () => {
    expect(shouldPersist({ ...base, position: 2 })).toBe(false);
  });

  it("状态切换即可写", () => {
    expect(shouldPersist({ ...base, position: 2, stateChanged: true })).toBe(
      true,
    );
  });

  it("1s 内不重复写", () => {
    expect(shouldPersist({ ...base, nowMs: 500, position: 20 })).toBe(false);
  });

  it("拖动进度条立即写", () => {
    expect(
      shouldPersist({ ...base, nowMs: 100, position: 1, immediate: true }),
    ).toBe(true);
  });
});

describe("列表步进", () => {
  it("单曲循环原地不动", () => {
    expect(nextIndex(1, 3, "single")).toBe(1);
  });

  it("列表循环回到开头", () => {
    expect(nextIndex(2, 3, "list")).toBe(0);
  });

  it("不循环到末尾停住", () => {
    expect(nextIndex(2, 3, "off")).toBeNull();
  });

  it("首项没有上一个", () => {
    expect(prevIndex(0, 3)).toBeNull();
    expect(prevIndex(2, 3)).toBe(1);
  });

  it("空列表无步进", () => {
    expect(nextIndex(0, 0, "list")).toBeNull();
    expect(prevIndex(0, 0)).toBeNull();
  });
});

describe("endedAction", () => {
  it("单曲循环恒重播，不看开关", () => {
    expect(endedAction("single", false, false)).toBe("replay");
    expect(endedAction("single", true, true)).toBe("replay");
  });

  it("开关关闭时结束即暂停，即使列表循环还有下一首", () => {
    expect(endedAction("list", false, true)).toBe("pause");
    expect(endedAction("off", false, false)).toBe("pause");
  });

  it("开关开启时交给循环模式", () => {
    expect(endedAction("list", true, true)).toBe("advance");
    expect(endedAction("off", true, false)).toBe("pause");
  });
});

describe("文件夹序", () => {
  it("数字按数值排，ep2 在 ep10 之前", () => {
    expect(naturalCompare("ep2.mp4", "ep10.mp4")).toBeLessThan(0);
    expect(["ep10", "ep2", "ep1"].sort(naturalCompare)).toEqual([
      "ep1",
      "ep2",
      "ep10",
    ]);
  });

  it("同名时按路径兜底，且不改原数组", () => {
    const src = [
      { name: "b.mp4", path: "/z/b.mp4" },
      { name: "a.mp4", path: "/y/a.mp4" },
      { name: "a.mp4", path: "/x/a.mp4" },
    ];
    const out = sortByFileName(src);
    expect(out.map((v) => v.path)).toEqual([
      "/x/a.mp4",
      "/y/a.mp4",
      "/z/b.mp4",
    ]);
    expect(src[0].path).toBe("/z/b.mp4");
  });
});

describe("formatTime", () => {
  it("按需要补小时", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(65)).toBe("01:05");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(-3)).toBe("00:00");
  });
});
