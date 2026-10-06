import { describe, expect, it } from "vitest";
import {
  detectCapabilities,
  probeEnv,
  type CapabilityEnv,
} from "./compatibility";

const base: CapabilityEnv = {
  isAndroid: true,
  hasVideoElement: true,
  hasDocument: true,
  fullscreenEnabled: true,
  hasWebkitFullscreen: false,
  pipEnabled: true,
  hasVideoPip: true,
  hasOrientationLock: true,
  hasMediaSession: true,
};

describe("detectCapabilities", () => {
  it("Android 全绿时全部可用", () => {
    const caps = detectCapabilities(base);
    expect(caps.playback.supported).toBe(true);
    expect(caps.pip.supported).toBe(true);
    expect(caps.pip.degrade).toBe("none");
    expect(caps.fullscreen.supported).toBe(true);
  });

  it("PC 不做画中画：按钮隐藏而不是禁用", () => {
    const caps = detectCapabilities({ ...base, isAndroid: false });
    expect(caps.pip.supported).toBe(false);
    expect(caps.pip.degrade).toBe("hide");
    expect(caps.pip.reason).toContain("PC");
  });

  it("Android 不支持 PiP 时禁用并给理由", () => {
    const caps = detectCapabilities({
      ...base,
      pipEnabled: false,
      hasVideoPip: false,
    });
    expect(caps.pip.supported).toBe(false);
    expect(caps.pip.degrade).toBe("hide");
    expect(caps.pip.reason).toContain("画中画");
  });

  it("全屏只认 webkit 前缀也算支持", () => {
    const caps = detectCapabilities({
      ...base,
      fullscreenEnabled: false,
      hasWebkitFullscreen: true,
    });
    expect(caps.fullscreen.supported).toBe(true);
  });

  it("全屏全不支持时降级为页面内铺满，不隐藏按钮", () => {
    const caps = detectCapabilities({
      ...base,
      fullscreenEnabled: false,
      hasWebkitFullscreen: false,
    });
    expect(caps.fullscreen.supported).toBe(false);
    expect(caps.fullscreen.degrade).toBe("fallback");
  });

  it("方向锁不可用只降级，不影响锁屏层", () => {
    const caps = detectCapabilities({ ...base, hasOrientationLock: false });
    expect(caps.orientationLock.supported).toBe(false);
    expect(caps.orientationLock.degrade).toBe("fallback");
  });

  it("MediaSession 缺失时不展示系统控件，但不算故障", () => {
    const caps = detectCapabilities({ ...base, hasMediaSession: false });
    expect(caps.mediaSession.supported).toBe(false);
    expect(caps.mediaSession.degrade).toBe("none");
  });

  it("没有 <video> 时核心播放降级，其余不受牵连", () => {
    const caps = detectCapabilities({ ...base, hasVideoElement: false });
    expect(caps.playback.supported).toBe(false);
    expect(caps.playback.degrade).toBe("fallback");
    expect(caps.playsInline.supported).toBe(false);
    expect(caps.fullscreen.supported).toBe(true);
  });
});

describe("probeEnv", () => {
  it("无 DOM 环境下不抛错，能力为假", () => {
    const env = probeEnv();
    expect(env.hasDocument).toBe(false);
    const caps = detectCapabilities(env);
    expect(caps.fullscreen.supported).toBe(false);
    expect(caps.pip.supported).toBe(false);
  });
});
