import { defineStore } from "pinia";
import type { ResumePreference } from "@/composables/playbackPolicy";

// UI store：主题、编辑模式、全局 Toast、续播偏好、手势总控。（技术方案 §7.5）
type Theme = "light" | "dark";
export type ToastKind = "info" | "error";
/** 首页视图：全部视频（按目录树下钻的网格）/ 文件夹（文件夹卡片平铺）。 */
export type LibraryView = "all" | "folders";

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

interface UiState {
  theme: Theme;
  editMode: boolean;
  /** 侧栏「全部视频 / 文件夹」导航切的是它（技术方案 §9.1 三视图）。 */
  libraryView: LibraryView;
  resumePreference: ResumePreference;
  /** 手势总控：关闭后只保留点击与双击（技术方案 §8.5）。 */
  gestureEnabled: boolean;
  /** 结束策略开关（F22）：开启=按循环模式进下一曲；关闭=结束后暂停在当前时间。 */
  autoAdvance: boolean;
  toasts: ToastItem[];
}

// 排序/写入失败等瞬时反馈的停留时长（技术方案 §8.4：失败回滚 + toast）
const TOAST_MS = 2600;

const STORAGE_KEY = "filmstack.ui.v1";

interface Persisted {
  theme?: Theme;
  resumePreference?: ResumePreference;
  gestureEnabled?: boolean;
  autoAdvance?: boolean;
}

/** 没有存过偏好时跟随系统（技术方案 §10.1 亮/暗双套背景）。 */
function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

function readUi(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Persisted;
  } catch {
    return {};
  }
}

function writeUi(patch: Partial<Persisted>) {
  try {
    const next = { ...readUi(), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式/配额受限：内存态照常工作，不因落盘失败影响交互
  }
}

const persisted = readUi();

export const useUiStore = defineStore("ui", {
  state: (): UiState => ({
    theme: persisted.theme ?? (prefersDark() ? "dark" : "light"),
    editMode: false,
    libraryView: "all",
    resumePreference: persisted.resumePreference ?? "ask",
    gestureEnabled: persisted.gestureEnabled ?? true,
    autoAdvance: persisted.autoAdvance ?? true,
    toasts: [],
  }),
  actions: {
    notify(text: string, kind: ToastKind = "info") {
      const id = Date.now() + Math.random();
      this.toasts.push({ id, text, kind });
      window.setTimeout(() => this.dismiss(id), TOAST_MS);
    },
    dismiss(id: number) {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    },
    setResumePreference(pref: ResumePreference) {
      this.resumePreference = pref;
      writeUi({ resumePreference: pref });
    },
    setGestureEnabled(enabled: boolean) {
      this.gestureEnabled = enabled;
      writeUi({ gestureEnabled: enabled });
    },
    setAutoAdvance(enabled: boolean) {
      this.autoAdvance = enabled;
      writeUi({ autoAdvance: enabled });
    },
    setTheme(theme: Theme) {
      this.theme = theme;
      writeUi({ theme });
    },
    setLibraryView(view: LibraryView) {
      this.libraryView = view;
    },
  },
});
