// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// 桌面端走官方 convertFileSrc；这里给确定性结果，避免依赖 UA 之外的实现细节。
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

const mediaServerPort = vi.hoisted(() => vi.fn());
vi.mock("@/bridge/commands", () => ({ mediaServerPort }));

import { usePlatform } from "./index";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; 2211133C Build/UKQ1) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36";

function setUa(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

afterEach(() => {
  setUa(DESKTOP_UA);
  mediaServerPort.mockReset();
});

describe("toAssetUrl（本地文件 → webview 可加载 URL）", () => {
  // 注意：端口是模块级状态，同一文件内共享 —— 依赖声明顺序（vitest 顺序执行）；
  // 真实运行只有 App 启动那一次取值。
  it("端口没拿到时回退 asset URL（图片通道仍可用，不硬失败）", async () => {
    setUa(ANDROID_UA);
    mediaServerPort.mockRejectedValue(new Error("not_running"));
    await usePlatform().ensureMediaServer();
    expect(usePlatform().toAssetUrl("/storage/emulated/0/a.mp4")).toBe(
      "http://asset.localhost/%2Fstorage%2Femulated%2F0%2Fa.mp4",
    );
  });

  it("Android 走本机回环媒体服务，不是 asset 协议", async () => {
    setUa(ANDROID_UA);
    mediaServerPort.mockResolvedValue(17888);
    await usePlatform().ensureMediaServer();
    const p = usePlatform();
    expect(p.isAndroid).toBe(true);
    // <video> 的请求不进 WebView 的 shouldInterceptRequest：asset.localhost 解析不到，
    // 必须走 127.0.0.1 的真实 TCP（真机 PIPELINE_ERROR_READ 的修复）
    expect(p.toAssetUrl("/storage/emulated/0/Download/a.mp4")).toBe(
      "http://127.0.0.1:17888/media?p=%2Fstorage%2Femulated%2F0%2FDownload%2Fa.mp4",
    );
  });

  // 端口沿用上一条用例取到的 17888（模块级状态）
  it("Android 上中文与空格路径要编码正确", async () => {
    setUa(ANDROID_UA);
    expect(usePlatform().toAssetUrl("/storage/emulated/0/电影/a b.mp4")).toBe(
      `http://127.0.0.1:17888/media?p=${encodeURIComponent(
        "/storage/emulated/0/电影/a b.mp4",
      )}`,
    );
  });

  it("已取到端口后不再重复 IPC（幂等）", async () => {
    setUa(ANDROID_UA);
    await usePlatform().ensureMediaServer();
    await usePlatform().ensureMediaServer();
    expect(mediaServerPort).not.toHaveBeenCalled();
  });

  it("桌面端沿用 convertFileSrc，且不需要媒体服务", async () => {
    setUa(DESKTOP_UA);
    await usePlatform().ensureMediaServer();
    expect(mediaServerPort).not.toHaveBeenCalled();
    expect(usePlatform().toAssetUrl("D:\\v\\a.mp4")).toBe(
      "asset://localhost/D%3A%5Cv%5Ca.mp4",
    );
  });

  it("移动端不需要 asset 动态放行（no-op）", () => {
    setUa(ANDROID_UA);
    expect(usePlatform().needsAssetGrant).toBe(false);
    setUa(DESKTOP_UA);
    expect(usePlatform().needsAssetGrant).toBe(true);
  });
});
