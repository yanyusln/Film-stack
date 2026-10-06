<script setup lang="ts">
// 目录树节点（递归）：默认展开 1 级，子节点懒渲染（技术方案 §9.1 / §5）。
// 只读遍历内存里的树，不触盘；点名字进入该目录，箭头单独负责展开/收起。
import { ref } from "vue";
import AppIcon from "@/components/AppIcon.vue";
import type { FolderNode } from "@/composables/useFolderTree";

const props = withDefaults(
  defineProps<{
    node: FolderNode;
    activeKey: string;
    /** 展开深度：0 表示只展开自己这一级（根默认展开 1 级） */
    expandDepth?: number;
    /** 根节点带数量的样式（设计稿「电影 (4)」） */
    withCount?: boolean;
  }>(),
  { expandDepth: 0, withCount: true },
);

const emit = defineEmits<{ (e: "select", key: string): void }>();

const open = ref(props.node.depth < props.expandDepth);

function toggle() {
  open.value = !open.value;
}

function select() {
  emit("select", props.node.key);
}
</script>

<template>
  <li>
    <div
      class="group flex h-8 items-center gap-1 rounded-btn pr-1 transition-colors duration-200 hover:bg-ink-1/5"
      :class="activeKey === node.key ? 'text-pink' : 'text-ink-1'"
      :style="
        activeKey === node.key
          ? 'box-shadow: inset 2px 0 0 var(--pink)'
          : undefined
      "
    >
      <button
        v-if="node.children.length"
        type="button"
        class="grid h-6 w-6 shrink-0 place-items-center rounded-btn text-ink-2 hover:text-ink-1"
        :aria-label="open ? `收起 ${node.name}` : `展开 ${node.name}`"
        @click.stop="toggle"
      >
        <AppIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="16" />
      </button>
      <span v-else class="h-6 w-6 shrink-0" />
      <AppIcon :name="'folder'" :size="16" class="shrink-0 text-ink-2" />
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left text-sm"
        :title="node.name"
        @click="select"
      >
        {{ node.name
        }}<span v-if="withCount && node.count"> ({{ node.count }})</span>
      </button>
    </div>

    <ul
      v-if="open && node.children.length"
      class="ml-3 border-l pl-1"
      style="border-color: var(--line)"
    >
      <FolderTreeNode
        v-for="child in node.children"
        :key="child.key"
        :node="child"
        :active-key="activeKey"
        :expand-depth="0"
        :with-count="false"
        @select="emit('select', $event)"
      />
    </ul>
  </li>
</template>
