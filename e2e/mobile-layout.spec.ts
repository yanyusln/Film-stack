// 手机窄屏（360dp）布局回归：面包屑/分组页头部不被固定宽度输入框挤成竖排，
// 网格隐式轨道不被长文件名撑宽（页面无横向溢出），底栏始终可见。
import { expect, test } from "@playwright/test";
import { installTauriMock, video, type E2EFixtures } from "./fixtures";

const BASE: E2EFixtures = {
  roots: [
    {
      id: "r1",
      label: "Download",
      path: "/storage/emulated/0/Download",
      enabled: true,
      videoCount: 3,
    },
  ],
  videos: {
    r1: [
      video({
        id: "v1",
        name: "170.day77-爬虫整体课程内容介绍及爬虫分类-Request头部解析_mp4",
      }),
      video({
        id: "v2",
        name: "301.day91-上周总结-NeuralCF-WideDeep模型原理解析_mp4",
      }),
      video({ id: "v3", name: "test_placeholder.avi" }),
    ],
  },
};

/** fixtures 的 mock 不含分组命令：包一层 invoke，内存里维护一个分组。 */
async function installGroupMock(page: import("@playwright/test").Page) {
  await page.addInitScript((videos) => {
    const groups: { id: string; name: string }[] = [];
    const items: Record<string, string[]> = {};
    const byId = new Map(
      (videos as { id: string }[]).map((v) => [v.id, v]),
    );
    const w = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (c: string, a?: unknown) => Promise<unknown>;
      };
    };
    const prev = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === "create_group") {
        const g = {
          id: `g${groups.length + 1}`,
          name: String(a.name),
          parentId: null,
          sortOrder: 0,
        };
        groups.push(g);
        return Promise.resolve(g);
      }
      if (cmd === "list_groups") return Promise.resolve(groups.slice());
      if (cmd === "add_to_group") {
        const gid = String(a.groupId);
        const cur = items[gid] ?? [];
        items[gid] = [
          ...cur,
          ...(a.videoIds as string[]).filter((id) => !cur.includes(id)),
        ];
        return Promise.resolve(1);
      }
      if (cmd === "list_group_items") {
        return Promise.resolve(
          (items[String(a.groupId)] ?? []).map((id) => byId.get(id)),
        );
      }
      return prev(cmd, args);
    };
  }, BASE.videos?.r1 ?? []);
}

/** 页面上任何元素的右缘都不得超出视口（横向溢出的通用断言）。 */
async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const vw = await page.evaluate(() => window.innerWidth);
  const offenders = await page.evaluate((width) => {
    return [...document.querySelectorAll("*")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > width + 1 && r.width > 8;
      })
      .slice(0, 8)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 60)}`);
  }, vw);
  expect(offenders, `横向溢出元素: ${offenders.join(" | ")}`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
}

test.describe("手机窄屏布局", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("首页：面包屑单行，操作区换行后无横向溢出", async ({ page }) => {
    await installTauriMock(page, BASE);
    await page.goto("/");
    await page.getByRole("button", { name: /Download \(3\)/ }).click();
    const crumb = page.getByRole("button", { name: "本地视频" });
    await expect(crumb).toBeVisible();
    expect((await crumb.boundingBox())!.height).toBeLessThan(30); // 未竖排
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: "test-results/mobile-home.png", fullPage: true });
  });

  /** 手机卡片流：点虚线卡 → 填名 → 创建 → 打开该分组 */
  async function createGroupOnPhone(
    page: import("@playwright/test").Page,
    name: string,
  ) {
    await page.getByRole("button", { name: "新建分组" }).click();
    await page.getByPlaceholder("新分组名称").fill(name);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("button", { name: `打开分组 ${name}` }).click();
  }

  test("分组页：卡片网格单屏排布、加入按钮在屏内、底栏可见", async ({
    page,
  }) => {
    await installTauriMock(page, BASE);
    await installGroupMock(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Download \(3\)/ }).click();
    await page.getByRole("link", { name: "分组" }).click();
    await createGroupOnPhone(page, "23");
    await expect(page.getByText("可添加的影片")).toBeVisible();

    expect(
      (await page
        .getByRole("heading", { name: "分组", exact: true })
        .boundingBox())!.height,
    ).toBeLessThan(30);
    await expectNoHorizontalOverflow(page);
    for (const btn of await page
      .getByRole("button", { name: /加入分组/ })
      .all()) {
      const b = await btn.boundingBox();
      expect(b!.x + b!.width).toBeLessThanOrEqual(360.5);
    }
    const nav = page.locator("nav.fixed");
    await expect(nav).toBeVisible();
    expect((await nav.boundingBox())!.y).toBeLessThan(800);
    await page.screenshot({ path: "test-results/mobile-groups.png", fullPage: true });
  });

  test.describe("330dp 窄屏", () => {
    test.use({ viewport: { width: 330, height: 800 } });

    test("分组页：有成员并进入排序模式，头部与成员卡片都不挤不竖排", async ({
      page,
    }) => {
      await installTauriMock(page, BASE);
      await installGroupMock(page);
      await page.goto("/");
      await page.getByRole("button", { name: /Download \(3\)/ }).click();
      await page.getByRole("link", { name: "分组" }).click();
      await createGroupOnPhone(page, "A");
      // 加一部影片进分组，让「编辑」按钮出现
      await page
        .locator("li", { hasText: "test_placeholder.avi" })
        .getByRole("button", { name: /加入分组/ })
        .click();
      await expect(page.getByText("成员（1）")).toBeVisible();
      // 进入排序模式
      await page.getByRole("button", { name: "编辑排序" }).click();
      await expect(page.getByRole("button", { name: "完成排序" })).toBeVisible();
      // 排序模式下手柄与移出按钮都在
      await expect(page.locator("[data-drag-handle]").first()).toBeVisible();

      const h1 = page.getByRole("heading", { name: "分组", exact: true });
      expect((await h1.boundingBox())!.height).toBeLessThan(30);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: "test-results/mobile-groups-edit.png",
        fullPage: true,
      });
    });
  });
});
