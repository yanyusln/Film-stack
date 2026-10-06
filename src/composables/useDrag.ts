import { onUnmounted, ref, toValue } from "vue";
import type { MaybeRefOrGetter } from "vue";

// 三端拖拽适配器（W3-3a，技术方案 §8.4 / 组件规范表 sheet2「拖拽手柄」行）。
// 只负责手势判定与落点推导，不碰数据：提交由调用方走 store.applyOrder。
// 纯函数（tiltDegrees / evaluateGesture / resolveDropIndex）单独导出以便单测。

export type DragMode = "phone" | "pc" | "tablet";
export type DragAxis = "y" | "x" | "free";

// 移动 >8px 进入拖拽；倾斜角 手机 8° / 平板 10° / PC 12°。
// 注：技术方案 §8.4 表格中 PC 与手机两行的角度疑似写反，此处以组件规范表 + AGENTS §7 为准。
export const DRAG_MOVE_PX = 8;
export const DRAG_TILT_DEG: Record<DragMode, number> = {
  phone: 8,
  tablet: 10,
  pc: 12,
};

export type GesturePhase = "inactive" | "active" | "rejected";

export interface Point {
  x: number;
  y: number;
}

export interface GestureRule {
  tiltDeg: number;
  axis?: DragAxis;
  movePx?: number;
}

/// 与主拖拽轴的偏离角（度）。主轴位移为 0 时返回 90°，即判定为横向滚动而非拖拽。
export function tiltDegrees(dx: number, dy: number, axis: DragAxis): number {
  if (axis === "free") return 0;
  const [main, cross] =
    axis === "x" ? [Math.abs(dx), Math.abs(dy)] : [Math.abs(dy), Math.abs(dx)];
  if (main === 0) return 90;
  return (Math.atan2(cross, main) * 180) / Math.PI;
}

/// 手势判定：未过移动阈值 -> inactive；偏离角超限 -> rejected（交给页面滚动）；否则 active。
export function evaluateGesture(
  start: Point,
  current: Point,
  rule: GestureRule,
): GesturePhase {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (Math.hypot(dx, dy) < (rule.movePx ?? DRAG_MOVE_PX)) return "inactive";
  const axis = rule.axis ?? "y";
  return tiltDegrees(dx, dy, axis) > rule.tiltDeg ? "rejected" : "active";
}

export interface DragRect {
  index: number;
  mid: number;
}

/// 由当前指针位置推导落点：跨过某项中线的所有候选里取最远的一项。
export function resolveDropIndex(
  rects: DragRect[],
  from: number,
  value: number,
): number {
  let target = from;
  for (const r of rects) {
    if (r.index < from && value < r.mid) target = Math.min(target, r.index);
    else if (r.index > from && value > r.mid)
      target = Math.max(target, r.index);
  }
  return target;
}

export interface DragState {
  active: boolean;
  from: number;
  to: number;
  x: number;
  y: number;
}

export interface UseDragOptions {
  mode: MaybeRefOrGetter<DragMode>;
  axis?: DragAxis;
  // 落点元素属性名（默认 data-drop-index）。跨列拖拽时用它把「拖起源」与「落点」区分开。
  targetAttr?: string;
  // 手机端：仅编辑模式下可拖（关闭编辑时不进入拖拽）
  enabled?: MaybeRefOrGetter<boolean>;
  // 触屏长按激活时长（ms），默认 180；等效于 delayTouchStart
  touchDelayMs?: number;
  onMove?: (from: number, to: number) => void;
  // 返回 false 表示提交失败，调用方（store）已回滚，这里只负责复位拖拽态
  onCommit: (from: number, to: number) => Promise<boolean>;
}

const IDLE: DragState = { active: false, from: -1, to: -1, x: 0, y: 0 };

// 触屏长按激活时长：长按未满就滑动视为滚动意图
const TOUCH_DELAY_MS = 180;

export function useDrag(options: UseDragOptions) {
  const container = ref<HTMLElement | null>(null);
  const state = ref<DragState>({ ...IDLE });
  const axis: DragAxis = options.axis ?? "y";
  const dropSelector = `[${(options.targetAttr ?? "data-drop-index").replace(/^\[|\]$/g, "")}]`;
  const dropKey = dropSelector
    .slice(1, -1)
    .replace(/^data-/, "")
    .replace(/-([a-z])/g, (_all, c: string) => c.toUpperCase());

  let start: Point = { x: 0, y: 0 };
  let fromIndex = -1;
  let phase: "idle" | "arming" | "tracking" | "dragging" = "idle";
  let pointerId: number | null = null;
  let startTimer: number | null = null;
  let rects: DragRect[] = [];

  function detach() {
    if (startTimer !== null) {
      window.clearTimeout(startTimer);
      startTimer = null;
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", onKeyDown);
  }

  function collect(): DragRect[] {
    const root = container.value;
    if (!root) return [];
    const out: DragRect[] = [];
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>(dropSelector),
    )) {
      const raw = el.dataset[dropKey];
      if (raw === undefined) continue;
      const index = Number(raw);
      if (!Number.isFinite(index) || index < 0) continue;
      const box = el.getBoundingClientRect();
      out.push({
        index,
        mid: axis === "x" ? box.left + box.width / 2 : box.top + box.height / 2,
      });
    }
    return out;
  }

  /// 按下：记录起点。真正的拖拽要等「位移过阈值 + 未被判为滚动」，触屏还要先长按激活。
  function onDown(index: number, ev: PointerEvent) {
    if (!toValue(options.enabled ?? true)) return;
    // PC 仅响应左键；右键留给上下文菜单
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    start = { x: ev.clientX, y: ev.clientY };
    fromIndex = index;
    pointerId = ev.pointerId;
    if (ev.pointerType === "touch") {
      // 触屏长按激活：等价于 vue-draggable-plus 的 delayTouchStart（AGENTS §4），
      // 长按未满就滑动视为滚动意图，直接放弃本次拖拽。
      phase = "arming";
      startTimer = window.setTimeout(() => {
        startTimer = null;
        if (phase === "arming") phase = "tracking";
      }, options.touchDelayMs ?? TOUCH_DELAY_MS);
    } else {
      phase = "tracking";
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKeyDown);
  }

  function onPointerMove(ev: PointerEvent) {
    if (pointerId !== null && ev.pointerId !== pointerId) return;
    const cur = { x: ev.clientX, y: ev.clientY };
    if (phase === "arming") {
      // 长按未满已有位移 -> 用户想滚动，放弃拖拽
      if (Math.hypot(cur.x - start.x, cur.y - start.y) >= DRAG_MOVE_PX)
        cancel();
      return;
    }
    if (phase === "tracking") {
      const verdict = evaluateGesture(start, cur, {
        tiltDeg: DRAG_TILT_DEG[toValue(options.mode)],
        axis,
      });
      if (verdict === "inactive") return;
      if (verdict === "rejected") {
        cancel();
        return;
      }
      rects = collect();
      phase = "dragging";
      state.value = { active: true, from: fromIndex, to: fromIndex, ...cur };
    }
    if (phase !== "dragging") return;
    state.value = { ...state.value, x: cur.x, y: cur.y };
    const to = resolveDropIndex(rects, fromIndex, axis === "x" ? cur.x : cur.y);
    if (to !== state.value.to) {
      state.value.to = to;
      options.onMove?.(fromIndex, to);
    }
  }

  async function finish(commit: boolean) {
    detach();
    const { from, to } = state.value;
    phase = "idle";
    pointerId = null;
    state.value = { ...IDLE };
    if (commit && from >= 0 && to >= 0 && from !== to) {
      await options.onCommit(from, to);
    }
  }

  function onPointerUp(ev: PointerEvent) {
    if (pointerId !== null && ev.pointerId !== pointerId) return;
    void finish(phase === "dragging");
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === "Escape") cancel();
  }

  /// 取消：保留原顺序，不提交。Escape 与非拖拽手势均由这里收口。
  function cancel() {
    if (phase === "idle") return;
    detach();
    phase = "idle";
    pointerId = null;
    state.value = { ...IDLE };
    options.onMove?.(fromIndex, fromIndex);
  }

  onUnmounted(detach);

  return { container, state, onDown, cancel };
}
