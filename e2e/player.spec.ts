// 播放主链路 E2E（技术方案 §14.2）：卡片 → 播放器 → 控制栏/倍速/续播 → 返回。
// 媒体解码不在 E2E 范围内（asset:// 不是浏览器协议），时长与续播靠 loadedmetadata 驱动。
import { expect, test } from "@playwright/test";
import {
  fakeLoadedMetadata,
  installTauriMock,
  video,
  type E2EFixtures,
} from "./fixtures";

const FX: E2EFixtures = {
  roots: [{ id: "r1", label: "剧集", path: "D:\\剧集", enabled: true }],
  videos: {
    r1: [
      video({ id: "v1", name: "ep10.mp4" }),
      video({ id: "v2", name: "ep2.mp4" }),
      video({ id: "v3", name: "ep1.mp4" }),
    ],
  },
  // ep2 上次看到 01:00（不在末尾 30s，属于要问的范围）
  progress: {
    v2: { videoId: "v2", position: 60, duration: 600, updatedAt: 0 },
  },
};

async function openPlayer(page: import("@playwright/test").Page) {
  await installTauriMock(page, FX);
  await page.goto("/");
  await page.getByRole("button", { name: /剧集/ }).first().click();
  await expect(page.getByText("共 3 个视频")).toBeVisible();
  // 点中间的 ep2：播放页必须落在同一个视频上（文件夹序重排后下标不能错位）
  await page.locator("article", { hasText: "ep2.mp4" }).click();
  await expect(page).toHaveURL(/#\/player$/);
}

test("点哪个播哪个，播放页标题与路径一致", async ({ page }) => {
  await openPlayer(page);
  await expect(page.getByRole("heading", { name: "ep2.mp4" })).toBeVisible();
  await expect(page.getByText("D:\\剧集\\ep2.mp4")).toBeVisible();
});

test("文件夹序面板：顺序、计数、上一个/下一个", async ({ page }) => {
  await openPlayer(page);
  await expect(page.getByText("文件夹序")).toBeVisible();
  await expect(page.getByText("2 / 3")).toBeVisible();

  const items = page.locator("li[data-current]");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("ep1.mp4");
  await expect(items.nth(2)).toContainText("ep10.mp4");

  await page.getByRole("button", { name: "下一个" }).click();
  await expect(page.getByText("3 / 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "ep10.mp4" })).toBeVisible();

  await page.getByRole("button", { name: "上一个" }).click();
  await expect(page.getByRole("heading", { name: "ep2.mp4" })).toBeVisible();
});

test("倍速菜单改档后控制栏跟着变", async ({ page }) => {
  await openPlayer(page);
  const trigger = page.getByRole("button", { name: "倍速 1x" });
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "1.5x" }).click();
  await expect(page.getByRole("button", { name: "倍速 1.5x" })).toBeVisible();
});

test("循环模式在 列表→不循环 之间切换", async ({ page }) => {
  await openPlayer(page);
  await page.getByRole("button", { name: "列表循环" }).click();
  await expect(page.getByRole("button", { name: "不循环" })).toBeVisible();
});

test("画中画按钮在桌面不出现（PC V1 不做）", async ({ page }) => {
  await openPlayer(page);
  await expect(page.getByRole("button", { name: "画中画" })).toHaveCount(0);
});

test("续播弹三选一，选继续播放后收起", async ({ page }) => {
  await openPlayer(page);
  await fakeLoadedMetadata(page, 600);

  await expect(page.getByText("继续上次播放？")).toBeVisible();
  await expect(page.getByText("上次看到 01:00")).toBeVisible();
  await page.getByRole("button", { name: "继续播放" }).click();
  await expect(page.getByText("继续上次播放？")).toHaveCount(0);
});

test("返回影片库回到首页", async ({ page }) => {
  await openPlayer(page);
  await page.getByRole("link", { name: "返回影片库" }).click();
  await expect(page).toHaveURL(/#\/$/);
  // 首页外壳是侧栏 + 面包屑（设计稿 PC），"本地视频" 是第一级
  await expect(page.getByRole("button", { name: "本地视频" })).toBeVisible();
});
