import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type {
  RootMeta,
  ScanInput,
  ScanSummary,
  ScanProgress,
} from "@/bridge/contracts";
import * as cmd from "@/bridge/commands";
import { useVideosStore } from "@/stores/videos";

// 扫描 store：任务生命周期、根目录、增量开关、进度文本（仅「扫描中 X/Y」）。（技术方案 §7.2）
export const useScanStore = defineStore("scan", () => {
  const roots = ref<RootMeta[]>([]);
  const phase = ref<"idle" | "scanning" | "done" | "error">("idle");
  const progress = ref<ScanProgress>({ processed: 0, total: 0 });
  const lastSummary = ref<ScanSummary | null>(null);
  const errorText = ref("");
  let currentTaskId = "";

  const isScanning = computed(() => phase.value === "scanning");
  const statusText = computed(() => {
    if (phase.value === "scanning") {
      return `扫描中 ${progress.value.processed}/${progress.value.total}`;
    }
    if (phase.value === "done" && lastSummary.value) {
      const s = lastSummary.value;
      const extra = s.errors.length ? ` · 失败 ${s.errors.length}` : "";
      // 失效 = 增量 diff 判定的失联条目（只标记不删，技术方案 §8.1）
      const gone = s.removed ? ` · 失效 ${s.removed}` : "";
      return `扫描完成 · 新增 ${s.added} · 更新 ${s.updated}${gone}${extra}`;
    }
    return "";
  });

  async function init() {
    try {
      roots.value = await cmd.listRoots();
    } catch (e) {
      errorText.value = `读取根目录失败：${String(e)}`;
      phase.value = "error";
    }
  }

  async function addRoots(paths: string[]) {
    if (paths.length === 0) return;
    try {
      const created = await cmd.addRoots(paths);
      roots.value = [...roots.value, ...created];
      await startScan({ roots: created.map((r) => r.id), mode: "incremental" });
    } catch (e) {
      errorText.value = `添加目录失败：${String(e)}`;
      phase.value = "error";
    }
  }

  async function removeRoot(rootId: string) {
    try {
      await cmd.removeRoot(rootId);
      roots.value = roots.value.filter((r) => r.id !== rootId);
    } catch (e) {
      errorText.value = `移除目录失败：${String(e)}`;
      phase.value = "error";
    }
  }

  /**
   * 扫描成功后把「侧栏计数 / 目录树 / 视频网格」一起拉到最新。
   *
   * 为什么必须放在这里：侧栏的目录树与网格来自内存里的 videos.items（只在点根目录时从
   * DB 拉一次），而侧栏计数走 list_roots，是两条独立的数据通路。扫描是分批提交事务的，
   * 用户完全可能在扫描途中就点了根目录——那时的快照只有前几批（实测恰好 3 个子目录），
   * 此后没人刷新，就会出现「计数 2511、树里只有 3 个目录」的自相矛盾（v1 实际反馈）。
   * 刷新失败不覆盖扫描本身的结果，扫描照常算完成。
   */
  async function refreshAfterScan(scannedRootIds: string[]) {
    try {
      roots.value = await cmd.listRoots();
    } catch {
      // 计数刷不到就保留旧值，视频列表照刷
    }
    const videos = useVideosStore();
    if (videos.selectedRootId) {
      // reload 而非 load：保留下钻到的目录与已选集合，别把人弹回根目录
      await videos.reload();
      return;
    }
    // 还没选中任何根：直接选中最相关的那个并加载，省掉用户再点一次
    const target =
      roots.value.find((r) => scannedRootIds.includes(r.id)) ?? roots.value[0];
    if (target) await videos.load(target.id);
  }

  async function startScan(opts: {
    roots?: string[];
    mode?: "incremental" | "manual";
  }) {
    const rootIds = opts.roots ?? roots.value.map((r) => r.id);
    if (rootIds.length === 0) return;
    phase.value = "scanning";
    errorText.value = "";
    progress.value = { processed: 0, total: 0 };
    currentTaskId = crypto.randomUUID();
    const input: ScanInput = {
      taskId: currentTaskId,
      rootIds,
      mode: opts.mode ?? "incremental",
      ignoreExt: [],
      maxDepth: 32,
    };
    try {
      const summary = await cmd.scanRoots(input, (p) => {
        progress.value = p;
      });
      lastSummary.value = summary;
      phase.value = "done";
      await refreshAfterScan(rootIds);
    } catch (e) {
      errorText.value = `扫描失败：${String(e)}`;
      phase.value = "error";
    }
  }

  function cancelScan() {
    if (currentTaskId) void cmd.cancelScan(currentTaskId);
  }

  function setRealtimeEnabled(v: boolean) {
    void cmd.setRealtime(v);
  }

  return {
    roots,
    phase,
    progress,
    lastSummary,
    errorText,
    isScanning,
    statusText,
    init,
    addRoots,
    removeRoot,
    startScan,
    cancelScan,
    setRealtimeEnabled,
  };
});
