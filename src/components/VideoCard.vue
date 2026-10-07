<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { usePlatform } from "@/platform";
import DupBadge from "./DupBadge.vue";
import AppIcon from "./AppIcon.vue";
import { unplayableContainerLabel } from "@/composables/containerSupport";

// 视频卡片（设计稿 PC：白底圆角 12px + 封面 16:9 + 右下时长 + 右上重复角标 +
// 标题 16/500 + 路径 11 灰）。重复只用重叠胶片角标，文件名后不追加文字（C6）。
const props = withDefaults(
  defineProps<{
    /** 结构化子集：首页的 VideoRecord 与分组页的 VideoMeta 都满足 */
    video: {
      name: string;
      path: string;
      duration: number | null;
      duplicateCount: number;
      container: string | null;
    };
    thumbUrl: string | null;
    thumbState: "pending" | "ready" | "failed" | undefined;
    /** PC 鼠标形态才给复选（设计稿「已选 N 个」）；触屏不做 hover，交给分组页的编辑态 */
    selectable?: boolean;
    selected?: boolean;
  }>(),
  { selectable: false, selected: false },
);

defineEmits<{ (e: "toggle-select"): void }>();

// 资源协议取值失败（未授权/文件被 LRU 清掉）时退回占位，不显示裂图
const failed = ref(false);
watch(
  () => props.thumbUrl,
  () => {
    failed.value = false;
  },
);

const src = computed(() =>
  props.thumbUrl && !failed.value
    ? usePlatform().toAssetUrl(props.thumbUrl)
    : null,
);
const placeholderText = computed(() =>
  failed.value || props.thumbState === "failed" ? "无封面" : "封面生成中",
);
// 容器放不了就提前标出来：不用等点进去播失败才知道
// （容器由扫描时读文件头判定，不看扩展名——叫 .mp4 实为 AVI 的就是这么揪出来的）
const unplayable = computed(() =>
  unplayableContainerLabel(props.video.container),
);
const durationText = computed(() => {
  const d = props.video.duration;
  if (!d || d <= 0) return "";
  const total = Math.floor(d);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
});
</script>

<template>
  <article
    class="group flex cursor-pointer flex-col overflow-hidden rounded-card bg-bg-elev transition-shadow duration-200 hover:shadow-[0_8px_24px_rgba(0,0,0,.12)]"
    style="border: 1px solid var(--line)"
  >
    <div class="relative aspect-video w-full bg-bg">
      <img
        v-if="src"
        :src="src"
        alt=""
        class="h-full w-full object-cover"
        @error="failed = true"
      />
      <div
        v-else
        class="flex h-full w-full items-center justify-center text-xs text-ink-2"
      >
        {{ placeholderText }}
      </div>

      <button
        v-if="selectable"
        type="button"
        class="absolute left-2 top-2 grid h-6 w-6 cursor-pointer place-items-center rounded-full border text-white transition-opacity duration-200"
        :class="
          selected
            ? 'border-pink bg-pink opacity-100'
            : 'border-white/80 bg-black/40 opacity-0 group-hover:opacity-100'
        "
        :aria-label="selected ? `取消选择 ${video.name}` : `选择 ${video.name}`"
        :aria-pressed="selected"
        style="backdrop-filter: blur(2px)"
        @click.stop="$emit('toggle-select')"
      >
        <AppIcon v-if="selected" name="check" :size="14" />
      </button>

      <DupBadge
        v-if="video.duplicateCount > 1"
        :count="video.duplicateCount"
        class="absolute right-2 top-2"
      />

      <span
        v-if="unplayable"
        class="absolute bottom-2 left-2 rounded-btn bg-black/60 px-1.5 py-0.5 text-xs font-medium text-ink-inv-1"
        :title="`内置播放器不支持 ${unplayable} 容器，点开可查看转换命令`"
      >
        {{ unplayable }}
      </span>

      <span
        v-if="durationText"
        class="absolute bottom-2 right-2 rounded-btn bg-black/60 px-1.5 py-0.5 text-xs font-medium text-ink-inv-1"
      >
        {{ durationText }}
      </span>
    </div>

    <div class="flex flex-1 flex-col gap-1 p-3">
      <p class="line-clamp-2 text-base font-medium leading-snug text-ink-1">
        {{ video.name }}
      </p>
      <p class="truncate text-[11px] text-ink-2" :title="video.path">
        {{ video.path }}
      </p>
    </div>
  </article>
</template>
