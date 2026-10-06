import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { configDefaults } from "vitest/config";

// 仅前端构建配置；Tauri 相关端口/协议见 src-tauri/tauri.conf.json。

// `tauri android dev` 会把 devUrl 的 host 换成**局域网 IP**（日志：Using 192.168.x.x to
// access the development server），此时前端必须监听 0.0.0.0，否则 CLI 会一直停在
// 「Waiting for your frontend dev server to start」——APK 连构建都不会开始。
// 桌面端反过来必须钉死 127.0.0.1（Node 在部分 Windows 上只绑 ::1，WebView2 会白屏）。
const platform = process.env.TAURI_ENV_PLATFORM ?? "";
const isMobile = platform === "android" || platform === "ios";
const devHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  test: {
    // e2e/ 是 Playwright 用例（@playwright/test 语法 + 真实浏览器），不归 vitest 收集
    exclude: [...configDefaults.exclude, "e2e/**", "src-tauri/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 移动端监听全网卡（或 CLI 指定的 TAURI_DEV_HOST）；桌面端显式钉 IPv4。
    host: devHost || (isMobile ? true : "127.0.0.1"),
    // 移动端 HMR 交给 vite 按页面地址推断——写死 127.0.0.1 会让设备连到它自己。
    hmr: isMobile
      ? undefined
      : { protocol: "ws", host: "127.0.0.1", port: 1420 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
