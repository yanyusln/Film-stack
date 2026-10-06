// 目录选择：**仅桌面端可用**。
// dialog 插件的 Android 实现（`DialogPlugin.kt`）只有 showFilePicker / showMessageDialog /
// saveFileDialog 三个命令，**没有目录选择器**——移动端调用会 reject
// `Folder picker is not implemented on mobile`，且即使能选文件，返回的是 `content://` URI。
// 移动端改走 `@/stores/dirPicker`（前端逐级浏览 + Rust `list_dirs`，拿真实文件路径），
// 平台分岔收口在 `pick()` 这一处（技术方案 §3.3）。
import { open } from "@tauri-apps/plugin-dialog";

export async function selectDirectory(): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    title: "选择影片目录",
  });
  return typeof picked === "string" ? picked : null;
}
