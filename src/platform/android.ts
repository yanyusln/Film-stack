import { ref } from "vue";
import * as cmd from "@/bridge/commands";
import type { PlatformApi } from "./index";

/** 本机媒体服务端口：0 = 还没拿到（此时回退 asset URL），由 ensureMediaServer 填入。 */
const port = ref(0);

// Android 端（技术方案 §3.3 / §8.5）：
// 亮度与 PiP 的真正原生实现需要 Kotlin 插件（后续周次），此处给出可用的降级路径：
// - PiP：优先走 WebView 的 Picture-in-Picture；不支持时返回 false，由 UI 禁用按钮
// - 亮度：仍为占位，播放页用应用层遮罩兜底，不假装改了系统背光
export const androidApi: PlatformApi = {
  isAndroid: true,
  // asset 放行机制在移动端是 no-op（assets.rs::dynamic_grant_supported），跳过这段 IPC
  needsAssetGrant: false,
  /**
   * 取本机媒体服务端口（幂等）。桌面端未启动该服务，命令会 reject —— 保持 port=0 走回退。
   * 端口是响应式的：拿到后封面与视频源会自动重算，不需要刷新页面。
   */
  async ensureMediaServer() {
    if (port.value) return;
    try {
      port.value = await cmd.mediaServerPort();
    } catch {
      port.value = 0;
    }
  },
  /**
   * 移动端视频走**本机回环 HTTP 服务**，不能走 asset 协议：
   * Android WebView 的 `<video>` 请求不经过 `WebViewClient.shouldInterceptRequest`
   * （media 层自己发真实网络请求），`http://asset.localhost/...` 在没有外网时解析不到，
   * 真机表现为 PIPELINE_ERROR_READ / 源不可用 —— 封面能显示、视频不能播正是这个差别。
   * 端口没拿到时回退 asset URL（图片通道仍可用，视频可能放不了）。
   */
  toAssetUrl(path) {
    const encoded = encodeURIComponent(path);
    return port.value
      ? `http://127.0.0.1:${port.value}/media?p=${encoded}`
      : `http://asset.localhost/${encoded}`;
  },
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
