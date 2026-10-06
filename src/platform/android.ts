import type { PlatformApi } from "./index";

// Android 端（技术方案 §3.3 / §8.5）：
// 亮度与 PiP 的真正原生实现需要 Kotlin 插件（后续周次），此处给出可用的降级路径：
// - PiP：优先走 WebView 的 Picture-in-Picture；不支持时返回 false，由 UI 禁用按钮
// - 亮度：仍为占位，播放页用应用层遮罩兜底，不假装改了系统背光
export const androidApi: PlatformApi = {
  isAndroid: true,
  // asset 放行机制在移动端是 no-op（assets.rs::dynamic_grant_supported），跳过这段 IPC
  needsAssetGrant: false,
  async enterPip(video) {
    if (!video || !document.pictureInPictureEnabled) return false;
    try {
      await video.requestPictureInPicture();
      return true;
    } catch {
      return false;
    }
  },
  // F16（W5-3）：走 Screen Orientation API；非全屏时 WebView 会拒绝，返回 false 由 UI 提示。
  // 真正的 Activity 方向锁仍需 Kotlin 插件，属后续周次（技术方案 §9.2）。
  async lockOrientation(locked) {
    // lib.dom 的 ScreenOrientation 尚未声明 lock/unlock，这里按结构取用，失败即降级
    const o = screen.orientation as unknown as
      { lock?: (o: string) => Promise<void>; unlock?: () => void } | undefined;
    if (!o?.lock) return false;
    try {
      if (locked) {
        if (!document.fullscreenElement) return false;
        await o.lock("landscape");
      } else {
        o.unlock?.();
      }
      return true;
    } catch {
      return false;
    }
  },
  setBrightness() {
    /* 占位：待 Kotlin 原生亮度（§8.5） */
  },
};
