<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { storeToRefs } from "pinia";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import { usePlatform } from "@/platform";
import { useResponsive } from "@/composables/usePlatform";
import { useAutoHide } from "@/composables/useAutoHide";
import { useCompatibility } from "@/composables/compatibility";
import { TEMP_RATE, useEdgeGesture } from "@/composables/useEdgeGesture";
import { keepPosition, type PlaybackRate } from "@/composables/playbackPolicy";
import {
  mediaErrorText,
  probeSummary,
  remuxHelp,
  remuxReasonText,
} from "@/composables/mediaError";
import { unplayableContainerLabel } from "@/composables/containerSupport";
import AppIcon from "@/components/AppIcon.vue";
import PlayerControls from "@/components/PlayerControls.vue";
import PlaylistPanel from "@/components/PlaylistPanel.vue";
import ResumeDialog from "@/components/ResumeDialog.vue";

// 播放页（W4-a/W4-b，技术方案 §8.5 / §8.6）：
// ①资源 URL ②续播决策 ③控制栏 3s 淡出 ④手势层（点击/双击±10s/长按 2x/左右竖滑） ⑤锁屏层 ⑥Android 画中画。
const player = usePlayerStore();
const uiStore = useUiStore();
const platform = usePlatform();
const { layout } = useResponsive();
const {
  src,
  current,
  title,
  playing,
  currentTime,
  duration,
  rate,
  volume,
  muted,
  locked,
  loopMode,
  hasPrev,
  hasNext,
  progress,
  playlist,
  index,
  sourceKind,
  sourceLabel,
} = storeToRefs(player);
const { gestureEnabled } = storeToRefs(uiStore);

const video = ref<HTMLVideoElement | null>(null);
const resumeOpen = ref(false);
const errorText = ref("");
// 转换命令的一键复制：只复制字符串，应用不执行 ffmpeg、不碰磁盘
const copied = ref(false);
// 能力矩阵（技术方案 §8.5）：不支持的能力按降级表处理，不隐藏核心播放
const { caps } = useCompatibility();

// 转封装进度的人话：几十秒的等待必须有数字在动，否则看着就是卡死
const remuxText = computed(() => {
  const p = player.remuxProgress;
  if (!p) return null;
  const mb = (b: number) => Math.round(b / 1024 / 1024);
  return `${p.pct}% · ${mb(p.done)} / ${mb(p.total)} MB`;
});
const remuxContainerLabel = computed(() =>
  unplayableContainerLabel(current.value?.container ?? null),
);
// 全屏 API 不可用时的降级形态：页面内铺满（见 onFullscreen）
const fakeFullscreen = ref(false);
// 亮度是应用层遮罩（不改系统背光）：桌面与未接原生亮度的 Android 行为一致
const brightness = ref(1);
const pipActive = ref(false);

const {
  visible: controlsVisible,
  bump: bumpControls,
  hide: hideControls,
} = useAutoHide();

let rateBeforeLongPress: PlaybackRate = 1;

// 竖滑只给触屏：PC 控制栏已有横向音量条，鼠标竖直拖动不应抢事件
const lastPointerIsTouch = ref(platform.isAndroid);
const verticalEnabled = computed(
  () => layout.value !== "pc" && lastPointerIsTouch.value,
);

function onSurfaceDown(ev: PointerEvent) {
  lastPointerIsTouch.value = ev.pointerType === "touch" || platform.isAndroid;
  if (!locked.value && !pipActive.value) onGestureDown(ev);
}

const {
  surface: gestureSurface,
  hint: gestureHint,
  onDown: onGestureDown,
} = useEdgeGesture({
  master: gestureEnabled,
  verticalEnabled,
  readLevel: (side) =>
    side === "left" ? brightness.value : muted.value ? 0 : volume.value,
  onTap: () => {
    player.toggle();
    bumpControls();
  },
  onSeekStep: (sec) => {
    player.seek(sec);
    bumpControls();
  },
  onLongPress: (active) => {
    if (active) {
      rateBeforeLongPress = rate.value;
      player.setRate(TEMP_RATE as PlaybackRate);
    } else {
      player.setRate(rateBeforeLongPress);
    }
    bumpControls();
  },
  onLevelChange: (side, level) => {
    if (side === "left") {
      brightness.value = level;
      return;
    }
    if (muted.value && level > 0) player.toggleMute();
    player.setVolume(level);
    bumpControls();
  },
});

const hintText = computed(() => {
  const h = gestureHint.value;
  if (!h) return "";
  if (h.kind === "seek")
    return h.value > 0 ? `${h.value}s →` : `← ${-h.value}s`;
  if (h.kind === "rate") return `${h.value}x 加速中`;
  return "";
});

/** 左亮度 / 右音量的竖向指示条；只在对应手势进行中出现。 */
const sliderHint = computed(() => {
  const h = gestureHint.value;
  if (!h || !h.side) return null;
  if (h.kind !== "volume" && h.kind !== "brightness") return null;
  return { kind: h.kind, side: h.side, value: h.value };
});

const resumePosition = computed(() =>
  progress.value &&
  keepPosition(progress.value.position, progress.value.duration)
    ? progress.value.position
    : 0,
);

// 画中画按钮：能力矩阵说不支持就干脆不出现（PC V1 不做、Android WebView 不支持）
const pipVisible = computed(() => caps.value.pip.supported && !pipActive.value);

/**
 * 放不了的容器点名到具体格式（`AVI` / `MKV` …）：用户看到的必须是「AVI 放不了」，
 * 而不是一句笼统的「自动转封装不可用」——真机反馈里那句小灰字被当成了没提示。
 * 库里没记容器（老数据）时用自检结果兜底，都没有才退回「该文件」。
 */
const blockedContainer = computed(
  () =>
    unplayableContainerLabel(player.current?.container ?? null) ??
    unplayableContainerLabel(player.probeResult?.container ?? null) ??
    "该文件",
);

/**
 * 播放失败分诊：`<video>` 的 `error.code` 本身就能区分「源不可用 / 解码失败 / 读取失败」，
 * 再拼上 asset 协议的放行结果——真机上不必靠猜（v1 反馈的「加载失败」就是把三种原因揉成一句）。
 */
function onMediaError(ev: Event) {
  const el = ev.target as HTMLVideoElement;
  // 准备期间根本没有源：`<video>` 此时报的错是「没东西可播」，不是「这个文件放不了」。
  // 不拦的话会闪一句错误提示 + 白跑一次自检。
  if (!src.value) return;
  errorText.value = mediaErrorText(el.error?.code ?? 0, player.assetGrant);
  // 顺手自检：授权没问题却仍「源不可用」时，只有查出编码才能自证；
  // 自检说"救得回"就补一次转封装（老数据 container 为 NULL 时走的正是这条兜底）
  void player.diagnose().then(() => player.prepareSource());
}

function tryPlay() {
  const el = video.value;
  if (!el) return;
  void el.play().catch((e: unknown) => {
    errorText.value = `无法播放：${String(e)}`;
  });
}

// 元数据到手后才做续播决策：此时 duration 已知，能判断是不是落在末尾 30s
function onLoadedMetadata() {
  const el = video.value;
  if (!el) return;
  player.onMeta(el.duration);
  const decision = player.resumeDecision();
  if (decision.action === "ask") {
    resumeOpen.value = true;
    return;
  }
  if (decision.action === "resume") {
    el.currentTime = resumePosition.value;
  }
  tryPlay();
  bumpControls();
}

function playFrom(seconds: number) {
  const el = video.value;
  resumeOpen.value = false;
  if (!el) return;
  el.currentTime = seconds;
  tryPlay();
  bumpControls();
}

function onResume(skipOnce: boolean) {
  if (skipOnce) player.markSkipOnce();
  playFrom(resumePosition.value);
}

function onRestart() {
  playFrom(0);
}

function onCancel() {
  resumeOpen.value = false;
  bumpControls();
}

// 降级表：全屏 API 不可用时不隐藏按钮，改为页面内铺满（技术方案 §8.5）
async function onFullscreen() {
  const box = video.value?.parentElement;
  if (!box) return;
  if (!caps.value.fullscreen.supported) {
    fakeFullscreen.value = !fakeFullscreen.value;
    return;
  }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await box.requestFullscreen();
  } catch {
    fakeFullscreen.value = true;
    uiStore.notify("当前环境不支持全屏，已改为页面内铺满", "info");
  }
}

async function onPip() {
  if (!caps.value.pip.supported) {
    uiStore.notify(caps.value.pip.reason || "当前环境不支持画中画", "error");
    return;
  }
  const ok = await platform.enterPip(video.value);
  if (!ok) uiStore.notify("当前环境不支持画中画", "error");
}

// 锁屏层（防误触）+ F16 横屏锁：方向锁只在 Android 全屏下有意义，失败静默
async function toggleLock() {
  player.locked = !player.locked;
  const ok = await platform.lockOrientation(player.locked);
  if (
    player.locked &&
    !ok &&
    platform.isAndroid &&
    document.fullscreenElement
  ) {
    uiStore.notify("当前环境不支持锁定横屏", "info");
  }
  if (!player.locked) bumpControls();
}

// 面板直接跳转：先落库当前进度，再切源（与上一首/下一首同一条路径）
async function onSelectPlaylist(i: number) {
  if (i === index.value) return;
  await player.persist(true);
  await player.openIndex(i);
}

function onKeyDown(ev: KeyboardEvent) {
  const target = ev.target as HTMLElement | null;
  if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
    return;
  if (ev.key === " ") {
    ev.preventDefault();
    player.toggle();
  } else if (ev.key === "ArrowLeft") {
    player.seek(-5);
  } else if (ev.key === "ArrowRight") {
    player.seek(5);
  } else if (ev.key === "ArrowUp") {
    player.setVolume(volume.value + 0.05);
  } else if (ev.key === "ArrowDown") {
    player.setVolume(volume.value - 0.05);
  } else if (ev.key === "f") {
    void onFullscreen();
  } else if (ev.key === "Escape" && fakeFullscreen.value) {
    fakeFullscreen.value = false;
  } else if (ev.key === "Escape" && player.locked) {
    player.locked = false;
  }
  bumpControls();
}

function onPipEnter() {
  pipActive.value = true;
  // 进入画中画后委托系统控制，自定义控制栏收起
  hideControls();
}

function onPipLeave() {
  pipActive.value = false;
  bumpControls();
}

watch(video, (el, prev) => {
  prev?.removeEventListener("enterpictureinpicture", onPipEnter);
  prev?.removeEventListener("leavepictureinpicture", onPipLeave);
  el?.addEventListener("enterpictureinpicture", onPipEnter);
  el?.addEventListener("leavepictureinpicture", onPipLeave);
  player.attach(el);
});

async function copyCommand() {
  const cmd = player.probeResult?.suggestCommand;
  if (!cmd) return;
  try {
    await navigator.clipboard.writeText(cmd);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false; // 复制不了也不慌：命令本身就显示在上面，可手动选中
  }
}

watch(src, () => {
  resumeOpen.value = false;
  errorText.value = "";
  copied.value = false;
  brightness.value = 1;
  bumpControls();
});

onMounted(() => {
  player.attach(video.value);
  if (current.value) bumpControls();
  window.addEventListener("keydown", onKeyDown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  video.value?.removeEventListener("enterpictureinpicture", onPipEnter);
  video.value?.removeEventListener("leavepictureinpicture", onPipLeave);
  player.attach(null);
  void player.close();
});
</script>

<template>
  <section class="space-y-3">
    <header class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="truncate text-base font-semibold text-ink-1">
          {{ title || "播放器" }}
        </h1>
        <p class="truncate text-xs text-ink-2">
          {{ current?.path ?? "还没有选择影片" }}
        </p>
      </div>
      <RouterLink
        to="/"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn text-ink-2 transition-colors duration-200 ease-out hover:text-ink-1"
        aria-label="返回影片库"
        title="返回影片库"
      >
        <AppIcon name="arrow-left" :size="20" />
      </RouterLink>
    </header>

    <div
      v-if="!current"
      class="space-y-3 rounded-card bg-bg-elev p-6 text-center"
    >
      <p class="text-sm text-ink-2">还没有选择影片。</p>
      <RouterLink to="/" class="text-sm text-pink">去影片库挑一个</RouterLink>
    </div>

    <div
      v-else
      class="overflow-hidden bg-black"
      :class="
        fakeFullscreen
          ? 'fixed inset-0 z-50'
          : 'relative aspect-video w-full rounded-card'
      "
      @pointermove="bumpControls"
      @pointerleave="hideControls"
    >
      <video
        ref="video"
        :src="src ?? undefined"
        class="h-full w-full"
        playsinline
        preload="metadata"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="
          player.onTimeUpdate(($event.target as HTMLVideoElement).currentTime)
        "
        @play="player.onPlayStateChanged(true)"
        @pause="player.onPlayStateChanged(false)"
        @ended="player.onEnded()"
        @error="onMediaError"
      />

      <!-- 准备 / 转封装期间盖住画面：没有这一层，用户看到的就是「点了没反应，过一会儿突然开始播」 -->
      <div
        v-if="
          player.remuxState === 'preparing' || player.remuxState === 'working'
        "
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 px-6 text-center text-white"
      >
        <AppIcon name="refresh-cw" :size="28" class="animate-spin" />
        <p v-if="player.remuxState === 'working'" class="text-sm font-medium">
          正在把 {{ remuxContainerLabel ?? "该文件" }} 转成可播格式…
        </p>
        <p v-else class="text-sm font-medium">正在准备播放…</p>
        <p v-if="player.remuxState === 'working'" class="text-xs text-white/70">
          首次播放需要转一次（原文件不动），之后直接播缓存里的那份
        </p>
        <progress
          v-if="player.remuxProgress"
          class="mt-1 h-1 w-56"
          max="100"
          :value="player.remuxProgress.pct"
          style="accent-color: var(--pink)"
        />
        <p v-if="remuxText" class="text-xs tabular-nums text-white/70">
          {{ remuxText }}
        </p>
      </div>

      <!-- 亮度遮罩：应用层层蒙版，左侧半屏上滑提亮 -->
      <div
        v-if="brightness < 1"
        class="pointer-events-none absolute inset-0 bg-black"
        :style="{ opacity: 1 - brightness }"
      />

      <!-- 手势层：接管点击/双击/长按/竖滑；锁定时不存在 -->
      <div
        v-if="!locked && !pipActive"
        ref="gestureSurface"
        class="absolute inset-0"
        style="touch-action: none"
        @pointerdown="onSurfaceDown"
      />

      <!-- 竖滑指示：左亮度 / 右音量 -->
      <template v-if="sliderHint">
        <div
          class="pointer-events-none absolute bottom-1/2 top-1/2 flex w-14 translate-y-1 flex-col items-center gap-2 px-2"
          :class="sliderHint.side === 'left' ? 'left-2' : 'right-2'"
        >
          <span class="text-xs text-white/80">
            {{ sliderHint.kind === "brightness" ? "亮度" : "音量" }}
          </span>
          <div
            class="flex h-28 w-2 flex-col justify-end rounded-btn bg-white/20"
          >
            <div
              class="w-full rounded-btn"
              :style="{
                height: `${Math.round(sliderHint.value * 100)}%`,
                background: 'var(--pink)',
              }"
            />
          </div>
        </div>
      </template>

      <!-- 中央提示：双击 ±10s / 长按 2x -->
      <div
        v-if="hintText"
        class="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <span class="rounded-btn bg-black/60 px-3 py-1 text-sm text-white">
          {{ hintText }}
        </span>
      </div>

      <!-- 锁屏层：只留解锁，其余交互全部屏蔽 -->
      <div
        v-if="locked"
        class="absolute inset-0 flex items-center justify-center bg-black/30"
      >
        <button
          class="rounded-btn bg-black/60 px-4 py-2 text-sm text-white"
          @click="toggleLock"
        >
          已锁定，点击解锁
        </button>
      </div>

      <PlayerControls
        :playing="playing"
        :current-time="currentTime"
        :duration="duration"
        :rate="rate"
        :volume="volume"
        :muted="muted"
        :loop-mode="loopMode"
        :has-prev="hasPrev"
        :has-next="hasNext"
        :visible="(controlsVisible || !playing) && !locked && !pipActive"
        :locked="locked"
        :pip-visible="pipVisible"
        @toggle="player.toggle()"
        @seek="player.seek($event)"
        @seek-to="player.seekTo($event)"
        @set-rate="player.setRate($event as PlaybackRate)"
        @set-volume="player.setVolume($event)"
        @toggle-mute="player.toggleMute()"
        @prev="player.playPrev()"
        @next="player.playNext()"
        @set-loop="player.setLoopMode($event)"
        @fullscreen="onFullscreen()"
        @toggle-lock="toggleLock()"
        @pip="onPip()"
      />
    </div>

    <!-- 进度与说明都在画面上的遮罩里，这里不再重复一遍（省得两处文案不同步） -->
    <!-- 失败必须说话：否则界面只剩「放不了」，用户无从判断是没装 ffmpeg 还是别的 -->
    <!-- Android 上这条是**唯一的**失败说明（src 为空 → onMediaError 短路），必须点名容器 -->
    <p v-if="player.remuxState === 'failed'" class="text-sm text-pink">
      {{ blockedContainer }} 容器内置播放器不支持（{{
        remuxReasonText(player.remuxReason)
      }}）。
      <template v-if="platform.isAndroid">
        请用 MX Player / VLC 打开该文件（自带解码器），或在电脑上转成 MP4
        后拷回。
      </template>
      <template v-else>可退回下面的手动方案（原文件不动）。</template>
    </p>
    <p v-if="errorText" class="text-sm text-pink">{{ errorText }}</p>
    <p v-if="errorText" class="text-xs text-ink-2">
      {{ probeSummary(player.probeResult) }}
    </p>

    <div
      v-if="player.probeResult?.suggestCommand"
      class="space-y-2 rounded-card bg-bg-elev p-3"
    >
      <!-- Android 没有终端也没有 ffmpeg：命令与复制按钮都不该出现（出现了就是误导） -->
      <p class="text-xs text-ink-2">
        内置播放器放不了它。{{ remuxHelp(platform.isAndroid) }}
      </p>
      <template v-if="!platform.isAndroid">
        <code
          class="block break-all rounded-btn bg-ink-1/5 p-2 text-xs text-ink-1"
          >{{ player.probeResult.suggestCommand }}</code
        >
        <button
          class="rounded-btn bg-pink px-4 py-2 text-sm font-medium text-white"
          @click="copyCommand()"
        >
          {{ copied ? "已复制" : "复制转换命令" }}
        </button>
      </template>
    </div>

    <PlaylistPanel
      v-if="playlist.length > 1"
      :items="playlist"
      :index="index"
      :kind="sourceKind"
      :label="sourceLabel"
      @select="onSelectPlaylist"
    />

    <ResumeDialog
      :open="resumeOpen"
      :video-id="current?.id ?? ''"
      :position="resumePosition"
      :duration="duration"
      @resume="onResume"
      @restart="onRestart"
      @cancel="onCancel"
    />
  </section>
</template>
