import { ref, type Ref } from "vue";

// 播放器能力矩阵（技术方案 §8.5 兼容表 / 开发计划 W4-3）：
// 探测按运行环境返回布尔值，降级表决定「隐藏 / 禁用 / 替代实现」；不支持时不隐藏核心播放。
// 探测入参是可注入的快照（CapabilityEnv），因此这个模块在 node 下可单测，不必挂 jsdom。

export type CapabilityKey =
  | "playback"
  | "playsInline"
  | "fullscreen"
  | "pip"
  | "orientationLock"
  | "mediaSession";

/** none=可用 · hide=隐藏按钮 · disable=显示但禁用 · fallback=用替代实现，不阻塞核心播放 */
export type Degrade = "none" | "hide" | "disable" | "fallback";

export interface Capability {
  supported: boolean;
  /** 不支持或走降级时给用户的说明，直接进 toast。 */
  reason: string;
  degrade: Degrade;
}

export type CapabilityMatrix = Record<CapabilityKey, Capability>;

export interface CapabilityEnv {
  isAndroid: boolean;
  hasVideoElement: boolean;
  hasDocument: boolean;
  fullscreenEnabled: boolean;
  /** WKWebView / 旧 WebView 的 `webkitRequestFullscreen` 前缀。 */
  hasWebkitFullscreen: boolean;
  pipEnabled: boolean;
  hasVideoPip: boolean;
  hasOrientationLock: boolean;
  hasMediaSession: boolean;
}

export function detectCapabilities(env: CapabilityEnv): CapabilityMatrix {
  const fullscreen =
    env.hasDocument && (env.fullscreenEnabled || env.hasWebkitFullscreen);
  // PC V1 不做画中画（技术方案 §8.5 / AGENTS §5），Android 才谈 WebView PiP
  const pip =
    env.isAndroid && env.hasDocument && env.pipEnabled && env.hasVideoPip;

  return {
    playback: {
      supported: env.hasVideoElement,
      reason: env.hasVideoElement
        ? ""
        : "当前环境不支持内嵌播放，请用系统播放器打开",
      degrade: env.hasVideoElement ? "none" : "fallback",
    },
    playsInline: {
      supported: env.hasVideoElement,
      reason: env.hasVideoElement ? "" : "无法阻止系统播放器接管",
      degrade: env.hasVideoElement ? "none" : "fallback",
    },
    fullscreen: {
      supported: fullscreen,
      reason: fullscreen ? "" : "当前环境不支持全屏，已改为页面内铺满",
      degrade: fullscreen ? "none" : "fallback",
    },
    pip: {
      supported: pip,
      reason: pip
        ? ""
        : env.isAndroid
          ? "当前环境不支持画中画"
          : "PC 端不做画中画",
      degrade: pip ? "none" : "hide",
    },
    orientationLock: {
      supported: env.hasOrientationLock,
      reason: env.hasOrientationLock
        ? ""
        : "当前环境无法锁定横屏，锁定后只收起控制栏与手势",
      degrade: env.hasOrientationLock ? "none" : "fallback",
    },
    mediaSession: {
      supported: env.hasMediaSession,
      reason: env.hasMediaSession ? "" : "当前环境不展示系统播放控件",
      degrade: env.hasMediaSession ? "none" : "none",
    },
  };
}

/** 从当前运行环境读一份快照；所有取值都做了存在性判断，缺 DOM 时不抛错。 */
export function probeEnv(): CapabilityEnv {
  const hasDocument = typeof document !== "undefined";
  const hasVideoElement = typeof HTMLVideoElement !== "undefined";
  const doc = hasDocument ? document : undefined;
  const navigatorRef = typeof navigator !== "undefined" ? navigator : undefined;

  // 前缀能力挂在 Element.prototype 上（WKWebView / 旧 WebView）
  const elProto =
    typeof Element !== "undefined"
      ? (Element.prototype as unknown as { webkitRequestFullscreen?: unknown })
      : undefined;
  const videoProto = hasVideoElement
    ? (HTMLVideoElement.prototype as unknown as {
        requestPictureInPicture?: unknown;
      })
    : undefined;
  const orientation =
    typeof screen !== "undefined"
      ? (screen.orientation as unknown as { lock?: unknown } | undefined)
      : undefined;

  return {
    isAndroid: !!navigatorRef && /Android/i.test(navigatorRef.userAgent ?? ""),
    hasVideoElement,
    hasDocument,
    fullscreenEnabled: !!doc?.fullscreenEnabled,
    hasWebkitFullscreen: typeof elProto?.webkitRequestFullscreen === "function",
    pipEnabled: !!doc?.pictureInPictureEnabled,
    hasVideoPip: typeof videoProto?.requestPictureInPicture === "function",
    hasOrientationLock: typeof orientation?.lock === "function",
    hasMediaSession: !!navigatorRef && "mediaSession" in navigatorRef,
  };
}

/**
 * 能力随 WebView 实现变化，但不会在会话中途变；进播放页探测一次，
 * 需要时（如权限/系统设置回来）用 refresh() 重探。
 */
export function useCompatibility(): {
  caps: Ref<CapabilityMatrix>;
  refresh: () => void;
} {
  const caps = ref<CapabilityMatrix>(detectCapabilities(probeEnv()));
  function refresh() {
    caps.value = detectCapabilities(probeEnv());
  }
  return { caps, refresh };
}
