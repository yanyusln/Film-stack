// 播放/续播的纯策略（技术方案 §8.6）。全部为纯函数，脱离 DOM 与 Pinia 可单测。
// 同名常量在 Rust 侧 `src-tauri/src/progress.rs`（TAIL_WINDOW_SEC）保持一致，两端同一套语义。

/** 末尾窗口：位于这里及其之后的进度不算「没看完」。 */
export const TAIL_WINDOW_SEC = 30;
/** 落库节流：每秒至多一次。 */
export const MIN_SAVE_INTERVAL_MS = 1000;
/** 距上次落库的位移阈值（秒）。 */
export const SAVE_MOVE_THRESHOLD_SEC = 5;

export type ResumeChoice = "resume" | "restart" | "cancel";
export type ResumePreference = "ask" | "resume" | "restart";
export type LoopMode = "off" | "single" | "list";
export type PlaybackRate = 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;

export const PLAYBACK_RATES: PlaybackRate[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface ResumeRequest {
  videoId: string;
  position: number;
  duration: number;
}

export interface ResumeDecision {
  /** resume / restart 直接执行；ask 需要弹窗；play 表示根本没有有效进度，直接从头播。 */
  action: "resume" | "restart" | "ask" | "play";
  /** 本次跳过询问（勾选「本次不再询问」后对同一个视频生效，不写全局偏好）。 */
  skip: boolean;
}

/**
 * 续播决策。
 * 注意：技术方案原伪码里 skipOnce 分支返回 `{ask, true}`（自相矛盾：既要问又要不问），
 * 这里按语义实现为「不再询问 = 不再询问」，默认按已记录的 position 续播，由使用者决定。
 */
export function decideResume(
  r: ResumeRequest,
  preference: ResumePreference,
  skipOnce = false,
): ResumeDecision {
  if (r.position <= 0 || r.duration <= 0) {
    return { action: "play", skip: false };
  }
  if (r.duration - r.position <= TAIL_WINDOW_SEC) {
    return { action: "restart", skip: false };
  }
  if (skipOnce) return { action: "resume", skip: true };
  if (preference === "resume") return { action: "resume", skip: false };
  if (preference === "restart") return { action: "restart", skip: false };
  return { action: "ask", skip: false };
}

/** 是否值得记录：末尾 30s 视为看完。 */
export function keepPosition(position: number, duration: number): boolean {
  return duration <= 0 || position < duration - TAIL_WINDOW_SEC;
}

export interface SaveGate {
  nowMs: number;
  lastSaveMs: number;
  lastSavedPosition: number;
  position: number;
  /** 播放/暂停/停止等状态切换，立即落库。 */
  stateChanged?: boolean;
  /** 拖动进度条：忽略节流，立刻写目标时间。 */
  immediate?: boolean;
}

/** 写库节流判定（技术方案 §8.6「保存策略」）。 */
export function shouldPersist(g: SaveGate): boolean {
  if (g.immediate) return true;
  if (g.nowMs - g.lastSaveMs < MIN_SAVE_INTERVAL_MS) return false;
  if (g.stateChanged) return true;
  return Math.abs(g.position - g.lastSavedPosition) >= SAVE_MOVE_THRESHOLD_SEC;
}

/**
 * 播放结束动作（技术方案 §8.6「结束策略」/ F22）。纯函数，便于单测。
 * - 单曲循环是用户显式选择，优先于开关：恒重播
 * - 开关关闭：停在当前时间且不进下一曲
 * - 开关开启：交给循环模式决定（列表循环到末尾回第一首，不循环则停）
 */
export type EndedAction = "replay" | "advance" | "pause";

export function endedAction(
  loop: LoopMode,
  autoAdvance: boolean,
  hasNext: boolean,
): EndedAction {
  if (loop === "single") return "replay";
  if (!autoAdvance) return "pause";
  return hasNext ? "advance" : "pause";
}

let naturalCollator: Intl.Collator | null | undefined;

/** 文件夹序用自然序：ep2 在 ep10 之前（`Intl.Collator({numeric:true})`，不可用时退化为字典序）。 */
export function naturalCompare(a: string, b: string): number {
  if (naturalCollator === undefined) {
    try {
      naturalCollator = new Intl.Collator("zh-Hans-CN", {
        numeric: true,
        sensitivity: "base",
      });
    } catch {
      naturalCollator = null;
    }
  }
  if (naturalCollator) return naturalCollator.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 文件夹序（F19「按文件属性排序」）：按文件名自然序，同名再按路径。
 * 分组序不调用它——分组以内建 `sort_order` 为准，重排会丢掉用户的拖拽结果。
 */
export function sortByFileName<T extends { name: string; path?: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (x, y) =>
      naturalCompare(x.name, y.name) ||
      naturalCompare(x.path ?? "", y.path ?? ""),
  );
}

/** 列表的下一个索引；loop 为 single 时原地返回。 */
export function nextIndex(
  index: number,
  length: number,
  loop: LoopMode,
): number | null {
  if (length <= 0) return null;
  if (loop === "single") return index;
  const next = index + 1;
  if (next < length) return next;
  return loop === "list" ? 0 : null;
}

export function prevIndex(index: number, length: number): number | null {
  if (length <= 0) return null;
  return index > 0 ? index - 1 : null;
}

/** 秒 -> 时:分:秒（>1h 才带小时）。 */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "00:00";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
