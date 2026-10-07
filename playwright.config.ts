import { defineConfig, devices } from "@playwright/test";

// 桌面 E2E（技术方案 §14.2）：真浏览器跑真前端，IPC 层打桩（见 e2e/fixtures.ts）。
// 与单测的分工：单测覆盖纯函数与组件，E2E 只覆盖跨页面主链路（首扫 → 播放 → 返回）。
// 端口可用 PW_PORT 覆盖：本机 4173 常被别的项目（如 E:\P\err-blog 的 vitepress preview）
// 占用，而 reuseExistingServer 会直接复用那个服务，导致整批 E2E 报「元素找不到」的假失败。
const PORT = Number(process.env.PW_PORT ?? 4173);

// 浏览器：默认复用系统已安装的 Chrome（本机 cdn.playwright.dev 下载不通）；
// CI 上跑 `playwright install chromium` 后设 PW_CHANNEL=bundled 走自带 Chromium。
const channel =
  process.env.PW_CHANNEL === "bundled"
    ? undefined
    : (process.env.PW_CHANNEL ?? "chrome");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
    // devices 里若带默认 channel，这里显式覆盖
    ...(channel ? { channel } : {}),
  },
  webServer: {
    // 直接吃 dist：构建约 2s，比 dev server 稳定（无 HMR 干扰）
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
