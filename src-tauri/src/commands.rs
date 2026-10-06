// 影栈 Rust 命令层（W1-3/W1-4）。因 tauri-plugin-sql 2.5 的连接池查询方法为 crate-private，
// 消费端无法直接调用，故用 rusqlite 直连同一 SQLite 文件（插件存于 app_config_dir/videoplayer.db）。
// DB 连接/迁移/批量写入/指纹/重复计数见 crate::db（W2-1/W2-4）。
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use walkdir::WalkDir;

#[derive(Default)]
pub struct AppState {
    pub cancel: Arc<Mutex<HashSet<String>>>,
    pub realtime: Arc<Mutex<bool>>,
    // W2-2 缩略图抽帧并发计数（上限 2）；用原子量避免 MutexGuard 跨 await
    pub thumb_active: Arc<AtomicUsize>,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ScanMode {
    Incremental,
    Manual,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanInput {
    pub task_id: String,
    pub root_ids: Vec<String>,
    pub mode: ScanMode,
    #[serde(default)]
    pub ignore_ext: Vec<String>,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
}

fn default_max_depth() -> usize {
    32
}

#[derive(serde::Serialize, Clone, Default)]
pub struct ScanProgress {
    pub processed: u32,
    pub total: u32,
}

#[derive(serde::Serialize, Default)]
pub struct ScanSummary {
    pub roots: usize,
    pub added: u32,
    pub updated: u32,
    pub removed: usize,
    pub errors: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct RootMeta {
    pub id: String,
    pub label: String,
    pub path: String,
    pub enabled: bool,
    /// 该根下 `missing = 0` 的视频数，供目录树显示「电影 (4)」（设计稿 PC/平板侧栏）。
    /// 命中 `ix_videos_missing (root_id, missing)` 索引，单根一次 COUNT，不做全表扫描。
    #[serde(rename = "videoCount")]
    pub video_count: u32,
}

pub(crate) struct VideoRow {
    pub(crate) id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) size: i64,
    pub(crate) mtime: i64,
    pub(crate) fingerprint: Option<String>,
    /// 真实容器（读文件头判定，非扩展名）：供列表页提前标出「内置播放器放不了」的文件
    pub(crate) container: Option<String>,
    pub(crate) scanned: i64,
}

pub(crate) const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ogv", "rm",
    "vob", "m2ts",
];

/// 扩展名归一化：去前导点 + 小写。ignore 名单与白名单共用同一口径，避免 ".MP4" 漏网。
pub(crate) fn normalize_ext(ext: &str) -> String {
    ext.trim_start_matches('.').to_lowercase()
}

/// 是否收录：命中 ignore 名单直接排除，其余按视频白名单（技术方案 §8.1）。
pub(crate) fn should_include(ext: &str, ignore: &HashSet<String>) -> bool {
    let e = normalize_ext(ext);
    if e.is_empty() || ignore.contains(&e) {
        return false;
    }
    VIDEO_EXTS.contains(&e.as_str())
}

/// 视频主键：`v1_` + sha256(root:path) 前 16 位。路径变化即新条目（只读扫描，无迁移逻辑）。
pub(crate) fn video_id(root_id: &str, path: &str) -> String {
    format!(
        "v1_{}",
        &crate::db::to_hex(&Sha256::digest(format!("{}:{}", root_id, path).as_bytes()))[..16]
    )
}

#[tauri::command]
pub async fn list_roots(app: AppHandle) -> Result<Vec<RootMeta>, String> {
    let conn = crate::db::open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.label, r.path, r.enabled, \
             (SELECT COUNT(*) FROM videos v WHERE v.root_id = r.id AND v.missing = 0) \
             FROM roots r ORDER BY r.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RootMeta {
                id: row.get(0)?,
                label: row.get(1)?,
                path: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                video_count: row.get::<_, i64>(4)?.max(0) as u32,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn add_roots(paths: Vec<String>, app: AppHandle) -> Result<Vec<RootMeta>, String> {
    let conn = crate::db::open_db(&app)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let mut created = Vec::new();
    for p in paths {
        if p.trim().is_empty() {
            continue;
        }
        let id = format!(
            "rt_{}",
            &crate::db::to_hex(&Sha256::digest(p.as_bytes()))[..16]
        );
        let label = Path::new(&p)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&p)
            .to_string();
        conn.execute(
            "INSERT OR IGNORE INTO roots (id, label, path, enabled, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
            rusqlite::params![id, label, p, now],
        )
        .map_err(|e| e.to_string())?;
        // 动态放行：静态 scope 覆盖不到用户刚选的目录，不补齐的话播放页/封面取不到文件
        crate::assets::grant(&app, &p);
        created.push(RootMeta {
            id,
            label,
            path: p,
            // 刚建目录还没扫，条数从 0 起（前端随后跑增量扫描并刷新）
            video_count: 0,
            enabled: true,
        });
    }
    Ok(created)
}

#[tauri::command]
pub async fn remove_root(root_id: String, app: AppHandle) -> Result<(), String> {
    let conn = crate::db::open_db(&app)?;
    let path: String = conn
        .query_row(
            "SELECT path FROM roots WHERE id = ?1",
            rusqlite::params![root_id],
            |r| r.get(0),
        )
        .unwrap_or_default();
    if !path.is_empty() {
        crate::assets::revoke(&app, &path);
    }
    conn.execute(
        "DELETE FROM videos WHERE root_id = ?1",
        rusqlite::params![root_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM roots WHERE id = ?1",
        rusqlite::params![root_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cancel_scan(task_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.cancel.lock().unwrap().insert(task_id);
    Ok(())
}

#[tauri::command]
pub async fn set_realtime(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    *state.realtime.lock().unwrap() = enabled;
    Ok(())
}

#[tauri::command]
pub async fn list_videos(
    root_id: String,
    app: AppHandle,
) -> Result<Vec<crate::db::VideoMetaRow>, String> {
    let conn = crate::db::open_db(&app)?;
    crate::db::list_videos(&conn, &root_id)
}

// ---- 分组（W3-1）：仅一级、多归属引用、删除分组只删引用 ----

#[tauri::command]
pub async fn create_group(name: String, app: AppHandle) -> Result<crate::db::GroupRow, String> {
    let conn = crate::db::open_db(&app)?;
    crate::db::create_group(&conn, &name)
}

#[tauri::command]
pub async fn list_groups(app: AppHandle) -> Result<Vec<crate::db::GroupRow>, String> {
    let conn = crate::db::open_db(&app)?;
    crate::db::list_groups(&conn)
}

#[tauri::command]
pub async fn add_to_group(
    group_id: String,
    video_ids: Vec<String>,
    app: AppHandle,
) -> Result<u32, String> {
    let conn = crate::db::open_db(&app)?;
    crate::db::add_to_group(&conn, &group_id, &video_ids)
}

#[tauri::command]
pub async fn remove_from_group(
    group_id: String,
    video_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let conn = crate::db::open_db(&app)?;
    crate::db::remove_from_group(&conn, &group_id, &video_id)
}

#[tauri::command]
pub async fn set_group_order(
    group_id: String,
    video_id: String,
    sort_order: f64,
    app: AppHandle,
) -> Result<(), String> {
    let conn = crate::db::open_db(&app)?;
    crate::db::set_group_order(&conn, &group_id, &video_id, sort_order)
}

#[tauri::command]
pub async fn set_sort_order(
    group_id: String,
    ordered: Vec<String>,
    app: AppHandle,
) -> Result<crate::db::SortOrderResult, String> {
    let mut conn = crate::db::open_db(&app)?;
    crate::db::set_sort_order(&mut conn, &group_id, &ordered)
}

#[tauri::command]
pub async fn list_group_items(
    group_id: String,
    app: AppHandle,
) -> Result<Vec<crate::db::VideoMetaRow>, String> {
    let conn = crate::db::open_db(&app)?;
    crate::db::list_group_items(&conn, &group_id)
}

#[tauri::command]
pub async fn remove_group(group_id: String, app: AppHandle) -> Result<(), String> {
    let conn = crate::db::open_db(&app)?;
    crate::db::remove_group(&conn, &group_id)
}

#[tauri::command]
pub async fn scan_roots(
    input: ScanInput,
    on_event: Channel<ScanProgress>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanSummary, String> {
    let conn = crate::db::open_db(&app)?;
    let mut root_paths: Vec<(String, String)> = Vec::new();
    for rid in &input.root_ids {
        let path: String = conn
            .query_row(
                "SELECT path FROM roots WHERE id = ?1",
                rusqlite::params![rid],
                |r| r.get(0),
            )
            .map_err(|_| format!("根目录不存在: {}", rid))?;
        root_paths.push((rid.clone(), path));
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    // kind 跟着 mode 走：增量/手动在任务表里可区分（F3 / F4）
    let kind = match input.mode {
        ScanMode::Incremental => "incremental",
        ScanMode::Manual => "manual",
    };
    conn.execute(
        "INSERT INTO scan_tasks (id, root_id, kind, state, total, processed, started_at) VALUES (?1, ?2, ?3, 'running', 0, 0, ?4)",
        rusqlite::params![
            input.task_id,
            root_paths.first().map(|(id, _)| id.clone()).unwrap_or_default(),
            kind,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    let ignore: HashSet<String> = input
        .ignore_ext
        .iter()
        .map(|s| s.trim_start_matches('.').to_lowercase())
        .collect();
    let cancel = state.cancel.clone();
    let task_id = input.task_id.clone();
    let max_depth = input.max_depth;
    // 扫描代次：严格大于库里已有的 last_scanned_at，diff 才能分清「本次扫到 / 上次扫到」
    let scanned_at = crate::db::scan_generation(now, crate::db::max_scanned_at(&conn));
    // 增量：指纹能复用就不读盘；手动刷新强制重算（F3 / F4）
    let reuse = matches!(input.mode, ScanMode::Incremental);
    let app_for_blocking = app.clone();

    let summary = tauri::async_runtime::spawn_blocking(move || -> Result<ScanSummary, String> {
        let mut conn = crate::db::open_db(&app_for_blocking)?;
        let mut added: u32 = 0;
        let mut updated: u32 = 0;
        let mut processed: u32 = 0;
        let mut total: u32 = 0;
        let mut errors: Vec<String> = Vec::new();
        let mut cancelled = false;
        // 走完且没出错的根才做失联判定（技术方案 §8.1 异常兜底：读不全的目录不判失联）
        let mut diff_roots: Vec<String> = Vec::new();

        let mut tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut batch: Vec<VideoRow> = Vec::new();
        let mut last_flush = std::time::Instant::now();

        'roots: for (rid, rpath) in &root_paths {
            let errors_before = errors.len();
            let walker = WalkDir::new(rpath).max_depth(max_depth).follow_links(false);
            for entry in walker {
                if cancel.lock().unwrap().contains(&task_id) {
                    cancelled = true;
                    break 'roots;
                }
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        errors.push(e.to_string());
                        continue;
                    }
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                let p = entry.path();
                let ext = match p.extension().and_then(|s| s.to_str()) {
                    Some(e) => e.to_lowercase(),
                    None => continue,
                };
                if !should_include(&ext, &ignore) {
                    continue;
                }
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(e) => {
                        errors.push(format!("{}: {}", p.display(), e));
                        continue;
                    }
                };
                let size = meta.len() as i64;
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let name = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let canonical = p.to_string_lossy().to_string();
                let id = video_id(rid, &canonical);
                total += 1;
                batch.push(VideoRow {
                    id,
                    root_id: rid.clone(),
                    path: canonical,
                    name,
                    size,
                    mtime,
                    // 指纹/容器延后到 flush 时统一解析：增量模式下可复用旧值，省掉一次采样读盘
                    fingerprint: None,
                    container: None,
                    scanned: scanned_at,
                });
                let elapsed = last_flush.elapsed();
                if batch.len() >= 200 || elapsed.as_millis() >= 150 {
                    crate::db::resolve_fingerprints(&tx, &mut batch, reuse)?;
                    crate::db::flush_batch(&tx, &batch, &mut added, &mut updated)?;
                    tx.commit().map_err(|e| e.to_string())?;
                    tx = conn.transaction().map_err(|e| e.to_string())?;
                    processed += batch.len() as u32;
                    on_event
                        .send(ScanProgress {
                            processed,
                            total,
                        })
                        .ok();
                    batch.clear();
                    last_flush = std::time::Instant::now();
                }
            }
            if !cancelled && errors.len() == errors_before {
                diff_roots.push(rid.clone());
            }
        }

        if !batch.is_empty() {
            crate::db::resolve_fingerprints(&tx, &mut batch, reuse)?;
            crate::db::flush_batch(&tx, &batch, &mut added, &mut updated)?;
            processed += batch.len() as u32;
        }
        tx.commit().map_err(|e| e.to_string())?;

        // 增量 diff：取消时不跑（技术方案 §8.1「扫描被取消后不删除已有视频」），
        // 否则半次扫描会把没走到的文件全误标成失联。只标 missing 不删行（C1）。
        let mut removed = 0usize;
        if !cancelled {
            for rid in &diff_roots {
                removed += crate::db::mark_missing(&conn, rid, scanned_at)?;
            }
        }

        // W2-4：扫描完成后刷新重复计数（基于 fingerprint 分组，失联条目不参与）
        crate::db::refresh_dup_counts(&conn)?;

        on_event
            .send(ScanProgress {
                processed,
                total,
            })
            .ok();

        conn.execute(
            "UPDATE scan_tasks SET state = 'done', total = ?1, processed = ?2, finished_at = ?3 WHERE id = ?4",
            rusqlite::params![total, processed, scanned_at, task_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(ScanSummary {
            roots: root_paths.len(),
            added,
            updated,
            removed,
            errors,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ignore(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| normalize_ext(s)).collect()
    }

    #[test]
    fn normalize_ext_ignores_dots_and_case() {
        assert_eq!(normalize_ext("MP4"), "mp4");
        assert_eq!(normalize_ext(".mkv"), "mkv");
        assert_eq!(normalize_ext("..MKV"), "mkv");
        assert_eq!(normalize_ext(""), "");
    }

    #[test]
    fn whitelist_accepts_video_exts_only() {
        let none = HashSet::new();
        for e in ["mp4", "mkv", "MOV", ".webm", "m2ts"] {
            assert!(should_include(e, &none), "{e} 应收录");
        }
        for e in ["txt", "srt", "jpg", "exe", "", "."] {
            assert!(!should_include(e, &none), "{e} 不应收录");
        }
    }

    #[test]
    fn ignore_list_wins_over_whitelist() {
        let ig = ignore(&[".mp4", "MKV"]);
        assert!(!should_include("mp4", &ig));
        assert!(!should_include("mkv", &ig));
        assert!(should_include("avi", &ig), "名单外仍收录");
    }

    #[test]
    fn video_id_is_stable_and_scoped_to_root_and_path() {
        let a = video_id("r1", "D:\\v\\a.mp4");
        assert_eq!(a, video_id("r1", "D:\\v\\a.mp4"), "同一路径必须稳定");
        assert_ne!(a, video_id("r1", "D:\\v\\b.mp4"));
        assert_ne!(a, video_id("r2", "D:\\v\\a.mp4"), "同文件多根目录各自成条目");
        assert!(a.starts_with("v1_"));
        assert_eq!(a.len(), "v1_".len() + 16);
    }
}
