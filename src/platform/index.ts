// 平台能力统一出口；运行时判断收口到 usePlatform()，禁止业务组件散布 UA 判断（技术方案 §3.3）。
import { desktopApi } from "./desktop";
import { androidApi } from "./android";

export interface PlatformApi {
  readonly isAndroid: boolean;
  /**
   * 开播前是否需要走 asset 协议放行。
   * Android / iOS 上 `assets.rs::dynamic_grant_supported()` 恒为 false（no-op），
   * 发起 invoke 只会拿到 `skipped_mobile`——这是平台差异，不是"放行失败"。
   */
  readonly needsAssetGrant: boolean;
  /**
   * 把本地文件绝对路径变成 webview 能加载的 URL（封面 / 视频都走这一条，禁止业务层自己拼）。
   *
   * Android 走**本机回环媒体服务**（`http://127.0.0.1:<port>/media?p=<encoded>`），
   * 不能用 asset 协议：Android WebView 的 `<video>` 请求不经过
   * `WebViewClient.shouldInterceptRequest`（media 层自己发真实网络请求），
   * 于是 `http://asset.localhost/...` 在没有外网时解析不到，真机表现为
   * PIPELINE_ERROR_READ / 源不可用 —— 封面能显示、视频不能播正是这个差别。
   * 端口未就绪时回退 asset URL（图片通道仍可用）。桌面端仍用 `convertFileSrc()`。
   */
  toAssetUrl(path: string): string;
  /**
   * 开播/渲染前取一次本机媒体服务端口（幂等）。桌面端为空实现。
   * 端口是响应式的：拿到后封面与视频源自动重算，无需刷新页面。
   */
  ensureMediaServer(): Promise<void>;
  // 传入 <video>：由平台决定走 WebView PiP 还是原生 Activity PiP。返回 false 表示不支持。
  enterPip(video?: HTMLVideoElement | null): Promise<boolean>;
  // F16 横屏锁：true=已锁定横屏 / 已解锁，false=当前环境不支持（PC 恒为 false，§9.2）。
  lockOrientation(locked: boolean): Promise<boolean>;
  setBrightness(level: number): void;
}

export function usePlatform(): PlatformApi {
  const isAndroid =
    typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  return isAndroid ? androidApi : desktopApi;
}
