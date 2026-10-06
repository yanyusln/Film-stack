import type { PlatformApi } from "./index";

// 桌面端：无 PiP（V1 不做）、无亮度调节（委托系统）。（技术方案 §8.5 / §15）
export const desktopApi: PlatformApi = {
  isAndroid: false,
  needsAssetGrant: true,
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
