import { ref } from "vue";
import * as cmd from "@/bridge/commands";
import { onBackButtonPress } from "@tauri-apps/api/app";
import type { PlatformApi } from "./index";

/** 本机媒体服务端口：0 = 还没拿到（此时回退 asset URL），由 ensureMediaServer 填入。 */
const port = ref(0);

// 实体返回键（Android 返回键 / 手势）拦截：只注册一次全局监听，由 backHandler 决定当前是否消费。
// 回调返回 true=已消费（如退出全屏、留在播放页），false=未消费 → 平台执行默认返回。
let backHandler: (() => boolean) | null = null;
let backUnlisten: Awaited<ReturnType<typeof onBackButtonPress>> | null = null;

async function ensureBackListener() {
  if (backUnlisten) return;
  backUnlisten = await onBackButtonPress(({ canGoBack }) => {
    if (!backHandler) {
      if (canGoBack) window.history.back();
      return;
    }
    const consumed = backHandler();
    if (!consumed && canGoBack) window.history.back();
  });
}

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
  // 方向锁：'landscape' 允许 90°/270° 双向（手机翻转 180° 仍可转）；'portrait' 锁竖屏；null 解锁。
  // 走 Screen Orientation API；非全屏时 WebView 可能拒绝，失败即降级返回 false（技术方案 §9.2）。
  async lockOrientation(mode: "landscape" | "portrait" | null) {
    const o = screen.orientation as unknown as
      { lock?: (o: string) => Promise<void>; unlock?: () => void } | undefined;
    if (!o?.lock) return false;
    try {
      if (mode === null) {
        o.unlock?.();
      } else {
        // landscape 锁两种横屏角，使 180° 翻转生效；portrait 锁竖屏
        await o.lock(mode);
      }
      return true;
    } catch {
      return false;
    }
  },
  setBrightness() {
    /* 占位：待 Kotlin 原生亮度（§8.5） */
  },
  setBackHandler(handler) {
    backHandler = handler;
    void ensureBackListener();
  },
};
