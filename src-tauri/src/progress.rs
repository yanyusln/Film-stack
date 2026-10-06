//! 播放进度落库（W4 / 技术方案 §8.6）。
//!
//! 纯策略：播放到末尾 30s 视为「看完了」，不记录并清掉旧记录——否则每次点开都卡在差几秒的位置反复弹续播。
//! 写库节流（每秒至多一次 / 位移 >5s 或状态切换）由前端按同名常量控制，见 `src/composables/playbackPolicy.ts`。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// 末尾窗口（秒）：落在这个区间的位置不再保存。
pub const TAIL_WINDOW_SEC: f64 = 30.0;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayProgress {
    pub video_id: String,
    pub position: f64,
    pub duration: f64,
    pub updated_at: i64,
}

/// `true` 表示这段位置值得记住（`false` 时调用方应顺手清掉旧记录）。
pub fn keep_position(position: f64, duration: f64) -> bool {
    duration <= 0.0 || position < duration - TAIL_WINDOW_SEC
}

fn now_sec() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .map_err(|e| e.to_string())
}

fn delete_progress(conn: &Connection, video_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM play_progress WHERE video_id = ?1",
        params![video_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_progress(
    video_id: String,
    app: AppHandle,
) -> Result<Option<PlayProgress>, String> {
    let conn = crate::db::open_db(&app)?;
    let row = conn.query_row(
        "SELECT video_id, position, duration, updated_at FROM play_progress WHERE video_id = ?1",
        params![video_id],
        |r| {
            Ok(PlayProgress {
                video_id: r.get(0)?,
                position: r.get(1)?,
                duration: r.get(2)?,
                updated_at: r.get(3)?,
            })
        },
    );
    match row {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 保存进度；命中末尾窗口时改为清库，返回是否已写入。
#[tauri::command]
pub async fn save_progress(
    video_id: String,
    position: f64,
    duration: f64,
    app: AppHandle,
) -> Result<bool, String> {
    let conn = crate::db::open_db(&app)?;
    if !keep_position(position, duration) {
        delete_progress(&conn, &video_id)?;
        return Ok(false);
    }
    let now = now_sec()?;
    conn.execute(
        "INSERT INTO play_progress (video_id, position, duration, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(video_id) DO UPDATE SET position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at",
        params![video_id, position, duration, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn clear_progress(video_id: String, app: AppHandle) -> Result<(), String> {
    let conn = crate::db::open_db(&app)?;
    delete_progress(&conn, &video_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_and_middle_are_remembered() {
        assert!(keep_position(0.0, 600.0));
        assert!(keep_position(12.5, 600.0));
        assert!(keep_position(560.0, 600.0));
    }

    #[test]
    fn tail_window_is_forgotten() {
        // duration - position <= 30s：第 570s 起不再记录
        assert!(!keep_position(570.0, 600.0));
        assert!(!keep_position(590.0, 600.0));
        assert!(keep_position(569.9, 600.0));
    }

    #[test]
    fn unknown_duration_is_kept() {
        assert!(keep_position(0.0, 0.0));
        assert!(keep_position(5.0, -1.0));
    }
}
