# 影栈 (Film-stack)

本地视频播放器桌面 / 移动端应用。递归扫描本地视频目录，支持分组管理、重复标记、倍速播放、续播与播放列表，**全程离线、不联网、不改动磁盘文件**。

- PC：Windows / macOS / Linux（Tauri v2 桌面壳）
- 移动端：Android（与桌面同仓，靠断点切换形态，不单独打包）
- 形态：侧载安装（`.msi` / `.dmg` / `.apk`），**无后端服务**

---

## 核心特性（V1）

- **本地扫描**：手动选多个根目录，递归扫描子文件夹；支持增量扫描 + 手动刷新；文件监听为可选开关。
- **三视图**：目录树（默认展开 1 级、子节点懒加载）/ 文件夹卡片 / 搜索平铺。
- **缩略图**：优先取系统媒体图，后台 ffmpeg 抽帧（并发 2），`>500MB` 显示任务进度，不常驻总进度条。
- **一级分组 + 多归属引用**：分组内拖拽排序（各端独立记忆），不修改磁盘。
- **重复标记**：仅右上角重叠胶片角标（文案「该文件共有 N 处副本」），不删不移动。
- **播放器**：进度条（无悬浮缩略图）、6 档倍速、PC 横向音量、Android 右音量 / 左亮度竖滑、双击左右半屏 ±10s、长按临时 2x、控制栏 3s 淡出。全屏按钮（翻转图标）进入横屏铺满；横 / 竖屏切换按钮让**整个 UI（控制栏 + 手势层）跟随视频一起旋转**，而非仅旋转画面。
- **续播**：全局三选一（默认 `ask`）+「本次不再询问」（仅跳过本次，不改全局）；末尾 30s 不存进度。
- **播放列表**：分组序 / 文件夹序切换，单曲 / 列表循环。
- **Android**：画中画、横屏锁屏键、平板「手势总控」开关。
- **4 套空态**：无分组 / 分组为空 / 目录无视频 / 搜索无结果。

**V1 不做**：弹幕、在线播放、会员、云端同步、账号、嵌套分组、悬浮抽帧预览、PC 画中画、转码 / 剪辑 / 字幕下载、AI 识别、自动跨端同步、修改 / 删除磁盘文件。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.5 `<script setup>` + TypeScript 5.6 + Vite 6 |
| 状态 | Pinia 3 |
| 路由 | Vue Router 4（`createWebHashHistory`，无服务端） |
| 样式 | Tailwind CSS 4 |
| 拖拽 | vue-draggable-plus（开启 `delayTouchStart` 防平板误触） |
| 壳 | Tauri v2（PC + Android 同仓） |
| 原生 | Rust（walkdir / ffmpeg-sidecar / rusqlite） |
| 存储 | SQLite（Tauri SQL 插件） |

---

## 目录结构

```
film-stack/
├─ AGENTS.md                 # AI / 开发者规范（引用型真源说明）
├─ src/
│  ├─ main.ts
│  ├─ App.vue
│  ├─ styles/tokens.css      # 设计令牌
│  ├─ router/index.ts        # Hash 模式
│  ├─ stores/                # Pinia: scan / groups / player / ui / videos
│  ├─ views/                 # HomeView / PlayerView / GroupsView / SettingsView
│  ├─ components/            # 侧栏 / 面包屑 / 卡片 / 角标 / 播放控制 / 续播窗 等
│  ├─ composables/          # 目录树 / 拖拽 / 响应式 / 容器支持 / 续播策略 等
│  └─ platform/             # 同仓 flavor: desktop / android 统一出口
├─ src-tauri/               # Rust 侧：scan / thumbnail / db / dup / watch / media_server
├─ e2e/                     # Playwright 端到端测试（IPC 打桩）
├─ scripts/                 # 离线审计 / 性能压测生成脚本
└─ docs/                    # 技术方案、组件规范表（仅 AI 参考，不入库）
```

---

## 快速开始

### 环境要求

- Node.js 18+，包管理器 **pnpm**
- Rust 工具链（桌面构建需要）
- Android 真机 / 模拟器调试需：JDK **21**、`ANDROID_HOME`、`platforms;android-37.0`、`build-tools;37.0.0`、`ndk;26.3.11579264`
- 桌面抽帧依赖用户自备外部 `ffmpeg`（Android 由内置 `aviremux` 接管 AVI→MP4 轻量重封装）

### 安装

```bash
pnpm install
```

### 本地开发

```bash
# 仅前端开发服务器（http://localhost:5173）
pnpm dev

# 桌面端开发（起 vite + Tauri 窗口）
pnpm dev:desktop

# Android 开发 —— 唯一入口，禁止在 Android Studio 点 Run
pnpm dev:android
```

> Android 必须用 `pnpm dev:android`（CLI 负责起 vite + Gradle + `adb reverse` + 装包）。
> Android Studio 仅用于 Gradle Sync 与查看 Logcat。

### 打包构建

```bash
pnpm build:desktop     # vue-tsc 类型检查 + vite 构建 + tauri 打包
pnpm build:android     # 产出 --apk --aab
```

#### 打包产物路径

构建完成后，安装包输出位置如下（以版本 `1.0.0`、产品名 `影栈-本地视频播放器` 为例）：

| 平台 | 格式 | 产物路径 |
| --- | --- | --- |
| Windows | MSI | `src-tauri/target/release/bundle/msi/影栈-本地视频播放器_1.0.0_x64_zh-CN.msi` |
| Windows | NSIS 安装包 | `src-tauri/target/release/bundle/nsis/影栈-本地视频播放器_1.0.0_x64-setup.exe` |
| macOS | DMG | `src-tauri/target/release/bundle/dmg/影栈-本地视频播放器_1.0.0_x64.dmg` |
| macOS | App | `src-tauri/target/release/bundle/macos/影栈-本地视频播放器.app` |
| Android | APK（通用架构） | `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| Android | APK（按 ABI） | `src-tauri/gen/android/app/build/outputs/apk/<abi>/release/app-<abi>-release.apk` |
| Android | AAB | `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab` |

> 桌面端产物统一在 `src-tauri/target/release/bundle/` 下；Android 产物在 `src-tauri/gen/android/app/build/outputs/`。
> Windows MSI 文件名中的语言后缀 `zh-CN` 由 `tauri.conf.json` 的 `bundle.windows.wix.language` 决定；升级版本时把路径里的 `1.0.0` 换成对应版本号即可。

#### 侧载安装到真机（adb）

项目为侧载分发（不上架），用 `adb` 把 APK 装到手机：

```bash
# 若手机已装过「不同密钥签名」的同名包，先卸载再装，否则报 INSTALL_FAILED_UPDATE_INCOMPATIBLE
adb uninstall app.local.videoplayer
adb install src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

> - 包名固定为 `app.local.videoplayer`（见 `tauri.conf.json` 的 `identifier`）。
> - 重新签名 / 更换 keystore 后，旧版必须 `adb uninstall` 一次才能覆盖安装。
> - 走 `pnpm build:android` 时若带 `--target aarch64`，universal APK 实际只含 arm64 的 `.so`，仅 arm64 手机可装；日常侧载用 universal 包即可。

### Android 初始化（首次 / 重跑后需改回 Gradle 镜像）

```bash
pnpm init:android
```

> 重跑 `init:android` 会覆盖 `gradle-wrapper.properties`，需将 `distributionUrl` 改回腾讯镜像
> `https://mirrors.cloud.tencent.com/gradle/<版本>-bin.zip`，否则国内拉取极慢。

---

## 测试与质量

```bash
pnpm test          # vitest 单元测试（store 整体 mock @/bridge/commands）
pnpm test:e2e     # Playwright 端到端（默认系统 Chrome；CI 用 PW_CHANNEL=bundled）
pnpm lint         # eslint + prettier 检查
pnpm typecheck    # vue-tsc --noEmit 类型检查
pnpm audit:offline  # 离线审计：依赖/源码/产物/CSP/权限/asset scope 等十一项一致性
```

Rust 侧：

```bash
cd src-tauri
cargo test --lib                 # 纯函数 + 内存 SQLite 集成 + 临时目录指纹采样
cargo clippy -- -D warnings      # 零警告
```

提交前建议：`pnpm lint && pnpm typecheck`。

---

## 数据层简述

```sql
videos(id, root_id, path, name, size, mtime, fingerprint, container, last_scanned_at, missing, dup_count)
groups(id, name, parent_id NULL)              -- parent_id 预留
group_items(group_id, video_id, sort_order)   -- 多归属引用
play_progress(video_id, pos_sec, updated_at)  -- 末尾 30s 存 0
scan_tasks(id, root_path, status, processed, total, started_at)
```

- **重复判定**：采样 `sha256(头 64KB + 中 64KB + 尾 64KB)`（<192KB 全量），失联条目（`missing=1`）不参与计数。
- **增量 diff**：本次没扫到且路径访问不到的条目标 `missing=1`（不删行）；列表与重复计数均过滤 `missing=0`；取消或读不全时不判失联。
- **扫描写入**：每 200 项或 150ms 批量事务提交。
- **容器可播**：内置播放器即 Chromium，仅支持 mp4/m4v、webm、ogg；MKV(AVI/FLV/ASF/MOV/TS/RM/VOB 等) 由桌面 ffmpeg 转封装或 Android `aviremux` 救回（仅 AVI 内 H.264 + MP3/AAC），其余提示用 MX Player / VLC 或在电脑转 MP4。

---

## 设计令牌

```css
--c-pink: #fb7299;        /* 仅：进度条 / 选中态 / 角标 / 主按钮 / 选中竖条 */
--c-bg-light: #f4f5f7;
--c-bg-dark: #1c1f26;
--radius-card: 12px;  --radius-btn: 8px;  --radius-pop: 16px;
/* 8pt 网格（8/16/24）；字号 16/14/12/11；字重 400/500/600（禁用 700） */
```

重复角标：右上角两个半透明重叠胶片 SVG（20×20，粉描边 1.5px，距右上 6px）。

---

## 硬约束

| # | 约束 | 说明 |
| --- | --- | --- |
| C1 | 不改动磁盘 | 只读扫描；无删除 / 重命名 / 移动 / 去重，分组为多归属引用 |
| C2 | 不上架、不部署 | 侧载安装，无后端服务 |
| C3 | 不联网 | 无 fetch / axios 到远端；无埋点、无统计、无自动上传 |
| C4 | 各端数据独立 | PC / 手机 / 平板 SQLite 各自独立，不自动跨端同步 |
| C5 | 末尾 30s 不续播 | `pos >= duration - 30 → 存 0`，不弹续播窗 |
| C6 | 角标纯视觉 | 重复仅用重叠胶片角标，文件名后不追加「·重复(N)」文字 |

---

## 相关指令速查

| 指令 | 作用 |
| --- | --- |
| `pnpm install` | 安装依赖 |
| `pnpm dev` | 仅前端开发服务器 |
| `pnpm dev:desktop` | 桌面端开发（Tauri 窗口） |
| `pnpm dev:android` | Android 开发（唯一正确入口） |
| `pnpm init:android` | 初始化 Android 工程（重跑后需改 Gradle 镜像） |
| `pnpm build` | 仅前端构建 |
| `pnpm build:desktop` | 桌面端打包 |
| `pnpm build:android` | Android APK / AAB 打包 |
| `pnpm test` | 单元测试（vitest） |
| `pnpm test:e2e` | 端到端测试（Playwright） |
| `pnpm lint` | ESLint + Prettier 检查 |
| `pnpm typecheck` | 类型检查 |
| `pnpm audit:offline` | 离线一致性审计 |
| `pnpm bench:gen` / `pnpm bench:clean` | 生成 / 清理压测文件 |
| `cargo test --lib` | Rust 单元测试 |
| `cargo clippy -- -D warnings` | Rust 静态检查 |

---

## 说明

详细架构、建表 SQL、模块伪代码与排期以 `docs/影栈-本地视频播放器_技术方案.md` 为唯一真源；
组件设计令牌与出图规范以 `docs/组件规范表.xlsx` 为准；AI / 协作规范见 `AGENTS.md`。
`docs/`、`assets/`、AI 规则文件仅作参考，**不入库**。
