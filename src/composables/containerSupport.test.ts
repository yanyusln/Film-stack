import { describe, expect, it } from "vitest";
import { unplayableContainerLabel } from "./containerSupport";

describe("容器可播性角标", () => {
  it("放不了的容器给短标签", () => {
    expect(unplayableContainerLabel("avi")).toBe("AVI");
    expect(unplayableContainerLabel("flv")).toBe("FLV");
    expect(unplayableContainerLabel("asf / wmv")).toBe("ASF");
    expect(unplayableContainerLabel("mpeg-ts")).toBe("TS");
    // MKV 与 webm 同源，但 Chromium 就是不认 matroska：标出来才能触发转封装
    expect(unplayableContainerLabel("matroska")).toBe("MKV");
    expect(unplayableContainerLabel("matroska / webm")).toBe("MKV");
    expect(unplayableContainerLabel("mov")).toBe("MOV");
    expect(unplayableContainerLabel("rmvb")).toBe("RM");
  });

  it("能播的容器不标记", () => {
    expect(unplayableContainerLabel("mp4 (isom)")).toBeNull();
    expect(unplayableContainerLabel("webm")).toBeNull();
    expect(unplayableContainerLabel("m4v")).toBeNull();
  });

  it("未知容器/老数据不标记，不吓唬人", () => {
    expect(unplayableContainerLabel(null)).toBeNull();
    expect(unplayableContainerLabel("")).toBeNull();
    expect(unplayableContainerLabel("某种新容器")).toBeNull();
  });
});
