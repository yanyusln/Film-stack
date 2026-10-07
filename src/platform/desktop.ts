import { convertFileSrc } from "@tauri-apps/api/core";
import type { PlatformApi } from "./index";

// 桌面端：无 PiP（V1 不做）、无亮度调节（委托系统）。（技术方案 §8.5 / §15）
export const desktopApi: PlatformApi = {
  isAndroid: false,
  needsAssetGrant: true,
  // 桌面端按 OS 走官方实现：Windows 得到 http://asset.localhost/…、macOS/Linux 得到 asset://localhost/…
  toAssetUrl(path) {
    return convertFileSrc(path);
  },
  // 桌面端不走本机媒体服务（asset 协议可用），保持空实现
  async ensureMediaServer() {
    /* 桌面端无媒体服务（视频走 asset 协议） */
  },
  async enterPip() {
    // PC V1 不做画中画（技术方案 §8.5 / AGENTS §5），按钮不出现
    return false;
  },
  async lockOrientation() {
    // PC 不调用方向锁，只切窗口/全屏（技术方案 §9.2）
    return false;
  },
  setBrightness() {
    /* no-op on desktop */
  },
};
