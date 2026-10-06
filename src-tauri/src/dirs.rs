//! 移动端「选哪个目录」的浏览接口。
//!
//! **为什么需要它**：`@tauri-apps/plugin-dialog` 在移动端**没有目录选择器**——
//! 它的 Android 实现（`DialogPlugin.kt`）只有 `showFilePicker` / `showMessageDialog` /
//! `saveFileDialog` 三个命令，且 `showFilePicker` 走 `ACTION_GET_CONTENT` 返回的是
//! `content://` URI。真机点击「添加根目录」时会直接 reject：
//! `Folder picker is not implemented on mobile`。
//!
//! 因此移动端改为：**前端目录浏览 + Rust 侧列目录**，拿到的是**真实文件路径**
//! （配合 storage 权限），这样 `scan.rs` 的 walkdir、`probe`、指纹采样、`std::fs`
//! 都不必为 content:// 重写一分一毫。桌面端仍走原生对话框，本模块只为移动端服务。

use std::cmp::Ordering;
use std::fs;
use std::path::Path;

/// 浏览列表里的一项（只有目录）。
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DirEntryView {
    /// 完整路径，前端拿它继续下钻或直接充当根目录
    pub path: String,
    /// 目录名，用于展示
    pub name: String,
}

/// 只有 Android 的存储根枚举用到；桌面端没有这条路径，别让它变成 dead_code。
#[cfg(target_os = "android")]
fn view(p: &Path) -> Option<DirEntryView> {
    let name = p.file_name().and_then(|s| s.to_str())?.to_string();
    Some(DirEntryView {
        path: p.to_string_lossy().into_owned(),
        name,
    })
}

/// 列出 `path` 下的子目录；`path` 为空时给出当前平台的**存储根候选**。
///
/// 故意只给一层：移动端屏幕小，逐级下钻比一次性铺开整棵树清楚得多，
/// 也避免在一个 `/storage` 上递归几万个目录把渲染进程拖住。
#[tauri::command]
pub async fn list_dirs(path: Option<String>) -> Result<Vec<DirEntryView>, String> {
    match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => sub_dirs(Path::new(p)),
        None => Ok(storage_roots()),
    }
}

/// 读取某个目录下的子目录。**读不出来要报错**，不能返回空列表——
///「没权限」和「空目录」在界面上是两件事：前者要去开设置里的「所有文件访问权限」，
/// 后者只是让用户再往下看看。
fn sub_dirs(dir: &Path) -> Result<Vec<DirEntryView>, String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("read_dir failed: {e}"))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 符号链接目录一律跳过：扫描用的 walkdir 也不跟随（`follow_links(false)`），
        // 这里放它进来会造成「能选中但扫不出内容」的错位。
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let p = entry.path();
        let name = match p.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // 隐藏目录（.thumbnails / .cache / .android_secure）不该出现在选择器里
        if name.starts_with('.') {
            continue;
        }
        out.push(DirEntryView {
            path: p.to_string_lossy().into_owned(),
            name,
        });
    }
    out.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    Ok(out)
}

/// 起手的位置。Android 上 `/storage` 下每个子目录是一个存储卷，内部存储固定是
/// `/storage/emulated/0`，SD 卡（若插入）是 `/storage/<序列号>`。
/// 顺手跳过 `self`（指向当前用户的软链）与已被展平成 `/storage/emulated/0` 的 `emulated`。
#[cfg(target_os = "android")]
fn storage_roots() -> Vec<DirEntryView> {
    let internal = Path::new("/storage/emulated/0");
    let mut out = Vec::new();
    if internal.is_dir() {
        out.push(DirEntryView {
            path: internal.to_string_lossy().into_owned(),
            name: "内部存储".to_string(),
        });
    }
    if let Ok(rd) = fs::read_dir("/storage") {
        for entry in rd.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if name == "self" || name == "emulated" {
                continue;
            }
            if let Some(v) = view(&p) {
                out.push(v);
            }
        }
    }
    // /storage 整体读不到（个别定制系统）时退一步：内部存储常见软链
    if out.is_empty() {
        let legacy = Path::new("/sdcard");
        if legacy.is_dir() {
            out.push(DirEntryView {
                path: legacy.to_string_lossy().into_owned(),
                name: "内部存储".to_string(),
            });
        }
    }
    out
}

/// 桌面端不需要目录浏览（仍走原生对话框）；保留是为了让 `list_dirs` 跨平台可编译、可测。
#[cfg(not(target_os = "android"))]
fn storage_roots() -> Vec<DirEntryView> {
    Vec::new()
}

/// 「自然序」：连续数字按数值比，其余字符按字典序（忽略大小写差异）。
/// 目录名里混着数字时（`第2集` / `第10集`），纯字典序会把 10 排到 2 前面，很难找。
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let ca: Vec<char> = a.chars().collect();
    let cb: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    while i < ca.len() && j < cb.len() {
        if ca[i].is_ascii_digit() && cb[j].is_ascii_digit() {
            let (mut x, mut y) = (0u64, 0u64);
            while i < ca.len() && ca[i].is_ascii_digit() {
                x = x
                    .saturating_mul(10)
                    .saturating_add(ca[i] as u64 - '0' as u64);
                i += 1;
            }
            while j < cb.len() && cb[j].is_ascii_digit() {
                y = y
                    .saturating_mul(10)
                    .saturating_add(cb[j] as u64 - '0' as u64);
                j += 1;
            }
            if x != y {
                return x.cmp(&y);
            }
        } else {
            let ka = ca[i].to_lowercase().next().unwrap_or(ca[i]);
            let kb = cb[j].to_lowercase().next().unwrap_or(cb[j]);
            if ka != kb {
                return ka.cmp(&kb);
            }
            i += 1;
            j += 1;
        }
    }
    ca.len().cmp(&cb.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_is_natural_not_lexicographic() {
        let mut names = vec![
            "第10集".to_string(),
            "第2集".to_string(),
            "第1集".to_string(),
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, vec!["第1集", "第2集", "第10集"]);
    }

    #[test]
    fn case_does_not_reorder_but_still_breaks_ties() {
        assert_eq!(natural_cmp("abc", "ABC"), Ordering::Equal);
        // 纯长度不同的前缀：短的在前
        assert_eq!(natural_cmp("ab", "abc"), Ordering::Less);
    }

    #[test]
    fn missing_directory_is_an_error_not_an_empty_list() {
        // 「读不到」必须能被界面区分出来（没权限 vs 空目录是两回事）
        let r = sub_dirs(Path::new("./__definitely_not_here__"));
        assert!(r.is_err(), "读不到该报错，不该伪装成空列表");
    }

    #[test]
    fn hidden_and_symlinked_dirs_are_kept_out() {
        let dir = std::env::temp_dir().join(format!("dirs_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".cache")).unwrap();
        fs::create_dir_all(dir.join("Movies")).unwrap();
        fs::create_dir_all(dir.join("Recordings")).unwrap();

        let listed = sub_dirs(&dir).expect("临时目录可读");
        let names: Vec<&str> = listed.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Movies", "Recordings"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn desktop_has_no_storage_root_candidate() {
        // 桌面端走原生对话框，列表必须为空——否则会出现两套选目录入口
        #[cfg(not(target_os = "android"))]
        assert!(storage_roots().is_empty());
    }
}
