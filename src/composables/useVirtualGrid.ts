// 虚拟网格的纯计算部分（W7-1 / 技术方案 §13.2）：把一维列表按列数切成行。
// 与 DOM 无关的判定单独放这里，方便单测；渲染与滚动测量交给 VirtualGrid.vue。

/** 按列数分块：最后一行不足列数时保留实际项数（不补空位，避免占位卡片）。 */
export function chunkRows<T>(items: readonly T[], columns: number): T[][] {
  const cols = Math.max(1, Math.floor(columns));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += cols) {
    out.push(items.slice(i, i + cols));
  }
  return out;
}

/** 行数：空列表为 0，列数非法时退化为 1 列。 */
export function rowCount(count: number, columns: number): number {
  const cols = Math.max(1, Math.floor(columns));
  const n = Math.max(0, Math.floor(count));
  return Math.ceil(n / cols);
}

/** 行内第 i 项对应的原列表下标；越界返回 -1（调用方据此跳过渲染）。 */
export function itemIndex(rowIndex: number, colIndex: number, columns: number) {
  const cols = Math.max(1, Math.floor(columns));
  return rowIndex * cols + colIndex;
}
