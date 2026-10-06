import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { listDirs } from "@/bridge/commands";
import { selectDirectory } from "@/bridge/dialog";
import type { DirEntryView } from "@/bridge/contracts";
import { usePlatform } from "@/platform";

/**
 * 移动端选目录。
 *
 * 背景：dialog 插件在移动端**没有目录选择器**（真机点击会 reject
 * `Folder picker is not implemented on mobile`），所以 Android 用「前端目录浏览 +
 * Rust `list_dirs`」替代，取到的仍是真实文件路径——扫描、指纹、播放链路都不必改。
 * 桌面端照旧走原生对话框。
 *
 * 平台判断只放在 [`useDirPickerStore.pick`] 里（技术方案 §3.3），调用方看到的仍然是
 * 「await 一下拿到路径」，两处入口不必各自关心差异。
 */
interface Crumb {
  name: string;
  /** null = 还没进任何目录，也就是存储根候选那一层 */
  path: string | null;
}

const ROOT_CRUMB: Crumb = { name: "存储", path: null };

export const useDirPickerStore = defineStore("dirPicker", () => {
  const open = ref(false);
  const loading = ref(false);
  const errorText = ref("");
  const entries = ref<DirEntryView[]>([]);
  const trail = ref<Crumb[]>([{ ...ROOT_CRUMB }]);

  let waiter: ((picked: string | null) => void) | null = null;

  const currentPath = computed<string | null>(
    () => trail.value[trail.value.length - 1]?.path ?? null,
  );
  const canGoUp = computed(() => trail.value.length > 1);
  /** 停在存储根候选那层不能确认——那还不是用户要的目录。 */
  const canConfirm = computed(() => currentPath.value !== null);

  async function load(path: string | null) {
    loading.value = true;
    errorText.value = "";
    try {
      entries.value = await listDirs(path);
    } catch (e) {
      // 读不到必须是错的形状：这里通常意味着没拿到存储权限，
      // 空数组会让人以为「这个目录是空的」，方向完全不同。
      errorText.value = `读不到这个目录：${String(e)}`;
      entries.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 收场：兑现等待者并把面板恢复到初始态。 */
  function settle(picked: string | null) {
    open.value = false;
    entries.value = [];
    errorText.value = "";
    trail.value = [{ ...ROOT_CRUMB }];
    const w = waiter;
    waiter = null;
    w?.(picked);
  }

  function enter(entry: DirEntryView) {
    trail.value.push({ name: entry.name, path: entry.path });
    void load(entry.path);
  }

  function up() {
    if (!canGoUp.value) return;
    trail.value.pop();
    void load(currentPath.value);
  }

  function cancel() {
    settle(null);
  }

  function confirmHere() {
    settle(currentPath.value);
  }

  /** 选一个目录；取消（或桌面关掉对话框）得到 null。 */
  function pick(): Promise<string | null> {
    if (!usePlatform().isAndroid) return selectDirectory();
    // 连点：上一次还没兑现，先把它结掉，免得两个 waiter 互相覆盖谁也不响
    settle(null);
    open.value = true;
    void load(null);
    return new Promise<string | null>((resolve) => {
      waiter = resolve;
    });
  }

  return {
    open,
    loading,
    errorText,
    entries,
    trail,
    currentPath,
    canGoUp,
    canConfirm,
    pick,
    enter,
    up,
    cancel,
    confirmHere,
  };
});
