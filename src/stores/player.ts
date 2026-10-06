import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as cmd from "@/bridge/commands";
import type {
  AssetGrant,
  PlayProgress,
  RemuxProgress,
  VideoProbe,
} from "@/bridge/contracts";
import { useUiStore } from "@/stores/ui";
import { usePlatform } from "@/platform";
import { unplayableContainerLabel } from "@/composables/containerSupport";
import {
  decideResume,
  endedAction,
  keepPosition,
  nextIndex,
  prevIndex,
  shouldPersist,
  sortByFileName,
  type LoopMode,
  type PlaybackRate,
} from "@/composables/playbackPolicy";

// 播放列表最小契约：文件夹视图的 VideoRecord 与分组视图的 VideoMeta 都能喂进来。
export interface PlaylistItem {
  id: string;
  name: string;
  path: string;
  duration?: number | null;
  /** 真实容器（扫描时读文件头，非扩展名）：进播放页前就能判断放不放得了，不必先失败一次 */
  container?: string | null;
}

// 播放 store（W4 / 技术方案 §7.4）：会话状态 + 播放列表 + 进度节流落库。
// DOM 由视图持有并通过 attach() 注册进来，避免 store 直接操作 Document。
export const usePlayerStore = defineStore("player", () => {
  const ui = useUiStore();
  const playlist = ref<PlaylistItem[]>([]);
  const sourceKind = ref<"folder" | "group">("folder");
  const sourceLabel = ref("");
  const index = ref(-1);
  const rate = ref<PlaybackRate>(1);
  const volume = ref(1);
  const muted = ref(false);
  const locked = ref(false);
  const controlsVisible = ref(true);
  const loopMode = ref<LoopMode>("list");
  const currentTime = ref(0);
  const duration = ref(0);
  const playing = ref(false);
  const errorText = ref("");
  const progress = ref<PlayProgress | null>(null);
  // 当前视频的 asset 放行结果：播放失败时原样给到界面，便于判断是「没放行」还是「编码不支持」
  const assetGrant = ref<AssetGrant | null>(null);
  // 播放失败后的自检结果（文件在不在 / 什么编码）
  const probeResult = ref<VideoProbe | null>(null);
  // 转封装：产物在应用缓存里，源文件一个字节都不动（C1）
  // `preparing`：授权 / 读进度 / 自检这一小段「还没决定怎么播」的时间。
  // 真机反馈「点了 AVI 先停顿一下」——这一段的 src 也必须为空，否则 `<video>`
  // 会拿着放不了的原文件先请求一次，闪出「源不可用」再突然能播。
  const remuxState = ref<"idle" | "preparing" | "working" | "ready" | "failed">(
    "idle",
  );
  const remuxPath = ref<string | null>(null);
  // 失败原因必须带到界面上：**静默失败排查代价太大**——真机曾出现「转封装秒失败、
  // 界面只回退到手动命令」，从表现上完全看不出是 ffmpeg 参数错还是没装，
  // 只能靠翻缓存目录反推。原因码直接显示，下次一眼定位。
  const remuxReason = ref<string | null>(null);
  // 流式进度（整文件读写，慢盘上大文件能跑几十秒）：只用于界面显示，不落库
  const remuxProgress = ref<RemuxProgress | null>(null);
  // 「本次不再询问」只对当前打开的视频生效，不写全局偏好（技术方案 §8.6）
  const skipOnceIds = ref<Record<string, boolean>>({});

  let el: HTMLVideoElement | null = null;
  let lastSaveMs = 0;
  let lastSavedPosition = 0;

  const current = computed(() => playlist.value[index.value] ?? null);
  const title = computed(() => current.value?.name ?? "");
  // 转封装成功后播缓存里的那份；否则播原文件（放不了时由界面给结论）
  const src = computed(() => {
    const v = current.value;
    if (!v) return null;
    // 转封装进行中**不给 src**：`<video>` 一拿到 src 就立刻发请求，此时拿到的还是
    // 放不了的原文件 →「先闪一次加载失败，过一会儿又突然能播」。真机反馈的观感正是这个。
    // 转好再切源，用户看到的是「准备中 → 播放」，因果连贯。
    if (remuxState.value === "preparing" || remuxState.value === "working")
      return null;
    return convertFileSrc(remuxPath.value ?? v.path);
  });
  const hasPrev = computed(
    () => prevIndex(index.value, playlist.value.length) !== null,
  );
  const hasNext = computed(
    () =>
      nextIndex(index.value, playlist.value.length, loopMode.value) !== null,
  );

  function attach(node: HTMLVideoElement | null) {
    el = node;
  }

  async function openPlaylist(
    list: PlaylistItem[],
    kind: "folder" | "group",
    label: string,
    startId: string,
  ) {
    // ① 分组序 = 内建 sort_order（后端已排好，重排会丢掉用户的拖拽结果）
    // ② 文件夹序 = 文件属性序：文件名自然序，ep2 排在 ep10 之前（F19）
    playlist.value = kind === "folder" ? sortByFileName(list) : [...list];
    sourceKind.value = kind;
    sourceLabel.value = label;
    // 下标必须在「排好序」的列表上找：文件夹序做过自然序重排，
    // 拿原始入参的 findIndex 会指到别的视频（点 ep2 却播了 ep10）。
    index.value = playlist.value.findIndex((v) => v.id === startId);
    if (index.value < 0) index.value = playlist.value.length ? 0 : -1;
    if (index.value >= 0) await openIndex(index.value);
  }

  /**
   * 每次打开自增：首页 / 分组页点击后不再等异步链路走完才跳路由，
   * 于是「连点两张卡片」真的会并发——必须让后到的作数、先到的中途退出。
   */
  let openToken = 0;

  async function openIndex(i: number) {
    const token = ++openToken;
    const next = playlist.value[i] ?? null;
    // 下标与状态**同步**落地：调用方（首页 / 分组页）不再等这条链走完才跳路由，
    // 播放页一挂载就必须显示正确的标题与路径，不能残留上一部。
    index.value = i;
    currentTime.value = 0;
    duration.value = 0;
    lastSaveMs = 0;
    lastSavedPosition = 0;
    // 同步挂「准备中」——但**只在已知容器放不了时**（AVI 这类）：
    // 这样 src 立刻变 null，`<video>` 不会拿着放不了的原文件先请求一次
    // （那一下会闪「源不可用」并触发一次自检，真机反馈的「点击停顿」里就有它）。
    // 普通 MP4 走 idle，保持「点了就播」，不白闪一层准备态。
    remuxState.value = unplayableContainerLabel(next?.container ?? null)
      ? "preparing"
      : "idle";
    remuxReason.value = null;
    remuxProgress.value = null;
    remuxPath.value = null;
    probeResult.value = null;
    // ① 先补齐 asset 授权再切源：`<video>` 一拿到 src 就会立刻发请求，
    //    放行慢一步就是 MEDIA_ERR_SRC_NOT_SUPPORTED（真机表现为「加载失败」）。
    // ② 根目录可能是本次会话之外写进库的（旧数据/别的入口），每次开播都补一次，已放行是幂等短回路。
    assetGrant.value = next ? await ensureAsset(next) : null;
    // 中途被另一次打开取代就退出：连点两张卡片时，两次授权 / 转封装不能互相覆盖
    if (token !== openToken) return;
    await loadProgress();
    if (token !== openToken) return;
    await prepareSource();
  }

  /**
   * 容器放不了就**进页面立刻转**，不让用户先看一次失败——库里已经记了容器，
   * 没理由等 `<video>` 报错才知道。产物进应用缓存，源文件不动。
   *
   * 老数据（container 为 NULL，没重扫过）走播放失败后的自检兜底：那时
   * `probeResult.suggestCommand` 会说话，同一条路径再进来一次。
   */
  async function prepareSource() {
    const v = current.value;
    if (!v) {
      remuxState.value = "idle";
      return;
    }
    if (remuxState.value === "ready") return;
    const blocked =
      !!unplayableContainerLabel(v.container ?? null) ||
      !!probeResult.value?.suggestCommand;
    if (!blocked) {
      // 不用转：准备结束，放行原路径（src 从此不再被拦）
      remuxState.value = "idle";
      return;
    }
    remuxState.value = "working";
    remuxReason.value = null;
    remuxProgress.value = null;
    const r = await cmd
      .remuxToCache(v.path, (p) => {
        remuxProgress.value = p;
      })
      .catch(() => null);
    if (r?.path) {
      remuxPath.value = r.path;
      remuxState.value = "ready";
      remuxProgress.value = null;
    } else {
      // `reason` 是 Rust 给的原因码（ffmpeg_missing / ffmpeg_failed / timeout …）；
      // invoke 本身抛错（命令没注册、参数序列化失败）时 `r` 为 null，单独记，
      // 这两种在界面上必须能区分——不然又要靠翻缓存目录反推。
      remuxReason.value = r ? (r.reason ?? r.status) : "invoke_failed";
      remuxState.value = "failed";
    }
  }

  async function loadProgress() {
    const v = current.value;
    progress.value = null;
    if (!v) return;
    try {
      progress.value = await cmd.getProgress(v.id);
    } catch {
      progress.value = null;
    }
  }

  /** 打开视频后由视图调用：返回该从哪开始播，是否要弹续播。 */
  function resumeDecision(): {
    action: "resume" | "restart" | "ask" | "play";
    skip: boolean;
  } {
    const p = progress.value;
    if (!p) return { action: "play", skip: false };
    return decideResume(
      { videoId: p.videoId, position: p.position, duration: p.duration },
      ui.resumePreference,
      skipOnceIds.value[p.videoId] ?? false,
    );
  }

  function markSkipOnce() {
    const v = current.value;
    if (v) skipOnceIds.value = { ...skipOnceIds.value, [v.id]: true };
  }

  function toggle() {
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }

  function seek(delta: number) {
    if (!el) return;
    seekTo(el.currentTime + delta);
  }

  function seekTo(sec: number) {
    if (!el) return;
    const max = el.duration || duration.value || 0;
    const next = Math.min(Math.max(sec, 0), max || sec);
    el.currentTime = next;
    currentTime.value = next;
    // 拖动立即写目标时间（技术方案 §8.6）
    void persist(true);
  }

  function setRate(r: PlaybackRate) {
    rate.value = r;
    if (el) el.playbackRate = r;
  }

  function setVolume(v: number) {
    volume.value = Math.min(Math.max(v, 0), 1);
    if (el) {
      el.volume = volume.value;
      el.muted = muted.value;
    }
  }

  function toggleMute() {
    muted.value = !muted.value;
    if (el) el.muted = muted.value;
  }

  function setLoopMode(mode: LoopMode) {
    loopMode.value = mode;
  }

  function onMeta(dur: number) {
    duration.value = dur;
    if (el) {
      el.playbackRate = rate.value;
      el.volume = volume.value;
      el.muted = muted.value;
    }
  }

  function onTimeUpdate(t: number) {
    currentTime.value = t;
    maybePersist(false, false);
  }

  function onPlayStateChanged(isPlaying: boolean) {
    playing.value = isPlaying;
    maybePersist(true, false);
  }

  function maybePersist(stateChanged: boolean, immediate: boolean) {
    const gate = {
      nowMs: Date.now(),
      lastSaveMs,
      lastSavedPosition,
      position: currentTime.value,
      stateChanged,
      immediate,
    };
    if (!shouldPersist(gate)) return;
    void persist(immediate);
  }

  /** 写库：末尾 30s 由后端自动清库。 */
  async function persist(immediate = false) {
    const v = current.value;
    if (!v) return false;
    const pos = currentTime.value;
    const dur = duration.value;
    if (!immediate && !keepPosition(pos, dur)) return false;
    lastSaveMs = Date.now();
    lastSavedPosition = pos;
    try {
      return await cmd.saveProgress(v.id, pos, dur);
    } catch {
      return false;
    }
  }

  /**
   * 播完：单曲循环重播；开关关闭时停在当前时间；其余交给循环模式（F22）。
   * 落库的位置若已进末尾 30s，后端会自动清库——看完的片下次从头开始。
   */
  async function onEnded() {
    const next = nextIndex(index.value, playlist.value.length, loopMode.value);
    const action = endedAction(loopMode.value, ui.autoAdvance, next !== null);
    if (action === "replay") {
      if (el) {
        el.currentTime = 0;
        void el.play().catch(() => undefined);
      }
      return;
    }
    if (action === "pause" || next === null) {
      playing.value = false;
      await persist(true);
      return;
    }
    await clearCurrentProgress();
    await openIndex(next);
  }

  async function playNext() {
    const next = nextIndex(index.value, playlist.value.length, loopMode.value);
    if (next === null) return;
    await persist(true);
    await openIndex(next);
  }

  async function playPrev() {
    const prev = prevIndex(index.value, playlist.value.length);
    if (prev === null) return;
    await persist(true);
    await openIndex(prev);
  }

  async function clearCurrentProgress() {
    const v = current.value;
    if (!v) return;
    progress.value = null;
    await cmd.clearProgress(v.id).catch(() => undefined);
  }

  /**
   * 播放失败后自检：只读读文件头，回答「文件在不在 / 多大 / 什么编码」。
   * 授权没问题却仍「源不可用」时，这就是唯一能自证是编码问题的手段。
   */
  async function diagnose() {
    const v = current.value;
    probeResult.value = null;
    if (!v) return;
    probeResult.value = await cmd.probeVideo(v.path).catch(() => null);
  }

  /** 离开播放页前务必调用：兜住最后一次未达阈值的位置。 */
  async function close() {
    await persist(true);
    playing.value = false;
  }

  return {
    playlist,
    sourceKind,
    sourceLabel,
    index,
    rate,
    volume,
    muted,
    locked,
    controlsVisible,
    loopMode,
    currentTime,
    duration,
    playing,
    errorText,
    progress,
    assetGrant,
    probeResult,
    remuxState,
    remuxPath,
    remuxReason,
    remuxProgress,
    current,
    title,
    src,
    hasPrev,
    hasNext,
    attach,
    openPlaylist,
    openIndex,
    loadProgress,
    diagnose,
    prepareSource,
    resumeDecision,
    markSkipOnce,
    toggle,
    seek,
    seekTo,
    setRate,
    setVolume,
    toggleMute,
    setLoopMode,
    onMeta,
    onTimeUpdate,
    onPlayStateChanged,
    persist,
    onEnded,
    playNext,
    playPrev,
    close,
  };
});

function dirOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "") || path;
}

/**
 * 播放前补齐 asset 协议授权：先放行文件所在目录（递归，与根目录同一条规则），
 * 目录这层没成功（规则表未覆盖、路径被判定为保护目录等）就退一步只放行这一个文件。
 * 两条都拿不到结果时返回最后一次的 reason，交给界面做分诊展示。
 */
async function ensureAsset(v: PlaylistItem): Promise<AssetGrant | null> {
  // Android / iOS 上这套机制是 no-op（assets.rs::dynamic_grant_supported 恒为 false），
  // 调了也只拿回 skipped_mobile——省掉开播路上这两次 IPC，也避免界面把它当成"未放行"。
  if (!usePlatform().needsAssetGrant) return null;
  const dir = dirOf(v.path);
  const byDir = await cmd.grantAssetRoot(dir).catch(() => null);
  if (byDir && (byDir.applied || byDir.reason === "already_allowed")) {
    return byDir;
  }
  const byFile = await cmd.grantAssetRoot(v.path).catch(() => null);
  return byFile ?? byDir;
}
