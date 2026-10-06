# AGENTS.md — 影栈-本地视频播放器（Tauri v2 + Vue3）

> 本文件供 AI 编程助手（Copilot / Cursor / Claude Code / Aider）与人类开发者共同遵循。
> 改动任何 UI / 数据 / 桥接行为前，**先读 §1 硬约束、§2 参考资产、§11 禁止清单**。

---

## 1. 硬约束（不可协商）

| #   | 约束                | 说明                                                              |
| --- | ------------------- | ----------------------------------------------------------------- |
| C1  | **不改动磁盘**      | 只读扫描；无删除 / 重命名 / 移动 / 去重动作；分组为多归属**引用** |
| C2  | **不上架、不部署**  | 侧载安装（`.msi`/`.dmg`/`.apk`），无后端服务                      |
| C3  | **不联网**          | 无 `fetch`/`axios` 到远端；无埋点、无统计、无自动上传             |
| C4  | **各端数据独立**    | PC / 手机 / 平板 SQLite 各自独立，**不自动跨端同步**              |
| C5  | **末尾 30s 不续播** | `pos >= duration - 30 → 存 0`，不弹续播窗                         |
| C6  | **角标纯视觉**      | 重复仅用「重叠胶片角标」，文件名后**不追加**“·重复(N)”文字        |

## 2. 参考资产（仓库内，必须读取）

所有 UI 与规范以**仓库内文件为唯一真源**，AI 出图/写样式前须对齐：

| 路径                                   | 用途                                                             | 关键约束                                                                  |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/影栈-本地视频播放器_技术方案.md` | 架构 / 选型 / 数据层 / 里程碑（**唯一真源**）                    | §6 建表 SQL、§8 模块伪代码、§16 排期                                      |
| `docs/组件规范表.xlsx`                 | 设计令牌 / 组件 / 空态 / 状态机 / 动效 / 出图铁律                | 6 Sheet；8pt 网格、圆角 12px、`#FB7299` 仅强调                            |
| `docs/开发文档.md`                     | 项目概述 / 技术架构说明 / 七大模块划分（**引用型**，不重复细节） | 仅提炼 + 交叉引用技术方案章节（如 `见技术方案 §3.1`），改方案须同步引用   |
| `docs/开发计划.md`                     | 八周排期 / 任务分解 / 依赖关系 / 风险说明（**引用型**）          | W1–W8 任务卡映射 F1–F24；Mermaid 依赖图；风险按阶段标注；改方案须同步映射 |
| `assets/ui/PC.png`                     | PC 首页/播放页视觉参照                                           | 左 200px 导航 + 4 列网格 + 面包屑                                         |
| `assets/ui/Android.png`                | 手机首页/分组页参照                                              | 底部 4 Tab + 2 列 + `⠿` 编辑手柄                                          |
| `assets/ui/androidTablet.png`          | 平板横屏分栏参照                                                 | 左 280dp 目录树 + 右 3 列 + 跨列拖拽                                      |
| `assets/ui/PC.png`（播放页）           | 播放器控制栏参照                                                 | 无悬浮缩略图、3s 淡出、倍速九宫格                                         |

> **派生文档维护铁律**：`开发文档.md` 与 `开发计划.md` 均为 `技术方案.md` 的「引用型」派生，所有架构/契约/SQL/令牌/API 细节仍以《技术方案》为唯一真源。**任何对《技术方案》的结构性改动（新增模块、改契约、调整排期、增删功能编号）都须同步更新这两份文档的引用与任务映射**，防止双源漂移。

> **AI 生成 UI / 代码时**：以 `组件规范表.xlsx` 的「设计令牌」与「AI 出图铁律」为准，负向约束必须包含：
> `no danmaku · no login · no VIP · no thumbnail on seekbar · no netdisk blue · no gibberish · no watermark · overlapping film icon mandatory for duplicates`

## 3. 技术栈（锁死大版本）

- **前端**：Vue 3.5 `<script setup>` + TypeScript 5.6 + Vite 6
- **状态**：Pinia 3
- **路由**：Vue Router 4，**仅 `createWebHashHistory`**（无服务端）
- **样式**：Tailwind CSS 4（令牌见 §7）
- **拖拽**：vue-draggable-plus（**必开 `delayTouchStart`**，防平板误触）
- **壳**：Tauri v2（PC + Android 同仓，`src-tauri/`）
- **原生**：Rust（walkdir / ffmpeg-sidecar / rusqlite）
- **存储**：SQLite（Tauri SQL 插件）

## 4. 工程结构（新增文件请对齐）

```
film-stack/
├─ AGENTS.md                          ← 本文件
├─ assets/ui/                         ← UI 参考图（§2）
│  ├─ PC.png
│  ├─ Android.png
│  └─ androidTablet.png              ← 注：目录含重复同名文件，以本清单为准
├─ docs/                              ← 规范真源（§2）
│  ├─ 影栈-本地视频播放器_技术方案.md
│  └─ 组件规范表.xlsx
├─ src/
│  ├─ main.ts
│  ├─ App.vue
│  ├─ styles/tokens.css               # 设计令牌
│  ├─ router/index.ts                 # Hash 模式
│  ├─ stores/                         # Pinia
│  │  ├─ scan.ts       scanTasks / 队列 / 进度
│  │  ├─ groups.ts     一级分组 + sortOrder + 多归属
│  │  ├─ player.ts     进度 / 倍速 / 续播模式
│  │  └─ ui.ts         视图切换 / 编辑模式 / 空态
│  ├─ views/                           # 断点在内部分支，同仓不拆页面
│  │  ├─ HomeView.vue                  # 首页（PC/平板外壳 + 面包屑 + chips + 网格）
│  │  ├─ PlayerView.vue
│  │  ├─ GroupsView.vue
│  │  └─ SettingsView.vue
│  ├─ components/
│  │  ├─ AppSidebar.vue                # 侧栏（PC 200px / 平板 280dp）+ 文件夹树
│  │  ├─ FolderTreeNode.vue            # 目录树节点（默认展开 1 级，懒渲染）
│  │  ├─ BreadcrumbBar.vue             # 面包屑 本地视频 / 根 / 子目录 + 操作区
│  │  ├─ FilterChips.vue               # 分组 chips + 「共 N 个视频 · 已选 M 个」
│  │  ├─ AppIcon.vue                   # lucide 线稿图标（24×24，禁 emoji）
│  │  ├─ EmptyState.vue                # 4 套空态
│  │  ├─ VideoCard.vue                 # 封面 + 时长 + 路径 + 复选圈
│  │  ├─ DupBadge.vue                  # 重叠胶片 SVG（20×20，粉描边1.5）
│  │  ├─ DragHandle.vue                # ⠿ 手柄（编辑态显形）
│  │  ├─ ContextMenu.vue               # 右键菜单（添加/移除/新建分组）
│  │  ├─ PlayerControls.vue            # 进度条/倍速/音量
│  │  ├─ SpeedMenu.vue                 # 0.5/0.75/1/1.25/1.5/2（弹出式九宫格）
│  │  ├─ PlaylistPanel.vue             # 分组序/文件夹序 + 当前项跳转
│  │  ├─ VirtualGrid.vue               # 虚拟网格（PC/平板）
│  │  ├─ ResumeDialog.vue              # 续播三选一 + 「本次不再询问」
│  │  └─ ToastHost.vue                 # 瞬时反馈
│  ├─ composables/
│  │  ├─ useFolderTree.ts              # 目录树/面包屑派生（纯计算，可单测）
│  │  ├─ useEdgeGesture.ts             # 左亮 / 右音 竖滑
│  │  ├─ compatibility.ts              # 全屏/PiP/方向锁 能力矩阵
│  │  ├─ emptyStates.ts                # 4 套空态文案（可单测）
│  │  ├─ useVirtualGrid.ts             # chunkRows / rowCount（纯计算）
│  │  ├─ useDrag.ts                    # 三端拖拽（阈值 / 倾斜角 / 落点）
│  │  ├· useAutoHide.ts                # 3s 无操作 opacity 0
│  │  ├· useTauriFs.ts                 # invoke 封装
│  │  └· useResponsive.ts              # 360 / 600 / 840 / 1440 断点
│  └─ platform/                        # 同仓 flavor
│     ├· index.ts                      # usePlatform() 统一出口
│     ├· desktop.ts
│     └· android.ts
└─ src-tauri/
   ├─ Cargo.toml
   ├· tauri.conf.json
   └─ src/
      ├· main.rs
      ├· scan.rs        walkdir 递归 + 批量事务
      ├· thumbnail.rs   MediaStore / IShellFolder + ffmpeg 抽帧
      ├· db.rs          SQLite 建表 + 迁移
      ├· dup.rs         sha256 重复判定
      └· watch.rs       文件监听（可选开关）
```

## 5. V1 功能边界

### ✅ 做（P0）

- 手动选**多个根目录**，递归扫描子文件夹；启动增量扫描 + 手动刷新；文件监听为**可选开关**
- 三视图：目录树（默认展开 1 级、子节点懒加载）/ 文件夹卡片 / 搜索平铺
- 缩略图：系统媒体图优先 → 后台 ffmpeg 抽帧队列（并发 **2**）；`>500MB` 显示任务进度；**不常驻总进度条**
- 一级分组（`parent_id` 预留）、**多归属引用**、分组内拖拽排序（各端独立记忆）
- 重复标记：仅角标，**不删不移动**；文案固定「该文件共有 N 处副本」
- 播放器：进度条（**无悬浮缩略图**）、倍速 6 档、PC 横向音量、Android 右音量/左亮度竖滑、双击左右半屏 ±10s、长按临时 2x、控制栏 3s 淡出
- 续播：全局三选一（默认 `ask`）+ 「本次不再询问」**仅跳过本次，不改全局** + 末尾 30s 不存
- 播放列表：① 分组序（`sort_order`，前端不重排）② 文件夹序（文件名自然序）；单曲/列表循环
- 结束策略：设置项「播完自动播下一曲」；关闭时播完停在当前时间，单曲循环恒重播不受其影响
- Android 画中画；横屏锁屏键；平板「手势总控」开关
- 4 套空态：无分组 / 分组为空 / 目录无视频 / 搜索无结果（灰粉线稿 + 圆角）

### ❌ V1 不做

弹幕 · 在线播放 · 会员 · 云端同步 · 账号 · 嵌套分组 · 悬浮抽帧预览 · PC 画中画 · 转码/剪辑/字幕下载 · AI 识别 · 自动跨端同步 · 修改/删除磁盘文件

## 6. 数据层契约

```sql
videos(id TEXT PK, root_id, path, name, size, mtime, fingerprint, container, last_scanned_at, missing, dup_count)
groups(id, name, parent_id NULL)                    -- parentId 预留
group_items(group_id, video_id, sort_order)         -- 多归属引用
play_progress(video_id, pos_sec, updated_at)        -- 末尾30s存0
scan_tasks(id, root_path, status, processed, total, started_at)
```

- **重复判定**：采样 `sha256(头 64KB + 中 64KB + 尾 64KB)`（<192KB 全量），`COUNT(*) = N`；失联条目（`missing=1`）不参与计数
- **增量 diff**：本次没扫到且路径访问不到的条目标 `missing=1`（不删行）；列表与重复计数都过滤 `missing=0`；取消或目录读不全时不判失联
- **扫描写入**：每 **200 项或 150ms** 批量事务提交
- **缩略图**：路径存 `thumb_path`；位图**不**走主消息通道
- **索引**：`videos(path)`、`group_items(group_id, sort_order)`、`play_progress(video_id)`

## 7. 设计令牌（Tailwind 配置须一致）

```css
--c-pink: #fb7299; /* 仅：进度条 / 选中态 / 角标 / 主按钮 / 选中竖条 */
--c-bg-light: #f4f5f7;
--c-bg-dark: #1c1f26;
--radius-card: 12px;
--radius-btn: 8px;
--radius-pop: 16px;
--space: 8pt 网格 (8 / 16 / 24) 字号：标题 16 / 正文 14 / 角标 12 / 路径 11 (灰)
  字重：400 / 500 / 600（禁用 700） 动效：淡出 200ms ease-out · 拖影 120ms ·
  落位 160ms spring;
```

**重复角标**：右上角两个半透明重叠胶片 SVG，20×20px，粉描边 1.5px，距右上 6px；hover/长按气泡 160ms 淡入，文案**严格**为「该文件共有 N 处副本」。

**拖拽阈值**：移动 >8px 进入 dragging；倾斜角 手机 8° / 平板 10° / PC 12°；落点粉虚线描边 2px。

## 8. Tauri 桥接约定

| invoke             | 入参               | 返回 / 流                                                                                                                                                                                          |
| ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_roots`       | void               | `RootMeta[]`（含 `videoCount`，侧栏目录树根节点数字）                                                                                                                                              |
| `scan_dirs`        | `{paths:string[]}` | Channel `{processed, total}`                                                                                                                                                                       |
| `get_tree`         | `{rootIds}`        | 树节点（1 级）                                                                                                                                                                                     |
| `ensure_thumb`     | `{videoId}`        | `thumb_path`                                                                                                                                                                                       |
| `list_group_items` | `{groupId}`        | 按 `sort_order`                                                                                                                                                                                    |
| `grant_asset_root` | `{root}`           | `AssetGrant`（动态放行）                                                                                                                                                                           |
| `list_asset_rules` | void               | 当前放行规则表（§12.1）                                                                                                                                                                            |
| `probe_video`      | `{path}`           | `VideoProbe` 播放源自检（只读文件头：存在/大小/容器/编码；MP4/AVI 内联解析，不依赖 ffmpeg；含可复制的转换命令）                                                                                    |
| `remux_to_cache`   | `{path}`           | `RemuxResult` 把放不了但救得回的文件转封装到**应用缓存**（源文件不动；缓存 LRU 5GB，跳过 10 分钟内用过的）；**桌面端专属**，Android / iOS 直接回 `error / unsupported_platform`（见 §10 能力边界） |
| `list_dirs`        | `{path?}`          | `DirEntryView[]` 列一层子目录（`path` 为空给存储根候选）。**移动端选目录专用**：dialog 插件在移动端没有目录选择器，改由前端逐级浏览 + 本命令取**真实文件路径**（详见 `src/dirs.rs` 头注）          |

- 动态资源放行**仅对非 iOS/Android 目标生效**，移动端沿用既有逻辑不改（技术方案 §12.1）
- 远程脚本 / CDN 样式 / 插件包**不在动态放行范围内**，它们属于 CSP 与网络白名单约束| `set_progress` | `{videoId, pos}` | void |
  | `get_resume_state` | `{videoId, duration}` | `{pos, showDialog}` |

- 扫描进度**必须 Channel 流式**，禁止轮询
- 所有路径操作**只读**；禁止暴露 `remove_file` / `rename` / `move`

## 9. 三端断点（`useResponsive.ts`）

| 宽度       | 形态                   | 布局                            |
| ---------- | ---------------------- | ------------------------------- |
| `<600`     | 手机                   | 底部 4 Tab + 2 列 + `⠿` 手柄    |
| `600–839`  | 手机竖屏（平板竖屏同） | 退化为 2 列 + 底部 Tab          |
| `840–1439` | 平板横                 | 左 280dp 树 + 右 3 列，跨列拖拽 |
| `≥1440`    | PC                     | 左 200px 导航 + 4 列 + 面包屑   |

> 平板与手机**同包**，仅靠断点切换，不单独打包。

## 10. 开发约定

- 提交前：`pnpm lint && pnpm typecheck`
- 前端测试：`pnpm test`（vitest；store 测试整体 `vi.mock` 掉 `@/bridge/commands`；组件测试用 `@vue/test-utils` + jsdom，文件头加 `// @vitest-environment jsdom`）
- E2E：`pnpm test:e2e`（Playwright，默认用系统 Chrome；CI 用 `PW_CHANNEL=bundled` + `playwright install chromium`）。IPC 在 `e2e/fixtures.ts` 打桩，媒体解码与真机二进制不在范围内
- Rust 测试：`cargo test --lib`（纯函数 + 内存 SQLite 集成 + 临时目录指纹采样）
- Rust：`cargo clippy -- -D warnings`
- 离线审计：`pnpm audit:offline`（依赖/源码/产物/CSP/内联样式/权限一致性/asset scope/外部命令/Android manifest 共十一项，失败 exit 1）
- 权限最小化：Tauri 插件只用 `dialog`；文件读写走 Rust `std::fs`、SQLite 走 `rusqlite`（含迁移），前端不得引入 `plugin-fs` / `plugin-sql`，`capabilities/*.json` 声明的权限必须在代码里真的用到

- 真机验证项：Android 13 分区存储选目录、4K 硬解兜底 toast、平板边缘误触、抽帧并发 2
- 性能基线（设计值，真机回填）：10 万文件首扫 ≤180s、增量 ≤8s、PC 包 <15MB、Android APK <12MB、常驻内存 PC 250MB / Android 220MB

### Android 构建与调试

- **启动唯一入口**：`pnpm dev:android`（= `tauri android dev`）——CLI 负责起 vite + Gradle 构建 + `adb reverse` + 装包启动。**禁止在 Android Studio 里点 Run**：dev 模式前端由 `devUrl http://127.0.0.1:1420` 提供（§8），AS 既不启 vite 也不做 reverse，装上去必然是 `ERR_CONNECTION_REFUSED` 白屏。
- **Android Studio 的正确用法**：只跑 Gradle Sync，用来索引工程与看 Logcat；它与 CLI 共用 Gradle 缓存，互不干扰。
- **环境前置**：JDK **21**（`gen/android/gradle/gradle-daemon-jvm.properties` 硬性规定 daemon JVM 为 21，缺了 Gradle 会去 api.foojay.io 拉 ~200MB，国内慢到基本不可用）；建议先装 Temurin 21，并在 `~/.gradle/gradle.properties` 写 `org.gradle.java.installations.paths=<JDK21 路径>` 让 Gradle 直接用本地的。另需 `ANDROID_HOME`、`platforms;android-37.0`、`build-tools;37.0.0`、`ndk;26.3.11579264`，以及四个 target：`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`。
- **Gradle 镜像（国内必配）**：`gen/android/gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 改为 `https://mirrors.cloud.tencent.com/gradle/<版本>-bin.zip`。实测 services.gradle.org 约 0.25MB/s、腾讯镜像 12.4MB/s（140MB：11 分钟 → 11 秒）。**重跑 `tauri android init` 会覆盖该文件，需重新改**。
- **平台版本命名坑**：`app/build.gradle.kts` 写 `compileSdk = 37`，但对应的 SDK 包叫 `platforms;android-37.0`（AGP 9 起带 minor）。报 `Failed to find target with hash string 'android-37'` 时先确认这个包在不在。
- **Rust 入口必须带移动端注解**：`lib.rs::run` 上的 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 少了就很晚才炸——Rust 全部编完、Gradle 把 `.so` symlink 进 `jniLibs` 之后才报 `does not include required runtime symbols`，极易被误读成 AGP / NDK 的锅。
- **Kotlin 增量缓存跨盘会炸**：插件的 Kotlin 源码在 cargo registry（通常 C:\）、工程在别的盘时，建索引抛 `this and base files have different roots`，随后回退到 non-daemon 全量重编（一屏 Suppressed 异常）。`gen/android/gradle.properties` 已置 `kotlin.incremental=false`——注意 `tauri android init` 会覆盖该文件。
- **dev server 必须监听 0.0.0.0**：Android 上 CLI 会把 devUrl 的 host 换成局域网 IP，前端若钉死 `127.0.0.1`，CLI 会一直停在 `Waiting for your frontend dev server to start`，**APK 连构建都不会开始**。`vite.config.ts` 已按 `TAURI_ENV_PLATFORM` 分岔（桌面仍钉 IPv4 防 WebView2 白屏）。若配完之后仍卡住，十有八九是 Windows 防火墙拦了 1420 入站。
- 拉 androidx 依赖偏慢时，可在 `build.gradle.kts` 的仓库列表前插入阿里云 maven 镜像。

### Android / iOS 能力边界（V1 现状）

- **选目录不走 dialog 插件**：dialog 的移动端实现只有 `showFilePicker` / `showMessageDialog` / `saveFileDialog` 三个命令，**没有目录选择器**，且 `showFilePicker` 返回的是 `content://` URI。移动端统一走 `@/stores/dirPicker`（平台判断收口在 `pick()`）：面板逐级浏览 + Rust `list_dirs`，取**真实文件路径**，因此 `scan.rs` 的 walkdir、`probe`、指纹采样、`<video>` 播放源都不必为 content:// 重写。代价是必须声明 `MANAGE_EXTERNAL_STORAGE`（**只能用系统设置页开关**，`MainActivity.kt` 负责首次引导）——本项目侧载分发（C2），不受商店对该敏感权限的上架限制。
- **这三类文件属于 CLI 生成，`tauri android init` 会被覆盖**：`gen/android/gradle/wrapper/gradle-wrapper.properties`（镜像源）、`gen/android/gradle.properties`（`kotlin.incremental=false`）、`AndroidManifest.xml` 的自定义部分。重跑 init 后要按 §10 逐项恢复。

- **转封装不可用**：APK 内不打包 ffmpeg（与 §1.2 的 APK <12MB 冲突），且 Android 10+ 应用私有目录挂载 noexec、`std::process::Command` 起不了其中的二进制。`ffmpeg::platform_supports_ffmpeg()` 对 Android/iOS 恒为 false，`remux_to_cache` 直接返回 `error / unsupported_platform`。界面须给 VLC / MX Player 兜底建议，**不得**用 `ffmpeg_missing`（那是"桌面端没装"的语义）。
- **asset 放行不适用**：`assets::dynamic_grant_supported()` 对 Android/iOS 为 false，`grant_asset_root` 回 `skipped_mobile`。播放 store 在移动端跳过这段 IPC（见 `PlatformApi.needsAssetGrant`），失败文案显示「本平台不适用」而非「未放行」——后者会把人往授权方向带偏。
- **抽帧无源**：Android 上系统缩略图分支是 `cfg(not(windows))` 恒失败、ffmpeg 也没有，卡片一律"无封面"。要出图须走 Kotlin MediaStore 插件（§3.3）。

## 11. 禁止清单（AI 生成代码/UI 时硬拦截）

- 不写任何远端网络请求
- 不引入弹幕、登录、VIP 角标、网盘蓝、悬浮缩略图
- 不出现全粉卡片、字重 700、非 8pt 间距、圆角非 12px
- 不用 `createWebHistory`
- 不调用删除 / 移动 / 重命名文件 API
- 不自动同步多端数据
- **不在移动端调用 dialog 插件的目录选择器**（`open({ directory: true })`）：它根本不存在，真机 reject `Folder picker is not implemented on mobile`。移动端一律走 `@/stores/dirPicker`
- 不嵌套分组（仅保留 `parent_id` 字段）
- 不生成乱码/伪文字/水印的 UI

## 12. 开发顺序（建议）

1. `src-tauri` 建表 + `scan.rs` 跑通 → **先真机**
2. Pinia `scan` / `groups` / `player` store
3. `HomePC` / `HomeMobile` / `TabletSplit` + `VideoCard` / `DupBadge`
4. `Player.vue` 控制栏 + 手势 + `ResumeDialog`
5. 4 套空态 + 设置页（续播三选一 / 手势总控 / 缩略图开关）
6. Android `.apk` 侧载验证 → PC 打包

---

📌 **改本文件须同步**：`docs/影栈-本地视频播放器_技术方案.md` §5/§6/§8 与 `docs/组件规范表.xlsx` 设计令牌。
