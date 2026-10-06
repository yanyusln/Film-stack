import { onUnmounted, ref, toValue } from "vue";
import type { MaybeRefOrGetter } from "vue";

// 播放页手势层（W4-b / 技术方案 §8.5）。
// 状态机：idle → press → (move_y 竖滑 | longpress 长按 2x | doubletap ±10s | tap 播放/暂停) → release。
// 只做判定，不碰业务：seek / 倍速 / 音量 / 亮度全部通过回调交给播放页，方便单测。

export type GestureSide = "left" | "right";
export type GestureHintKind = "seek" | "rate" | "volume" | "brightness";

export interface GestureHint {
  kind: GestureHintKind;
  /** seek 为秒数（±10）；volume/brightness 为 0..1 电平。 */
  value: number;
  side?: GestureSide;
}

/** 双击左右半屏的步长（秒）。 */
export const SEEK_STEP_SEC = 10;
/** 双击判定窗口。 */
export const DOUBLE_TAP_WINDOW_MS = 300;
/** 长按进入 2x 的时长。 */
export const LONG_PRESS_MS = 500;
/** 长按时临时倍速。 */
export const TEMP_RATE = 2;
/** 判定「动了」的最小位移，与拖拽共用同一口径。 */
export const MOVE_PX = 8;
/** 竖滑滑过容器高度的这个比例即走满量程，避免一屏到底过于敏感。 */
export const FULL_SWIPE_RATIO = 0.6;

export function sideOf(x: number, width: number): GestureSide {
  return x < width / 2 ? "left" : "right";
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/// 双击：与上一次 tap 间隔落在窗口内即成立（不强制同侧，方便单手连击）。
export function isDoubleTap(
  lastTapAt: number | null,
  nowMs: number,
  windowMs: number = DOUBLE_TAP_WINDOW_MS,
): boolean {
  return lastTapAt !== null && nowMs - lastTapAt <= windowMs;
}

/// 竖滑意图：主方向必须是 y，否则视为横滑/页面滚动，不进入调节。
export function verticalIntent(
  dx: number,
  dy: number,
  movePx: number = MOVE_PX,
): boolean {
  return Math.abs(dy) >= movePx && Math.abs(dy) > Math.abs(dx);
}

/// 竖滑增量：上滑为正（dy<0）。返回 -1..1，由调用方叠加到手势起点的电平上。
export function swipeDelta01(dy: number, height: number): number {
  const denom = Math.max(1, height) * FULL_SWIPE_RATIO;
  return Math.max(-1, Math.min(1, -dy / denom));
}

export interface UseEdgeGestureOptions {
  /**
   * 手势总控（AGENTS §5 平板开关）。关闭后**只保留点击与双击**，
   * 长按 2x 与左右竖滑一并停用（技术方案 §8.5）。
   */
  master?: MaybeRefOrGetter<boolean>;
  /** 竖滑是否可用：PC 用横向滑条，仅触屏/移动形态接管。 */
  verticalEnabled?: MaybeRefOrGetter<boolean>;
  /** 手势起点的当前电平（0..1），用于相对调节而非跳变。 */
  readLevel?: (side: GestureSide) => number;
  onTap?: () => void;
  onSeekStep?: (sec: number) => void;
  onLongPress?: (active: boolean) => void;
  onLevelChange?: (side: GestureSide, level: number) => void;
}

export function useEdgeGesture(options: UseEdgeGestureOptions = {}) {
  const surface = ref<HTMLElement | null>(null);
  const hint = ref<GestureHint | null>(null);

  let pointerId: number | null = null;
  let phase: "idle" | "press" | "vertical" | "longpress" = "idle";
  let start = { x: 0, y: 0 };
  let side: GestureSide = "left";
  let baseLevel = 0;
  let lastTapAt: number | null = null;
  let longPressTimer: number | null = null;
  let hintTimer: number | null = null;

  /// `autoClearMs` 给定时自动消失（双击提示）；不给则由调用方显式收起（长按/竖滑期间需常驻）。
  function showHint(next: GestureHint | null, autoClearMs?: number) {
    if (hintTimer !== null) {
      window.clearTimeout(hintTimer);
      hintTimer = null;
    }
    hint.value = next;
    if (next && autoClearMs) {
      hintTimer = window.setTimeout(() => {
        hint.value = null;
        hintTimer = null;
      }, autoClearMs);
    }
  }

  function hideHintSoon(ms = 600) {
    if (hintTimer !== null) window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      hint.value = null;
      hintTimer = null;
    }, ms);
  }

  function cancelLongPress() {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function detach() {
    cancelLongPress();
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
  }

  function reset() {
    detach();
    phase = "idle";
    pointerId = null;
  }

  function onDown(ev: PointerEvent) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (pointerId !== null) return;
    const box = surface.value?.getBoundingClientRect();
    const width = box?.width ?? 0;
    side = sideOf(ev.clientX - (box?.left ?? 0), width);
    start = { x: ev.clientX, y: ev.clientY };
    pointerId = ev.pointerId;
    phase = "press";
    if (toValue(options.master ?? true)) {
      // 长按激活：按下期满且没有位移 -> 临时 2x
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        if (phase !== "press") return;
        phase = "longpress";
        options.onLongPress?.(true);
        showHint({ kind: "rate", value: TEMP_RATE });
      }, LONG_PRESS_MS);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  }

  function onPointerMove(ev: PointerEvent) {
    if (pointerId === null || ev.pointerId !== pointerId) return;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;

    if (phase === "press") {
      if (Math.hypot(dx, dy) < MOVE_PX) return;
      cancelLongPress();
      if (
        verticalIntent(dx, dy) &&
        toValue(options.master ?? true) &&
        toValue(options.verticalEnabled ?? false)
      ) {
        phase = "vertical";
        baseLevel = options.readLevel?.(side) ?? 0;
        return;
      }
      // 横向拖动不做 seek，避免和系统返回手势/页面滚动打架
      phase = "idle";
      return;
    }

    if (phase === "vertical") {
      const height = surface.value?.getBoundingClientRect().height ?? 0;
      const level = clamp01(baseLevel + swipeDelta01(dy, height));
      options.onLevelChange?.(side, level);
      showHint({
        kind: side === "left" ? "brightness" : "volume",
        value: level,
        side,
      });
    }
  }

  function onPointerUp(ev: PointerEvent) {
    if (pointerId === null || ev.pointerId !== pointerId) return;
    if (phase === "longpress") {
      options.onLongPress?.(false);
      showHint(null);
    } else if (phase === "vertical") {
      // 松手即止，提示稍作停留后自动收起
      hideHintSoon();
    } else if (phase === "press") {
      const now = Date.now();
      const double = isDoubleTap(lastTapAt, now);
      lastTapAt = double ? null : now;
      if (double) {
        const step = side === "right" ? SEEK_STEP_SEC : -SEEK_STEP_SEC;
        options.onSeekStep?.(step);
        showHint({ kind: "seek", value: step, side });
      }
      // 单击始终生效：双击时两次 toggle 互相抵消，净效果就是 seek
      options.onTap?.();
    }
    reset();
  }

  function onPointerCancel() {
    if (phase === "longpress") options.onLongPress?.(false);
    showHint(null);
    reset();
  }

  onUnmounted(() => {
    detach();
    if (hintTimer !== null) window.clearTimeout(hintTimer);
  });

  return { surface, hint, onDown };
}
