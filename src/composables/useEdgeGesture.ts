import { onUnmounted, ref, toValue } from "vue";
import type { MaybeRefOrGetter } from "vue";

// 播放页手势层（W4-b / 技术方案 §8.5）。
// 状态机：idle → press → (vertical 竖滑亮/音 | seek 横滑进退 | longpress 长按 2x) → release。
// 轻点：单击切换控制栏显隐（不暂停）；双击暂停/恢复；横滑拖动前进/后退。
// 只做判定，不碰业务：具体动作全部通过回调交给播放页，方便单测。

export type GestureSide = "left" | "right";
export type GestureHintKind = "seek" | "rate" | "volume" | "brightness";

export interface GestureHint {
  kind: GestureHintKind;
  /** volume/brightness 为 0..1 电平；seek 为绝对目标秒数（=target）。 */
  value: number;
  side?: GestureSide;
  /** 横滑 seek 时的目标秒数（与 value 相同，方便 UI 直接显示）。 */
  target?: number;
}

/** 双击左右半屏的步长（秒），保留给兼容/测试引用。 */
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

/// 横滑意图：主方向必须是 x，用于行进/后退拖动。
export function horizontalIntent(
  dx: number,
  dy: number,
  movePx: number = MOVE_PX,
): boolean {
  return Math.abs(dx) >= movePx && Math.abs(dx) > Math.abs(dy);
}

/// 竖滑增量：上滑为正（dy<0）。返回 -1..1，由调用方叠加到手势起点的电平上。
export function swipeDelta01(dy: number, height: number): number {
  const denom = Math.max(1, height) * FULL_SWIPE_RATIO;
  return Math.max(-1, Math.min(1, -dy / denom));
}

export interface UseEdgeGestureOptions {
  /**
   * 手势总控（AGENTS §5 平板开关）。关闭后**只保留单击与双击**。
   * 长按 2x、左右竖滑、横滑进退一并停用（技术方案 §8.5）。
   */
  master?: MaybeRefOrGetter<boolean>;
  /** 竖滑是否可用：PC 用横向滑条，仅触屏/移动形态接管。 */
  verticalEnabled?: MaybeRefOrGetter<boolean>;
  /** 横滑 seek 是否可用：仅触屏/移动形态，PC 交给控制栏。 */
  seekEnabled?: MaybeRefOrGetter<boolean>;
  /** 手势起点的当前电平（0..1），用于相对调节而非跳变。 */
  readLevel?: (side: GestureSide) => number;
  /** 横滑 seek 起点时间/总时长，用于把像素位移换算成目标秒数。 */
  readTime?: () => { currentTime: number; duration: number };
  /** 单击：切换控制栏显隐（不暂停）。 */
  onTap?: () => void;
  /** 双击：暂停 / 恢复。 */
  onDoubleTap?: () => void;
  /** 横滑 seek：目标绝对秒数（实时）。 */
  onSeekDrag?: (to: number) => void;
  onLongPress?: (active: boolean) => void;
  onLevelChange?: (side: GestureSide, level: number) => void;
}

export function useEdgeGesture(options: UseEdgeGestureOptions = {}) {
  const surface = ref<HTMLElement | null>(null);
  const hint = ref<GestureHint | null>(null);

  let pointerId: number | null = null;
  let phase: "idle" | "press" | "vertical" | "seek" | "longpress" = "idle";
  let start = { x: 0, y: 0 };
  let side: GestureSide = "left";
  let baseLevel = 0;
  let baseTime = 0;
  let duration = 0;
  let lastTapAt: number | null = null;
  let longPressTimer: number | null = null;
  let pendingSingleTimer: number | null = null;
  let hintTimer: number | null = null;

  /// `autoClearMs` 给定时自动消失；不给则由调用方显式收起。
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

  function clearPendingSingle() {
    if (pendingSingleTimer !== null) {
      window.clearTimeout(pendingSingleTimer);
      pendingSingleTimer = null;
    }
  }

  function cancelLongPress() {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function detach() {
    // 注意：此处不能清 pendingSingleTimer —— 单击的 deferred onTap 必须活过 reset()，
    // 否则 onPointerUp 末尾的 reset()→detach() 会立刻把刚排好的单击定时器取消，单击永远不触发。
    // pendingSingleTimer 只在「双击判定成立」和「组件卸载」两处清理。
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

  /// 横滑 seek：dx 占满容器宽度 ≈ 拖动整段时长，按比例换算目标秒数。
  function updateSeek(dx: number) {
    if (!duration) return;
    const width = surface.value?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    const target = Math.min(
      Math.max(baseTime + (dx / width) * duration, 0),
      duration,
    );
    showHint({ kind: "seek", value: target, target });
    options.onSeekDrag?.(target);
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
      if (
        horizontalIntent(dx, dy) &&
        toValue(options.master ?? true) &&
        toValue(options.seekEnabled ?? false) &&
        options.readTime
      ) {
        const t = options.readTime();
        if (t.duration > 0) {
          phase = "seek";
          baseTime = t.currentTime;
          duration = t.duration;
          updateSeek(dx);
          return;
        }
      }
      // 既非竖滑也非可 seek 横滑：放弃手势，交给页面/系统
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
    } else if (phase === "seek") {
      updateSeek(dx);
    }
  }

  function onPointerUp(ev: PointerEvent) {
    if (pointerId === null || ev.pointerId !== pointerId) return;
    if (phase === "longpress") {
      options.onLongPress?.(false);
      showHint(null);
    } else if (phase === "vertical") {
      hideHintSoon();
    } else if (phase === "seek") {
      hideHintSoon();
    } else if (phase === "press") {
      // 轻点判定：单击与双击彻底区分（经典延迟法）。
      // - 单击：按下抬起后等 DOUBLE_TAP_WINDOW_MS(300ms)，确认没有第二下才触发 onTap；
      // - 双击：第二下在窗口内落下，立即触发 onDoubleTap，并取消第一下未决的 onTap。
      // 这样双击永远不会混入单击的 UI 切换（不闪、不误触），
      // 单击只是有 300ms 的固有等待，这是「单击/双击并存」的标准代价。
      const now = Date.now();
      if (isDoubleTap(lastTapAt, now)) {
        // 第二下：双击成立，第一下的单击判定作废
        clearPendingSingle();
        lastTapAt = null;
        options.onDoubleTap?.();
      } else {
        // 第一下（或与上次间隔已超窗）：先记账，延迟触发单击
        clearPendingSingle();
        lastTapAt = now;
        pendingSingleTimer = window.setTimeout(() => {
          pendingSingleTimer = null;
          options.onTap?.();
        }, DOUBLE_TAP_WINDOW_MS);
      }
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
    clearPendingSingle();
    if (hintTimer !== null) window.clearTimeout(hintTimer);
  });

  return { surface, hint, onDown };
}
