// 首页主链路 E2E（技术方案 §14.2）：侧栏目录树 → 视频网格 → 搜索空态 → 首轮扫描。
// 顺序按后端返回的字节序给（ep10 在前），前端必须显示成自然序 ep1 / ep2 / ep10（F19）。
import { expect, test } from "@playwright/test";
import { installTauriMock, video, type E2EFixtures } from "./fixtures";

const BASE: E2EFixtures = {
  roots: [
    { id: "r1", label: "剧集", path: "D:\\剧集", enabled: true, videoCount: 3 },
  ],
  videos: {
    r1: [
      video({ id: "v1", name: "ep10.mp4", duplicateCount: 2 }),
      video({ id: "v2", name: "ep2.mp4" }),
      video({ id: "v3", name: "ep1.mp4" }),
    ],
  },
  scan: {
    steps: [
      { processed: 1, total: 3 },
      { processed: 3, total: 3 },
    ],
    summary: { roots: 1, added: 2, updated: 1, removed: 1, errors: [] },
  },
};

async function openHome(
  page: import("@playwright/test").Page,
  fx: E2EFixtures,
) {
  await installTauriMock(page, fx);
  await page.goto("/");
}

/**
 * 点侧栏目录树里的节点（PC/平板形态）。
 * 用 title 精确命中名字按钮——节点展开后同一行还有「收起/展开」箭头按钮，按名字取会撞上它。
 */
async function pickNode(page: import("@playwright/test").Page, label: string) {
  await page.locator(`button[title="${label}"]`).click();
}

test("没有根目录时给空态引导，不显示空网格", async ({ page }) => {
  await openHome(page, { roots: [], videos: {} });
  await expect(page.getByText("还没有影片目录")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
});

test("侧栏显示根目录与视频数，点它加载网格且顺序是文件名自然序", async ({
  page,
}) => {
  await openHome(page, BASE);
  await expect(page.getByRole("button", { name: /剧集 \(3\)/ })).toBeVisible();
  await pickNode(page, "剧集");
  await expect(page.getByText("共 3 个视频")).toBeVisible();

  const cards = page.locator("article");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("ep1.mp4");
  await expect(cards.nth(1)).toContainText("ep2.mp4");
  await expect(cards.nth(2)).toContainText("ep10.mp4");
});

test("目录树可下钻：进入子文件夹只看这一层的视频", async ({ page }) => {
  await openHome(page, {
    roots: [
      {
        id: "r1",
        label: "剧集",
        path: "D:\\剧集",
        enabled: true,
        videoCount: 2,
      },
    ],
    videos: {
      r1: [
        video({ id: "v1", name: "root.mp4" }),
        video({
          id: "v2",
          name: "nested.mp4",
          path: "D:\\剧集\\动画\\nested.mp4",
        }),
      ],
    },
  });
  await pickNode(page, "剧集");
  // 根节点是整根聚合：根目录的 root.mp4 + 子目录里的 nested.mp4
  await expect(page.getByText("共 2 个视频")).toBeVisible();

  // 侧栏树里的「动画」子节点，点进去只看它的子树
  await pickNode(page, "动画");
  await expect(page.getByText("共 1 个视频")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.locator("article").first()).toContainText("nested.mp4");

  // 面包屑回到根目录，根目录这条又回到整根聚合里
  await page
    .getByRole("navigation", { name: "目录" })
    .getByRole("button", { name: "剧集" })
    .click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.locator("article", { hasText: "root.mp4" })).toHaveCount(1);
});

test("「文件夹」视图下钻到最底层仍有视频，不需要手动刷新", async ({ page }) => {
  await openHome(page, {
    roots: [
      {
        id: "r1",
        label: "剧集",
        path: "D:\\剧集",
        enabled: true,
        videoCount: 2,
      },
    ],
    videos: {
      r1: [
        video({ id: "v1", name: "root.mp4" }),
        video({
          id: "v2",
          name: "nested.mp4",
          path: "D:\\剧集\\动画\\合集\\nested.mp4",
        }),
      ],
    },
  });

  // 切到「文件夹」视图：子文件夹卡片 + 该目录自己的视频一起给
  await page.getByRole("button", { name: "文件夹", exact: true }).click();
  await pickNode(page, "剧集");
  await expect(page.locator("article")).toHaveCount(2);

  const card = (name: string) =>
    page.getByTestId("folder-card").filter({ hasText: name });
  await card("动画").click();
  await card("合集").click();

  // 最底层没有子文件夹，但这一层的视频必须直接可见（修复前这里是「当前目录没有可播放的视频」）
  await expect(page.getByTestId("folder-card")).toHaveCount(0);
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.locator("article").first()).toContainText("nested.mp4");
  await expect(page.getByText("当前目录没有可播放的视频")).toHaveCount(0);
});

test("手动刷新保持当前目录，不会被弹回根目录", async ({ page }) => {
  await openHome(page, {
    roots: [
      {
        id: "r1",
        label: "剧集",
        path: "D:\\剧集",
        enabled: true,
        videoCount: 2,
      },
    ],
    videos: {
      r1: [
        video({ id: "v1", name: "root.mp4" }),
        video({
          id: "v2",
          name: "nested.mp4",
          path: "D:\\剧集\\动画\\nested.mp4",
        }),
      ],
    },
  });

  await pickNode(page, "剧集");
  await pickNode(page, "动画");
  await expect(page.getByText("共 1 个视频")).toBeVisible();

  await page.getByRole("button", { name: "刷新当前目录" }).click();
  // 面包屑与网格都还停在「动画」，没退回根目录
  await expect(
    page
      .getByRole("navigation", { name: "目录" })
      .getByRole("button", { name: "动画" }),
  ).toBeVisible();
  await expect(page.locator("article")).toHaveCount(1);
});

test("重复角标只挂在重复文件上，文案固定", async ({ page }) => {
  await openHome(page, BASE);
  await pickNode(page, "剧集");
  await expect(page.getByText("共 3 个视频")).toBeVisible();

  // ep10 有 2 处副本；其余不挂角标（C6：文件名后不加「重复」字样）
  await expect(page.getByText("该文件共有 2 处副本")).toHaveCount(1);
  await expect(
    page.locator("article", { hasText: "ep2.mp4" }),
  ).not.toContainText("重复");
});

test("搜索过滤，无结果时给搜索空态", async ({ page }) => {
  await openHome(page, BASE);
  await pickNode(page, "剧集");
  await expect(page.getByText("共 3 个视频")).toBeVisible();

  const box = page.getByLabel("搜索当前目录");
  await box.fill("ep2");
  await expect(page.getByText("共 1 个视频")).toBeVisible();

  await box.fill("zzz");
  await expect(page.getByText("没有找到匹配的视频")).toBeVisible();
  // 空态的「清除筛选」按钮（搜索框里那个是图标按钮，aria-label 同名）
  await page.getByLabel("清除筛选").click();
  await expect(page.getByText("共 3 个视频")).toBeVisible();
});

test("PC 宽屏：卡片可多选，筛选行统计显示已选个数", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openHome(page, BASE);
  await pickNode(page, "剧集");
  await expect(page.locator("article")).toHaveCount(3);

  await page
    .locator("article", { hasText: "ep1.mp4" })
    .getByRole("button")
    .click();
  await page
    .locator("article", { hasText: "ep2.mp4" })
    .getByRole("button")
    .click();
  await expect(page.getByText("已选 2 个")).toBeVisible();
  await expect(page.getByRole("button", { name: "加入分组" })).toBeVisible();
});

test("添加目录后自动增量扫描，完成文案含失联计数", async ({ page }) => {
  await openHome(page, {
    ...BASE,
    pickDir: "D:\\新番",
    addRootsResult: [
      {
        id: "r2",
        label: "新番",
        path: "D:\\新番",
        enabled: true,
        videoCount: 0,
      },
    ],
  });

  await page.getByRole("button", { name: "添加目录", exact: true }).click();
  // 新增目录进侧栏树，并立刻跑一轮增量扫描（F3）
  await expect(page.getByText("新番").first()).toBeVisible();
  await expect(
    page.getByText("扫描完成 · 新增 2 · 更新 1 · 失效 1"),
  ).toBeVisible();
  // 扫描结束后按钮恢复可用
  await expect(
    page.getByRole("button", { name: "添加目录", exact: true }),
  ).toBeEnabled();
});

/**
 * 回归：扫描分批提交时用户点了根目录，items 成了半成品快照，
 * 扫描结束后没人刷新 → 侧栏计数 2511、目录树却只有 3 个子目录。
 * 现在扫描成功会自动重拉 list_roots + 刷新当前根的视频列表。
 */
test("扫描完成后目录树与计数自动补齐，不必手动刷新", async ({ page }) => {
  await openHome(page, {
    roots: [
      { id: "r1", label: "剧集", path: "D:\\剧集", enabled: true, videoCount: 1 },
    ],
    // 扫描途中能拿到的第一批：只有 A 一个目录
    videos: {
      r1: [video({ id: "v1", name: "a1.mp4", path: "D:\\剧集\\A\\a1.mp4" })],
    },
    scannedRoots: [
      { id: "r1", label: "剧集", path: "D:\\剧集", enabled: true, videoCount: 3 },
    ],
    scannedVideos: {
      r1: [
        video({ id: "v2", name: "b1.mp4", path: "D:\\剧集\\B\\b1.mp4" }),
        video({
          id: "v3",
          name: "c1.mp4",
          path: "D:\\剧集\\B\\合集\\c1.mp4",
        }),
      ],
    },
    scan: {
      steps: [
        { processed: 1, total: 3 },
        { processed: 3, total: 3 },
      ],
      summary: { roots: 1, added: 2, updated: 1, removed: 0, errors: [] },
    },
  });

  await pickNode(page, "剧集");
  await expect(page.getByText("共 1 个视频")).toBeVisible();
  await expect(page.locator('button[title="B"]')).toHaveCount(0);

  // 右键根目录 → 重新扫描
  await page.locator('button[title="剧集"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "重新扫描「剧集」" }).click();

  // 计数、目录树、网格三处一起更新（修复前只有计数变）
  await expect(page.getByRole("button", { name: /剧集 \(3\)/ })).toBeVisible();
  await expect(page.getByText("共 3 个视频")).toBeVisible();
  await expect(page.locator('button[title="B"]')).toBeVisible();
  // 二级目录也在（B → 合集）
  await page.getByRole("button", { name: "展开 B" }).click();
  await expect(page.locator('button[title="合集"]')).toBeVisible();
});

test("添加目录扫描完成后自动选中该根并展开全部子目录", async ({ page }) => {
  await openHome(page, {
    roots: [
      { id: "r1", label: "剧集", path: "D:\\剧集", enabled: true, videoCount: 3 },
    ],
    videos: {
      r1: [video({ id: "v1", name: "root.mp4", path: "D:\\剧集\\root.mp4" })],
    },
    pickDir: "D:\\新番",
    addRootsResult: [
      { id: "r2", label: "新番", path: "D:\\新番", enabled: true, videoCount: 0 },
    ],
    scannedRoots: [
      { id: "r1", label: "剧集", path: "D:\\剧集", enabled: true, videoCount: 3 },
      { id: "r2", label: "新番", path: "D:\\新番", enabled: true, videoCount: 3 },
    ],
    scannedVideos: {
      r2: [
        video({ id: "n1", name: "e01.mp4", path: "D:\\新番\\第1章\\e01.mp4" }),
        video({ id: "n2", name: "e01.mp4", path: "D:\\新番\\第2章\\e01.mp4" }),
        video({
          id: "n3",
          name: "e01.mp4",
          path: "D:\\新番\\第3章\\合集\\e01.mp4",
        }),
      ],
    },
    scan: {
      steps: [{ processed: 3, total: 3 }],
      summary: { roots: 1, added: 3, updated: 0, removed: 0, errors: [] },
    },
  });

  await page.getByRole("button", { name: "添加目录", exact: true }).click();

  // 不用再手动点根目录：扫描完成后自动选中并加载
  await expect(page.getByRole("button", { name: /新番 \(3\)/ })).toBeVisible();
  await expect(page.getByText("共 3 个视频")).toBeVisible();
  await expect(page.locator('button[title="第1章"]')).toBeVisible();
  await expect(page.locator('button[title="第2章"]')).toBeVisible();
  await expect(page.locator('button[title="第3章"]')).toBeVisible();
});
