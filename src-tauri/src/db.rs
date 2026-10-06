// 数据层仓储（W2-1/W2-4）。集中管理 SQLite 连接、迁移、批量写入、
// 重复指纹采样与重复计数刷新；commands.rs 仅做参数/通道编排。
// 因 tauri-plugin-sql 2.5 的连接池查询方法为 crate-private，这里用 rusqlite 直连同一 SQLite 文件
// （插件存于 app_config_dir/videoplayer.db），迁移用 execute_batch 多语句幂等执行。
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::commands::VideoRow;

const SAMPLE_LEN: u64 = 64 * 1024; // 头/中/尾各 64KB
const FULL_THRESHOLD: u64 = 192 * 1024; // <192KB 全量采样

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(_) => return Err("无法获取应用配置目录".to_string()),
    };
    let path = dir.join("videoplayer.db");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    apply_pragmas(&conn)?;
    // 外键必须在事务前开启且按连接生效：否则 group_items / play_progress 的 ON DELETE CASCADE 不生效，
    // 删除分组或根目录会留下孤儿引用（见技术方案 §6.1）。
    conn.execute_batch("PRAGMA foreign_keys = ON")
        .map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    run_migrations(&conn)?;
    Ok(conn)
}

/// 性能基准 PRAGMA（技术方案 §13.2）：WAL 让扫描写入与前端读取不互相阻塞；
/// `synchronous=NORMAL` 在 WAL 下不丢已提交事务；`temp_store=MEMORY` 避免排序落盘；
/// `cache_size=-64000` 约 64MB 页缓存。数值为启动基准，按平台实测再调。
/// `journal_mode` 会返回一行，故单独用 query_row；个别文件系统不支持 WAL 时降级，不致命。
pub fn apply_pragmas(conn: &Connection) -> Result<(), String> {
    let _: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .unwrap_or_else(|_| "unsupported".to_string());
    conn.execute_batch(
        "PRAGMA synchronous = NORMAL; \
         PRAGMA temp_store = MEMORY; \
         PRAGMA cache_size = -64000;",
    )
    .map_err(|e| e.to_string())
}

/// 幂等迁移：0001 建表（IF NOT EXISTS），0002/0003 追加列（用 pragma 守卫避免重复 ALTER）。
pub fn run_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(include_str!("../migrations/0001_init.sql"))
        .map_err(|e| e.to_string())?;
    ensure_column(
        conn,
        "videos",
        "dup_count",
        "ALTER TABLE videos ADD COLUMN dup_count INTEGER NOT NULL DEFAULT 1",
    )?;
    // 0003：增量 diff。本次没扫到且路径确实访问不到的条目标 missing=1，只标记不删行（C1）。
    ensure_column(
        conn,
        "videos",
        "missing",
        "ALTER TABLE videos ADD COLUMN missing INTEGER NOT NULL DEFAULT 0",
    )?;
    // 0004：扫描时记真实容器（见 migrations/0003_container.sql）。
    // 可空：老行未知，下次扫到时只读 12 字节补上，补完不再读。
    ensure_column(
        conn,
        "videos",
        "container",
        "ALTER TABLE videos ADD COLUMN container TEXT",
    )?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS ix_videos_scan ON videos (root_id, last_scanned_at); \
         CREATE INDEX IF NOT EXISTS ix_videos_missing ON videos (root_id, missing);",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 缺列才 ALTER：`pragma_table_info` 守卫，保证迁移重复执行幂等。
fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> Result<(), String> {
    let sql = format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name='{column}'");
    let has: i64 = conn
        .query_row(&sql, [], |r| r.get(0))
        .unwrap_or(0);
    if has == 0 {
        conn.execute_batch(ddl).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 批量 upsert：存在则更新 size/mtime/name/fingerprint，否则插入。每 200 项或 150ms 由调用方提交。
pub fn flush_batch(
    tx: &Connection,
    batch: &[VideoRow],
    added: &mut u32,
    updated: &mut u32,
) -> Result<(), String> {
    for v in batch {
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM videos WHERE id = ?1",
                rusqlite::params![v.id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if exists > 0 {
            tx.execute(
                "UPDATE videos SET size = ?2, mtime = ?3, name = ?4, fingerprint = ?5, container = ?6, last_scanned_at = ?7 WHERE id = ?1",
                rusqlite::params![v.id, v.size, v.mtime, v.name, v.fingerprint, v.container, v.scanned],
            )
            .map_err(|e| e.to_string())?;
            *updated += 1;
        } else {
            tx.execute(
                "INSERT INTO videos (id, root_id, path, name, size, mtime, fingerprint, container, last_scanned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![v.id, v.root_id, v.path, v.name, v.size, v.mtime, v.fingerprint, v.container, v.scanned],
            )
            .map_err(|e| e.to_string())?;
            *added += 1;
        }
    }
    Ok(())
}

/// 指纹采样（技术方案 §8.3）：头 64KB + 中 64KB + 尾 64KB；<192KB 全量。
/// 仅标记重复，不移动/删除；读取失败返回 None（降级为不参与重复判定）。
pub fn compute_fingerprint(path: &Path, size: u64) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let mut ctx = Sha256::new();
    let samples: Vec<(u64, u64)> = if size <= FULL_THRESHOLD {
        vec![(0, size)]
    } else {
        vec![
            (0, SAMPLE_LEN),
            (size / 2, SAMPLE_LEN),
            (size.saturating_sub(SAMPLE_LEN), SAMPLE_LEN),
        ]
    };
    for (off, len) in samples {
        if f.seek(SeekFrom::Start(off)).is_err() {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        if f.read_exact(&mut buf).is_err() {
            return None;
        }
        ctx.update(&buf);
    }
    Some(to_hex(&ctx.finalize()))
}

/// 刷新重复计数：先归 1，再对出现 >1 次的共同指纹批量置为实际副本数。
/// 一条 UPDATE...FROM 完成，避免 O(n^2)（技术方案 §8.3 / §14.2）。
/// 失联条目不参与计数：文件都不在了，不该再给别处的文件挂重复角标。
pub fn refresh_dup_counts(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE videos SET dup_count = 1 WHERE fingerprint IS NOT NULL",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "UPDATE videos SET dup_count = cnt.c \
         FROM (SELECT fingerprint, COUNT(*) AS c FROM videos WHERE fingerprint IS NOT NULL AND missing = 0 GROUP BY fingerprint) AS cnt \
         WHERE videos.fingerprint = cnt.fingerprint AND cnt.c > 1 AND videos.missing = 0",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- 增量扫描（F3 / 技术方案 §8.1）----

/// 扫描代次：必须**严格大于**库里已有的 last_scanned_at。
/// mtime 只有秒级精度，同一秒内的两次扫描拿 now 当戳会分不清「本次扫到 / 上次扫到」，diff 就废了。
pub fn scan_generation(now: i64, max_seen: i64) -> i64 {
    now.max(max_seen + 1)
}

pub fn max_scanned_at(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(last_scanned_at), 0) FROM videos", [], |r| {
        r.get(0)
    })
    .unwrap_or(0)
}

/// 指纹 + 容器解析：增量模式下 size+mtime 都没变、且库里已有指纹，就沿用旧值，
/// 省掉每文件 192KB 的采样读盘（10 万文件增量的主要成本）；否则按采样规则重算。
/// 容器同理沿用；**老库的 container 为 NULL 时补一次**（只读 12 字节，补完不再读），
/// 这样升级后不必全量重扫也能拿到容器。
/// `reuse=false`（手动全量刷新）强制重算。返回复用条数。
pub fn resolve_fingerprints(
    conn: &Connection,
    batch: &mut [VideoRow],
    reuse: bool,
) -> Result<usize, String> {
    let mut known: HashMap<String, (i64, i64, Option<String>, Option<String>)> = HashMap::new();
    if reuse && !batch.is_empty() {
        // id 由 video_id() 生成（十六进制），非外部输入
        let placeholders = vec!["?"; batch.len()].join(",");
        let sql = format!(
            "SELECT id, size, mtime, fingerprint, container FROM videos WHERE id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params: Vec<&dyn rusqlite::ToSql> = batch
            .iter()
            .map(|v| &v.id as &dyn rusqlite::ToSql)
            .collect();
        let rows = stmt
            .query_map(params.as_slice(), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, size, mtime, fp, container) = row.map_err(|e| e.to_string())?;
            known.insert(id, (size, mtime, fp, container));
        }
    }

    let mut reused = 0usize;
    for v in batch.iter_mut() {
        if let Some((size, mtime, fp, container)) = known.get(&v.id) {
            if *size == v.size && *mtime == v.mtime {
                if let Some(fp) = fp.clone() {
                    v.fingerprint = Some(fp);
                    // 文件没变，容器沿用；老行没记过就补一次（12 字节，之后永不再读）
                    v.container = container
                        .clone()
                        .or_else(|| crate::probe::container_of_path(Path::new(&v.path)));
                    reused += 1;
                    continue;
                }
            }
        }
        v.fingerprint = compute_fingerprint(Path::new(&v.path), v.size.max(0) as u64);
        v.container = crate::probe::container_of_path(Path::new(&v.path));
    }
    Ok(reused)
}

/// 增量 diff（技术方案 §8.1「remove videos missing from current snapshot unless path still accessible」）：
/// ① 本次扫到的先复位；② 本次没扫到、且路径确实访问不到的标 missing=1。
/// 只标记不删行（C1：不动磁盘，也不抹掉用户的分组引用）。返回本次新增失联条数。
///
/// 两个保守条件：路径必须是绝对文件系统路径（Android 的 `content://` URI 不参与判定，
/// 免得整组被误标），且 `exists()` 为假——临时卸载/权限波动不会误伤。
pub fn mark_missing(conn: &Connection, root_id: &str, gen: i64) -> Result<usize, String> {
    conn.execute(
        "UPDATE videos SET missing = 0 WHERE root_id = ?1 AND last_scanned_at >= ?2 AND missing = 1",
        rusqlite::params![root_id, gen],
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, path FROM videos WHERE root_id = ?1 AND last_scanned_at < ?2 AND missing = 0",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![root_id, gen], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut gone: Vec<String> = Vec::new();
    for row in rows {
        let (id, path) = row.map_err(|e| e.to_string())?;
        let p = Path::new(&path);
        if p.is_absolute() && !p.exists() {
            gone.push(id);
        }
    }

    if !gone.is_empty() {
        // 一条语句搞定：单语句自带原子性，也避免在只读引用上开事务
        let placeholders = vec!["?"; gone.len()].join(",");
        let sql = format!("UPDATE videos SET missing = 1 WHERE id IN ({placeholders})");
        let params: Vec<&dyn rusqlite::ToSql> = gone
            .iter()
            .map(|id| id as &dyn rusqlite::ToSql)
            .collect();
        conn.execute(&sql, params.as_slice())
            .map_err(|e| e.to_string())?;
    }
    Ok(gone.len())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetaRow {
    pub id: String,
    pub root_id: String,
    pub name: String,
    pub path: String,
    pub size: i64,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub media_type: Option<String>,
    pub fingerprint: Option<String>,
    pub thumbnail_state: String,
    pub thumbnail_path: Option<String>,
    #[serde(rename = "duplicateCount")]
    pub dup_count: i64,
    /// 真实容器（读文件头判定）：`avi` / `mp4 (isom)` …；老行未知为 NULL
    pub container: Option<String>,
}

/// 列出某根目录下的视频（供前端视频网格 / 重复角标使用，W2-4/W3）。
pub fn list_videos(conn: &Connection, root_id: &str) -> Result<Vec<VideoMetaRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, root_id, name, path, size, duration, width, height, media_type, \
             fingerprint, thumbnail_state, thumbnail_path, dup_count, container \
             FROM videos WHERE root_id = ?1 AND missing = 0 ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![root_id], |row| {
            Ok(VideoMetaRow {
                id: row.get(0)?,
                root_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                size: row.get(4)?,
                duration: row.get(5)?,
                width: row.get(6)?,
                height: row.get(7)?,
                media_type: row.get(8)?,
                fingerprint: row.get(9)?,
                thumbnail_state: row.get(10)?,
                thumbnail_path: row.get(11)?,
                dup_count: row.get(12)?,
                container: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    // V1 仅一级分组：parent_id 恒为 null，字段预留（技术方案 §6.1 / §7.3）
    pub parent_id: Option<String>,
    pub sort_order: f64,
}

/// 新建分组：追加到末尾（sort_order 取当前最大 +1000，便于小数插入）。
pub fn create_group(conn: &Connection, name: &str) -> Result<GroupRow, String> {
    let now = now_secs();
    let id = format!(
        "gp_{}",
        &to_hex(&Sha256::digest(format!("{}:{}", name, now).as_bytes()))[..16]
    );
    let order: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0.0) + 1000.0 FROM groups",
            [],
            |r| r.get(0),
        )
        .unwrap_or(1000.0);
    conn.execute(
        "INSERT INTO groups (id, name, parent_id, sort_order, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
        rusqlite::params![id, name, order, now, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(GroupRow {
        id,
        name: name.to_string(),
        parent_id: None,
        sort_order: order,
    })
}

pub fn list_groups(conn: &Connection) -> Result<Vec<GroupRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, parent_id, sort_order FROM groups ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(GroupRow {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort_order: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 加入分组（多归属：同一视频可属于多个分组，靠 PK(group_id, video_id) 去重）。
pub fn add_to_group(
    conn: &Connection,
    group_id: &str,
    video_ids: &[String],
) -> Result<u32, String> {
    let now = now_secs();
    let mut n = 0u32;
    for vid in video_ids {
        let order: f64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0.0) + 1000.0 FROM group_items WHERE group_id = ?1",
                rusqlite::params![group_id],
                |r| r.get(0),
            )
            .unwrap_or(1000.0);
        let c = conn
            .execute(
                "INSERT OR IGNORE INTO group_items (group_id, video_id, sort_order, added_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![group_id, vid, order, now],
            )
            .map_err(|e| e.to_string())?;
        n += c as u32;
    }
    Ok(n)
}

/// 移出分组：只删引用，不动 videos（技术方案 §8.4）。
pub fn remove_from_group(conn: &Connection, group_id: &str, video_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM group_items WHERE group_id = ?1 AND video_id = ?2",
        rusqlite::params![group_id, video_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 单点写入：调用方已算好 key 时使用（右键菜单等）。拖拽整列提交统一走 set_sort_order。
pub fn set_group_order(
    conn: &Connection,
    group_id: &str,
    video_id: &str,
    sort_order: f64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE group_items SET sort_order = ?3 WHERE group_id = ?1 AND video_id = ?2",
        rusqlite::params![group_id, video_id, sort_order],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- W3-2 排序持久化（技术方案 §7.3 / §8.4）----
// 小数插入 (prev+next)/2，只写真正变化的项；冲突超限或浮点间隙耗尽时整组重建为 1000 步长整数。
// 规划与落库分离：plan_sort_order 为纯函数（不持连接），可单测；set_sort_order 在单事务内提交。
const ORDER_STEP: f64 = 1000.0;
const MAX_ORDER_CONFLICTS: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub struct SortWrite {
    pub video_id: String,
    pub sort_order: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SortPlan {
    pub writes: Vec<SortWrite>,
    pub rebuilt: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortOrderResult {
    pub group_id: String,
    pub written: u32,
    pub rebuilt: bool,
}

fn fits_between(key: f64, lower: Option<f64>, upper: Option<f64>) -> bool {
    match (lower, upper) {
        (Some(lo), Some(hi)) => key > lo && key < hi,
        (Some(lo), None) => key > lo,
        (None, Some(hi)) => key < hi,
        (None, None) => true,
    }
}

/// 整组重建：1000 步长整数，消除历史小数累积（仅在冲突/精度耗尽时触发）。
fn rebuild_plan(ordered: &[String]) -> SortPlan {
    SortPlan {
        writes: ordered
            .iter()
            .enumerate()
            .map(|(i, id)| SortWrite {
                video_id: id.clone(),
                sort_order: ORDER_STEP * (i as f64 + 1.0),
            })
            .collect(),
        rebuilt: true,
    }
}

/// 由「当前 key 表 + 目标顺序」推导最小写入集。
/// `current` 为分组现有引用（video_id, sort_order），`ordered` 为目标顺序且必须与其构成同一集合。
pub fn plan_sort_order(current: &[(String, f64)], ordered: &[String]) -> Result<SortPlan, String> {
    let keys: HashMap<&str, f64> = current
        .iter()
        .map(|(id, order)| (id.as_str(), *order))
        .collect();
    let requested: HashSet<&str> = ordered.iter().map(|s| s.as_str()).collect();
    if requested.len() != ordered.len()
        || requested.len() != keys.len()
        || !requested.iter().all(|id| keys.contains_key(id))
    {
        return Err("分组内容与提交的排序不一致，请刷新后重试".to_string());
    }
    let n = ordered.len();
    if n == 0 {
        return Ok(SortPlan {
            writes: Vec::new(),
            rebuilt: false,
        });
    }

    // 冲突判定：已落库 key 升序后相邻无法区分（含重复 key），>50 视为小数精度耗尽 -> 整组重建
    let mut stored: Vec<f64> = keys.values().copied().collect();
    stored.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let collisions = stored
        .windows(2)
        .filter(|w| !matches!(w[1].partial_cmp(&w[0]), Some(std::cmp::Ordering::Greater)))
        .count();
    if collisions > MAX_ORDER_CONFLICTS {
        return Ok(rebuild_plan(ordered));
    }

    let old: Vec<f64> = ordered.iter().map(|id| keys[id.as_str()]).collect();
    // suffix_min[i]：位置 i 之后元素的最小旧 key（右侧在本趟尚未改写）。作为插入上界，避免 O(n^2) 扫描。
    let mut suffix_min = vec![f64::INFINITY; n];
    for i in (0..n - 1).rev() {
        suffix_min[i] = old[i + 1].min(suffix_min[i + 1]);
    }

    let mut writes: Vec<SortWrite> = Vec::new();
    let mut prev: Option<f64> = None;
    for i in 0..n {
        let id = ordered[i].as_str();
        let lower = prev;
        let upper = if suffix_min[i].is_infinite() {
            None
        } else {
            Some(suffix_min[i])
        };
        // 旧 key 仍严格落在区间内则不写；否则按 (prev+next)/2 取中值（缺一侧则 ±1000）
        let key = if fits_between(old[i], lower, upper) {
            old[i]
        } else {
            let candidate = match (lower, upper) {
                (Some(lo), Some(hi)) => (lo + hi) / 2.0,
                (Some(lo), None) => lo + ORDER_STEP,
                (None, Some(hi)) => hi - ORDER_STEP,
                (None, None) => 0.0,
            };
            if !fits_between(candidate, lower, upper) {
                // 两侧已无可表示的浮点间隙，继续小数插入会产出并列 key -> 整组重建
                return Ok(rebuild_plan(ordered));
            }
            writes.push(SortWrite {
                video_id: id.to_string(),
                sort_order: candidate,
            });
            candidate
        };
        prev = Some(key);
    }
    Ok(SortPlan {
        writes,
        rebuilt: false,
    })
}

/// 分组现有顺序（仅包含 videos 仍存在的引用，与 list_group_items 口径一致）。
fn load_group_orders(conn: &Connection, group_id: &str) -> Result<Vec<(String, f64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT gi.video_id, gi.sort_order FROM group_items gi \
             JOIN videos v ON v.id = gi.video_id WHERE gi.group_id = ?1 ORDER BY gi.sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![group_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 提交分组整体顺序：单事务写入，任一步失败整体回滚，前端据此回滚内存顺序并 toast（§8.4）。
pub fn set_sort_order(
    conn: &mut Connection,
    group_id: &str,
    ordered: &[String],
) -> Result<SortOrderResult, String> {
    let plan = plan_sort_order(&load_group_orders(conn, group_id)?, ordered)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for w in &plan.writes {
        tx.execute(
            "UPDATE group_items SET sort_order = ?3 WHERE group_id = ?1 AND video_id = ?2",
            rusqlite::params![group_id, w.video_id, w.sort_order],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SortOrderResult {
        group_id: group_id.to_string(),
        written: plan.writes.len() as u32,
        rebuilt: plan.rebuilt,
    })
}

/// 分组内视频（按 sort_order），返回与 list_videos 一致的元数据。
pub fn list_group_items(conn: &Connection, group_id: &str) -> Result<Vec<VideoMetaRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT v.id, v.root_id, v.name, v.path, v.size, v.duration, v.width, v.height, \
             v.media_type, v.fingerprint, v.thumbnail_state, v.thumbnail_path, v.dup_count, \
             v.container \
             FROM group_items gi JOIN videos v ON v.id = gi.video_id \
             WHERE gi.group_id = ?1 AND v.missing = 0 ORDER BY gi.sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![group_id], |row| {
            Ok(VideoMetaRow {
                id: row.get(0)?,
                root_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                size: row.get(4)?,
                duration: row.get(5)?,
                width: row.get(6)?,
                height: row.get(7)?,
                media_type: row.get(8)?,
                fingerprint: row.get(9)?,
                thumbnail_state: row.get(10)?,
                thumbnail_path: row.get(11)?,
                dup_count: row.get(12)?,
                container: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 删除分组：group_items 由外键级联删除，videos 不受影响（只删引用）。
pub fn remove_group(conn: &Connection, group_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM groups WHERE id = ?1",
        rusqlite::params![group_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn apply(current: &[(String, f64)], plan: &SortPlan) -> HashMap<String, f64> {
        let mut m: HashMap<String, f64> = current.iter().cloned().collect();
        for w in &plan.writes {
            m.insert(w.video_id.clone(), w.sort_order);
        }
        m
    }

    fn assert_increasing(ordered: &[String], keys: &HashMap<String, f64>) {
        for pair in ordered.windows(2) {
            assert!(
                keys[&pair[1]] > keys[&pair[0]],
                "顺序非严格递增: {} -> {}",
                keys[&pair[0]],
                keys[&pair[1]]
            );
        }
    }

    /// a=1000, b=2000, c=3000（create_group/add_to_group 的 1000 步长整数基线）
    fn base() -> Vec<(String, f64)> {
        vec![
            ("a".to_string(), 1000.0),
            ("b".to_string(), 2000.0),
            ("c".to_string(), 3000.0),
        ]
    }

    /// 性能基准：WAL + NORMAL + MEMORY + 64MB 缓存（技术方案 §13.2 / W7-1）
    #[test]
    fn pragmas_match_performance_baseline() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "filmstack-pragma-{}-{}.db",
            std::process::id(),
            nanos
        ));
        let conn = Connection::open(&path).unwrap();
        apply_pragmas(&conn).unwrap();

        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        let sync: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        let temp_store: i64 = conn
            .query_row("PRAGMA temp_store", [], |r| r.get(0))
            .unwrap();
        let cache: i64 = conn
            .query_row("PRAGMA cache_size", [], |r| r.get(0))
            .unwrap();

        assert_eq!(mode.to_lowercase(), "wal");
        assert_eq!(sync, 1, "synchronous=NORMAL");
        assert_eq!(temp_store, 2, "temp_store=MEMORY");
        assert_eq!(cache, -64000);

        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    // ---- 内存库集成测试：跑真实迁移与外键，验证的是写路径而不是纯函数 ----

    /// 内存库：与 open_db 同款迁移 + 外键（级联删除依赖外键，见技术方案 §6.1）
    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn vrow(id: &str, root: &str, name: &str, fp: Option<&str>) -> VideoRow {
        VideoRow {
            id: id.to_string(),
            root_id: root.to_string(),
            path: format!("D:\\{}\\{}", root, name),
            name: name.to_string(),
            size: 1,
            mtime: 0,
            fingerprint: fp.map(|s| s.to_string()),
            container: None,
            scanned: 0,
        }
    }

    fn commit(conn: &mut Connection, batch: &[VideoRow], a: &mut u32, u: &mut u32) {
        // flush_batch 只负责写，事务边界在调用方（扫描按 200 项 / 150ms 提交）
        let tx = conn.transaction().unwrap();
        flush_batch(&tx, batch, a, u).unwrap();
        tx.commit().unwrap();
    }

    fn dup_of(list: &[VideoMetaRow], id: &str) -> i64 {
        list.iter().find(|v| v.id == id).unwrap().dup_count
    }

    /// 最小 AVI 头：`RIFF <size> AVI `（`container_of` 只需前 12 字节）
    fn avi_header() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&24u32.to_le_bytes());
        v.extend_from_slice(b"AVI ");
        v.resize(24, 0);
        v
    }

    #[test]
    fn container_is_recorded_on_scan_and_backfilled_for_old_rows() {
        let mut conn = mem_db();
        // 扩展名骗人：叫 .mp4，实际是 AVI——列表页要能提前标出这种
        let p = tmp_bytes("fake.mp4", &avi_header());
        let meta = std::fs::metadata(&p).unwrap();
        let mtime = meta
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let row = || VideoRow {
            id: "v1".to_string(),
            root_id: "r1".to_string(),
            path: p.to_string_lossy().to_string(),
            name: "fake.mp4".to_string(),
            size: meta.len() as i64,
            mtime,
            fingerprint: None,
            container: None,
            scanned: 10,
        };
        let mut batch = vec![row()];
        resolve_fingerprints(&conn, &mut batch, true).unwrap();
        assert_eq!(
            batch[0].container.as_deref(),
            Some("avi"),
            "容器按文件头判定，不看扩展名"
        );
        let (mut a, mut u) = (0u32, 0u32);
        commit(&mut conn, &batch, &mut a, &mut u);
        let saved: Option<String> = conn
            .query_row("SELECT container FROM videos WHERE id='v1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(saved.as_deref(), Some("avi"));

        // 老库升级路径：container 为 NULL 时，增量扫到就补齐，不必全量重扫
        conn.execute("UPDATE videos SET container = NULL", [])
            .unwrap();
        let mut again = vec![row()];
        resolve_fingerprints(&conn, &mut again, true).unwrap();
        assert_eq!(again[0].container.as_deref(), Some("avi"));
        commit(&mut conn, &again, &mut a, &mut u);
        let saved2: Option<String> = conn
            .query_row("SELECT container FROM videos WHERE id='v1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(saved2.as_deref(), Some("avi"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn listed_videos_carry_container() {
        let mut conn = mem_db();
        let p = tmp_bytes("plain.mp4", &avi_header());
        let batch = vec![VideoRow {
            id: "v1".to_string(),
            root_id: "r1".to_string(),
            path: p.to_string_lossy().to_string(),
            name: "plain.mp4".to_string(),
            size: 24,
            mtime: 1,
            fingerprint: None,
            container: Some("avi".to_string()),
            scanned: 10,
        }];
        let (mut a, mut u) = (0u32, 0u32);
        commit(&mut conn, &batch, &mut a, &mut u);
        let list = list_videos(&conn, "r1").unwrap();
        assert_eq!(list[0].container.as_deref(), Some("avi"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn migrations_are_idempotent() {
        let conn = mem_db();
        // 第二次执行：0001 全 IF NOT EXISTS，0002 的 ALTER 由 pragma 守卫
        run_migrations(&conn).unwrap();
        for col in ["dup_count", "missing", "container"] {
            let has: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('videos') WHERE name=?1",
                    rusqlite::params![col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has, 1, "列 {} 必须存在且不重复添加", col);
        }
    }

    #[test]
    fn flush_batch_counts_added_then_updated() {
        let mut conn = mem_db();
        let (mut a, mut u) = (0u32, 0u32);
        commit(&mut conn, &[vrow("v1", "r1", "a.mp4", None)], &mut a, &mut u);
        assert_eq!((a, u), (1, 0));

        // 同 id 再扫一遍：size 变了算更新，行数不变
        let mut again = vrow("v1", "r1", "a.mp4", None);
        again.size = 999;
        commit(&mut conn, &[again], &mut a, &mut u);
        assert_eq!((a, u), (1, 1));
        let (size, rows): (i64, i64) = conn
            .query_row("SELECT size, COUNT(*) FROM videos", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(size, 999);
        assert_eq!(rows, 1, "upsert 不应产生重复行");
    }

    #[test]
    fn dup_counts_are_grouped_by_fingerprint_and_refreshed() {
        let mut conn = mem_db();
        let (mut a, mut u) = (0u32, 0u32);
        commit(
            &mut conn,
            &[
                vrow("v1", "r1", "a.mp4", Some("same")),
                vrow("v2", "r1", "b.mp4", Some("same")),
                vrow("v3", "r1", "c.mp4", Some("uniq")),
                vrow("v4", "r1", "d.mp4", None),
            ],
            &mut a,
            &mut u,
        );
        refresh_dup_counts(&conn).unwrap();
        let list = list_videos(&conn, "r1").unwrap();
        assert_eq!(dup_of(&list, "v1"), 2);
        assert_eq!(dup_of(&list, "v2"), 2);
        assert_eq!(dup_of(&list, "v3"), 1);
        assert_eq!(dup_of(&list, "v4"), 1, "无指纹不参与判定，保持 1");

        // 指纹改了不再重复：先归 1 再置数，避免旧计数残留
        commit(
            &mut conn,
            &[vrow("v2", "r1", "b.mp4", Some("uniq"))],
            &mut a,
            &mut u,
        );
        refresh_dup_counts(&conn).unwrap();
        let list = list_videos(&conn, "r1").unwrap();
        assert_eq!(dup_of(&list, "v1"), 1, "旧计数必须被清掉");
        assert_eq!(dup_of(&list, "v3"), 2);
    }

    #[test]
    fn list_videos_is_scoped_to_one_root() {
        let mut conn = mem_db();
        let (mut a, mut u) = (0u32, 0u32);
        commit(
            &mut conn,
            &[vrow("v1", "r1", "a.mp4", None), vrow("v2", "r2", "a.mp4", None)],
            &mut a,
            &mut u,
        );
        assert_eq!(list_videos(&conn, "r1").unwrap().len(), 1);
        assert_eq!(list_videos(&conn, "r2").unwrap().len(), 1);
        assert_eq!(list_videos(&conn, "r3").unwrap().len(), 0);
    }

    #[test]
    fn removing_group_drops_references_only() {
        let mut conn = mem_db();
        let (mut a, mut u) = (0u32, 0u32);
        commit(&mut conn, &[vrow("v1", "r1", "a.mp4", None)], &mut a, &mut u);

        let g = create_group(&conn, "收藏").unwrap();
        assert_eq!(add_to_group(&conn, &g.id, &["v1".to_string()]).unwrap(), 1);
        // 多归属：同一视频可同时属于多个分组
        let g2 = create_group(&conn, "待看").unwrap();
        assert_eq!(add_to_group(&conn, &g2.id, &["v1".to_string()]).unwrap(), 1);
        assert_eq!(
            add_to_group(&conn, &g2.id, &["v1".to_string()]).unwrap(),
            0,
            "重复加入应幂等（INSERT OR IGNORE）"
        );

        remove_group(&conn, &g.id).unwrap();
        let refs: i64 = conn
            .query_row("SELECT COUNT(*) FROM group_items", [], |r| r.get(0))
            .unwrap();
        let videos: i64 = conn
            .query_row("SELECT COUNT(*) FROM videos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(refs, 1, "只删这一组的引用");
        assert_eq!(videos, 1, "C1：视频记录不受影响");
        assert!(list_group_items(&conn, &g.id).unwrap().is_empty());
        assert_eq!(list_group_items(&conn, &g2.id).unwrap().len(), 1);
    }

    // ---- 指纹采样（技术方案 §8.3）：头/中/尾各 64KB，<192KB 全量 ----

    fn tmp_bytes(name: &str, data: &[u8]) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!(
            "filmstack-fp-{}-{}-{}",
            std::process::id(),
            nanos,
            name
        ));
        std::fs::write(&p, data).unwrap();
        p
    }

    // ---- 增量 diff（F3 / 技术方案 §8.1）----

    /// 临时目录里尚未创建的文件路径（模拟「上次扫到、这次没了」）
    fn ghost_path(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "filmstack-ghost-{}-{}-{}",
            std::process::id(),
            nanos,
            name
        ))
    }

    #[test]
    fn scan_generation_is_strictly_newer_than_last_scan() {
        assert_eq!(scan_generation(100, 100), 101, "同一秒再扫也要推进代次");
        assert_eq!(scan_generation(100, 90), 100);
        assert_eq!(scan_generation(100, 0), 100);
    }

    #[test]
    fn fingerprints_are_reused_when_size_and_mtime_match() {
        let mut conn = mem_db();
        let data = vec![3u8; 256 * 1024];
        let p = tmp_bytes("reuse.bin", &data);
        let meta = std::fs::metadata(&p).unwrap();
        let mtime = meta
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let row = || VideoRow {
            id: "v1".to_string(),
            root_id: "r1".to_string(),
            path: p.to_string_lossy().to_string(),
            name: "reuse.bin".to_string(),
            size: meta.len() as i64,
            mtime,
            fingerprint: None,
            container: None,
            scanned: 10,
        };

        // 库里没记录：只能算
        let mut first = vec![row()];
        assert_eq!(resolve_fingerprints(&conn, &mut first, true).unwrap(), 0);
        let fp = first[0].fingerprint.clone().unwrap();
        let (mut a, mut u) = (0u32, 0u32);
        commit(&mut conn, &first, &mut a, &mut u);

        // size+mtime 都没变：沿用，不读盘
        let mut same = vec![row()];
        assert_eq!(resolve_fingerprints(&conn, &mut same, true).unwrap(), 1);
        assert_eq!(same[0].fingerprint.as_deref(), Some(fp.as_str()));

        // mtime 变了：重算（内容没变，指纹应保持一致）
        let mut moved = vec![row()];
        moved[0].mtime += 1;
        assert_eq!(resolve_fingerprints(&conn, &mut moved, true).unwrap(), 0);
        assert_eq!(moved[0].fingerprint.as_deref(), Some(fp.as_str()));

        // 手动刷新：即使没变也强制重算
        let mut forced = vec![row()];
        assert_eq!(resolve_fingerprints(&conn, &mut forced, false).unwrap(), 0);

        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_entries_are_marked_hidden_and_recovered() {
        let mut conn = mem_db();
        let alive = tmp_bytes("alive.mp4", &[1u8; 1024]);
        let ghost = ghost_path("gone.mp4");
        let rows = |scanned: i64| {
            vec![
                VideoRow {
                    id: "v-alive".to_string(),
                    root_id: "r1".to_string(),
                    path: alive.to_string_lossy().to_string(),
                    name: "alive.mp4".to_string(),
                    size: 1024,
                    mtime: 5,
                    fingerprint: None,
                    container: None,
                    scanned,
                },
                VideoRow {
                    id: "v-ghost".to_string(),
                    root_id: "r1".to_string(),
                    path: ghost.to_string_lossy().to_string(),
                    name: "gone.mp4".to_string(),
                    size: 1024,
                    mtime: 5,
                    fingerprint: None,
                    container: None,
                    scanned,
                },
            ]
        };

        let (mut a, mut u) = (0u32, 0u32);
        commit(&mut conn, &rows(10), &mut a, &mut u);

        // 代次 11 只扫到了 alive（ghost 没被刷新戳）
        let mut seen = rows(11);
        seen.truncate(1);
        commit(&mut conn, &seen, &mut a, &mut u);

        assert_eq!(mark_missing(&conn, "r1", 11).unwrap(), 1);
        let list = list_videos(&conn, "r1").unwrap();
        assert_eq!(list.len(), 1, "失联条目不出现在列表里");
        assert_eq!(list[0].id, "v-alive");
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM videos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 2, "只标记不删行（C1）");

        // 文件回来了：重新扫到就复位
        std::fs::write(&ghost, b"x").unwrap();
        commit(&mut conn, &rows(12), &mut a, &mut u);
        assert_eq!(mark_missing(&conn, "r1", 12).unwrap(), 0);
        assert_eq!(list_videos(&conn, "r1").unwrap().len(), 2);

        let _ = std::fs::remove_file(&ghost);
        let _ = std::fs::remove_file(&alive);
    }

    #[test]
    fn non_absolute_paths_are_never_marked_missing() {
        // Android 的 content:// URI 不是文件系统路径，`exists()` 恒假——不能据此判失联
        let mut conn = mem_db();
        let (mut a, mut u) = (0u32, 0u32);
        commit(
            &mut conn,
            &[VideoRow {
                id: "v1".to_string(),
                root_id: "r1".to_string(),
                path: "content://media/documents/video%3A123".to_string(),
                name: "a.mp4".to_string(),
                size: 1,
                mtime: 0,
                fingerprint: None,
                container: None,
                scanned: 1,
            }],
            &mut a,
            &mut u,
        );
        assert_eq!(mark_missing(&conn, "r1", 2).unwrap(), 0);
        let missing: i64 = conn
            .query_row("SELECT missing FROM videos WHERE id='v1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(missing, 0);
    }

    #[test]
    fn dup_counts_ignore_missing_copies() {
        // 两处副本，一处失联：剩下的不该再挂「共有 2 处副本」
        let mut conn = mem_db();
        let alive = tmp_bytes("dup-alive.mp4", &[9u8; 1024]);
        let ghost = ghost_path("dup-gone.mp4");
        let rows = |scanned: i64| {
            vec![
                VideoRow {
                    id: "v-alive".to_string(),
                    root_id: "r1".to_string(),
                    path: alive.to_string_lossy().to_string(),
                    name: "a.mp4".to_string(),
                    size: 1024,
                    mtime: 5,
                    fingerprint: Some("same".to_string()),
                    container: None,
                    scanned,
                },
                VideoRow {
                    id: "v-ghost".to_string(),
                    root_id: "r1".to_string(),
                    path: ghost.to_string_lossy().to_string(),
                    name: "b.mp4".to_string(),
                    size: 1024,
                    mtime: 5,
                    fingerprint: Some("same".to_string()),
                    container: None,
                    scanned,
                },
            ]
        };
        let (mut a, mut u) = (0u32, 0u32);
        commit(&mut conn, &rows(10), &mut a, &mut u);
        refresh_dup_counts(&conn).unwrap();
        assert_eq!(dup_of(&list_videos(&conn, "r1").unwrap(), "v-alive"), 2);

        let mut seen = rows(11);
        seen.truncate(1);
        commit(&mut conn, &seen, &mut a, &mut u);
        mark_missing(&conn, "r1", 11).unwrap();
        refresh_dup_counts(&conn).unwrap();

        let list = list_videos(&conn, "r1").unwrap();
        assert_eq!(dup_of(&list, "v-alive"), 1, "失联副本不再计入");

        let _ = std::fs::remove_file(&alive);
    }

    #[test]
    fn fingerprint_hashes_small_file_fully() {
        let data = vec![7u8; 100 * 1024]; // <192KB：全量
        let p = tmp_bytes("small.bin", &data);
        let expected = to_hex(&Sha256::digest(&data));
        assert_eq!(compute_fingerprint(&p, data.len() as u64), Some(expected));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn fingerprint_samples_head_mid_tail_only() {
        let len = 1024 * 1024usize;
        let base_data = vec![0u8; len];
        let p = tmp_bytes("large.bin", &base_data);
        let base = compute_fingerprint(&p, len as u64).unwrap();

        // 三个采样点任一变化都要换指纹
        for (label, at) in [("head", 1_000usize), ("mid", 512 * 1024), ("tail", len - 10)] {
            let mut d = base_data.clone();
            d[at] = 1;
            std::fs::write(&p, &d).unwrap();
            assert_ne!(
                compute_fingerprint(&p, len as u64).unwrap(),
                base,
                "{label} 采样点变化必须改变指纹"
            );
        }

        // 采样盲区：非采样区（192KB 附近）的改动发现不了——已知取舍，仅标记重复不做删除
        let mut d = base_data.clone();
        d[192 * 1024 + 500] = 1;
        std::fs::write(&p, &d).unwrap();
        assert_eq!(
            compute_fingerprint(&p, len as u64).unwrap(),
            base,
            "采样盲区：非采样字节不参与哈希（技术方案 §8.3）"
        );
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn fingerprint_of_missing_file_is_none() {
        assert_eq!(
            compute_fingerprint(std::path::Path::new("D:/no/such/file.mp4"), 4096),
            None,
            "读不到就降级为不参与判定，不让扫描失败"
        );
    }

    #[test]
    fn identity_order_writes_nothing() {
        let cur = base();
        let plan = plan_sort_order(&cur, &ids(&["a", "b", "c"])).unwrap();
        assert_eq!(plan.writes.len(), 0);
        assert!(!plan.rebuilt);
    }

    #[test]
    fn move_tail_to_head_writes_single_item() {
        let cur = base();
        let order = ids(&["c", "a", "b"]);
        let plan = plan_sort_order(&cur, &order).unwrap();
        assert_eq!(
            plan.writes,
            vec![SortWrite {
                video_id: "c".to_string(),
                sort_order: 0.0
            }]
        );
        assert!(!plan.rebuilt);
        assert_increasing(&order, &apply(&cur, &plan));
    }

    #[test]
    fn swap_neighbors_writes_single_midpoint() {
        let cur = base();
        let order = ids(&["a", "c", "b"]);
        let plan = plan_sort_order(&cur, &order).unwrap();
        assert_eq!(
            plan.writes,
            vec![SortWrite {
                video_id: "c".to_string(),
                sort_order: 1500.0
            }]
        );
        assert_increasing(&order, &apply(&cur, &plan));
    }

    #[test]
    fn move_head_to_tail_keeps_strict_order() {
        let cur = base();
        let order = ids(&["b", "c", "a"]);
        let plan = plan_sort_order(&cur, &order).unwrap();
        assert_eq!(plan.writes.len(), 2);
        assert_increasing(&order, &apply(&cur, &plan));
    }

    #[test]
    fn any_permutation_stays_strictly_increasing() {
        let cur: Vec<(String, f64)> = vec![
            ("a".into(), 1000.0),
            ("b".into(), 2000.0),
            ("c".into(), 3000.0),
            ("d".into(), 4000.0),
        ];
        for perm in [
            ["d", "a", "c", "b"],
            ["b", "d", "a", "c"],
            ["c", "b", "a", "d"],
            ["a", "b", "c", "d"],
        ] {
            let order = ids(&perm);
            let plan = plan_sort_order(&cur, &order).unwrap();
            assert_increasing(&order, &apply(&cur, &plan));
        }
    }

    #[test]
    fn set_mismatch_is_rejected() {
        let cur = base();
        assert!(plan_sort_order(&cur, &ids(&["a", "b"])).is_err());
        assert!(plan_sort_order(&cur, &ids(&["a", "b", "c", "d"])).is_err());
        assert!(plan_sort_order(&cur, &ids(&["a", "b", "z"])).is_err());
    }

    #[test]
    fn duplicate_id_in_request_is_rejected() {
        let cur = base();
        assert!(plan_sort_order(&cur, &ids(&["a", "a", "b"])).is_err());
    }

    #[test]
    fn empty_group_is_noop() {
        let plan = plan_sort_order(&[], &[]).unwrap();
        assert!(plan.writes.is_empty());
        assert!(!plan.rebuilt);
    }

    #[test]
    fn too_many_colliding_keys_triggers_rebuild() {
        // 60 项共用同一 key -> 相邻冲突 59 次，超过 50 阈值
        let cur: Vec<(String, f64)> = (0..60).map(|i| (format!("v{}", i), 1000.0)).collect();
        let order: Vec<String> = cur.iter().map(|(id, _)| id.clone()).collect();
        let plan = plan_sort_order(&cur, &order).unwrap();
        assert!(plan.rebuilt);
        assert_eq!(plan.writes.len(), 60);
        assert_eq!(plan.writes[0].sort_order, 1000.0);
        assert_eq!(plan.writes[59].sort_order, 60000.0);
        assert_increasing(&order, &apply(&cur, &plan));
    }

    #[test]
    fn exhausted_float_gap_triggers_rebuild() {
        // lower=1.0 与其相邻浮点 1+2^-52：中值不可表示，舍入到 lower -> 必须重建
        let cur = vec![
            ("a".into(), 1.0),
            ("b".into(), 5000.0),
            ("c".into(), 1.0f64.next_up()),
        ];
        let order = ids(&["a", "b", "c"]);
        let plan = plan_sort_order(&cur, &order).unwrap();
        assert!(plan.rebuilt);
        assert_increasing(&order, &apply(&cur, &plan));
    }
}
