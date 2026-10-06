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
