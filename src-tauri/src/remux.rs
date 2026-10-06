//! 播放前把「容器放不了、但编码救得回」的文件转封装到**应用缓存**。
//!
//! 边界（与 C1 的关系）：C1 保护的是**用户的媒体文件**——这里只读源文件，
//! 产物写在应用自己的缓存目录，与缩略图缓存同一性质，不动用户一个字节。
//!
//! - **不覆盖**：先写 `.part.mp4` 再 rename，中途失败不留半个"看起来能用"的文件；
//! - **不猜**：需要不需要转，唯一判据是 `probe` 给出的建议命令（两处规则不许分叉）；
//! - **不假装成功**：找不到 ffmpeg 明确回 `ffmpeg_missing`，与抽帧同一套定位（见 `ffmpeg.rs`）；
//! - **进度可见**：整文件读写，慢盘上的大文件能跑几十秒——**没有反馈就等于卡死**
//!   （真机反馈：点了 AVI 之后界面毫无动静，过一会儿突然开始播）。故转封装期间按
//!   产物增长量推 `RemuxProgress`，让界面说得清「在转、转了多少」。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::ffmpeg::{ffmpeg_binary, run_with_timeout};
use crate::thumbnail::lru_cleanup;

/// 缓存上限：**不能照抄缩略图的 500MB**——单部课程录屏就 469MB，
/// 500MB 会导致播一部挤掉上一部、来回重转。这里单独给 5GB。
const MAX_CACHE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
/// 刚用过（很可能正在播）的文件不删，见 `lru_cleanup` 的 grace 说明。
const CACHE_GRACE_SECS: u64 = 10 * 60;
/// 转封装是整文件读写：实测 469MB 只要 6s，但慢盘上的大文件可能几分钟，给 15 分钟硬上限。
const REMUX_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 进度回推间隔：按产物文件增长量估算，够密才"看得出在动"，又不至于刷屏。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(300);

/// 转封装进度（Channel 推给前端）：`done` 为已写出字节，`total` 取源文件大小。
#[derive(Clone, serde::Serialize)]
pub struct RemuxProgress {
    pub done: u64,
    pub total: u64,
    /// 0–99：转好之前不给 100，100% 由 `RemuxResult.status == "remuxed"` 说话
    pub pct: u8,
}

#[derive(serde::Serialize)]
pub struct RemuxResult {
    /// `cached`（缓存命中）/ `remuxed`（刚转好）/ `skipped`（不用转）/ `error`
    pub status: &'static str,
    /// 可播的缓存文件路径；`skipped` / `error` 时为 `None`。
    pub path: Option<String>,
    /// `error` 的原因：`source_missing` / `ffmpeg_missing` / `ffmpeg_failed` / `timeout` / `io_error:*`
    pub reason: Option<String>,
}

fn done(
    status: &'static str,
    path: Option<String>,
    reason: Option<String>,
) -> RemuxResult {
    RemuxResult {
        status,
        path,
        reason,
    }
}

#[tauri::command]
pub async fn remux_to_cache(
    path: String,
    on_progress: Channel<RemuxProgress>,
    app: AppHandle,
) -> Result<RemuxResult, String> {
    Ok(remux(&app, &path, Some(&on_progress)))
}

/// 进入 ffmpeg 之前的判定：**源不在 / 不需要转都不该动 ffmpeg**。
/// 单独抽成纯函数是为了可测（`remux` 需要 `AppHandle`，测试里造不出来）。
fn precheck(raw: &str) -> Option<RemuxResult> {
    if !Path::new(raw).is_file() {
        return Some(done("error", None, Some("source_missing".to_string())));
    }
    if crate::probe::probe(raw).suggest_command.is_none() {
        // 本来能播，或压根救不回来：都不该转（规则以 probe 为准，避免两处判定分叉）
        return Some(done("skipped", None, None));
    }
    None
}

/// `on_progress` 为 `None` 时不推进度（无界面反馈的场景）。
pub fn remux(
    app: &AppHandle,
    raw: &str,
    on_progress: Option<&Channel<RemuxProgress>>,
) -> RemuxResult {
    // 平台不具备 ffmpeg 能力时**连源文件都不必探**：Android 上库里存的是 content:// URI，
    // `probe` 的 std::fs 读盘注定失败，只会把真实原因（平台不支持）盖成 source_missing。
    if !crate::ffmpeg::platform_supports_ffmpeg() {
        return done("error", None, Some("unsupported_platform".to_string()));
    }
    if let Some(r) = precheck(raw) {
        return r;
    }
    let src = Path::new(raw);
    let info = crate::probe::probe(raw);
    let Some(ffmpeg) = ffmpeg_binary() else {
        return done("error", None, Some("ffmpeg_missing".to_string()));
    };
    let dir = match cache_dir(app) {
        Ok(d) => d,
        Err(e) => return done("error", None, Some(format!("io_error:{e}"))),
    };
    let key = cache_key(src, info.size.unwrap_or(0));
    let out = dir.join(format!("{key}.mp4"));
    if out.exists() {
        // 命中即续命：否则正在播的那部会因为"最旧"被下一次转封装清掉
        touch(&out);
        return done("cached", Some(out.to_string_lossy().to_string()), None);
    }

    let tmp = cache_tmp_path(&dir, &key);
    let total = info.size.unwrap_or(0).max(1);
    // 进度线程先起：ffmpeg 一跑产物就开始涨，慢盘上这一步能撑几十秒
    let stop = Arc::new(AtomicBool::new(false));
    let watcher = spawn_progress_watcher(&tmp, total, on_progress, &stop);

    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(["-y", "-i", raw])
        .args(remux_args(info.video_supported))
        .args(OUTPUT_PIN)
        .arg(&tmp);
    let result = match run_with_timeout(&mut cmd, REMUX_TIMEOUT) {
        Ok(o) if o.status.success() && tmp.is_file() => {
            if fs::rename(&tmp, &out).is_err() {
                let _ = fs::remove_file(&tmp);
                done("error", None, Some("io_error:rename".to_string()))
            } else {
                let _ = lru_cleanup(&dir, MAX_CACHE_BYTES, CACHE_GRACE_SECS);
                done("remuxed", Some(out.to_string_lossy().to_string()), None)
            }
        }
        Ok(_) => {
            let _ = fs::remove_file(&tmp);
            done("error", None, Some("ffmpeg_failed".to_string()))
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            done(
                "error",
                None,
                Some(if e == "timeout" {
                    "timeout".to_string()
                } else {
                    format!("io_error:{e}")
                }),
            )
        }
    };
    // 先通知"不用再盯了"，再等线程退干净（它最多再睡一个间隔就结束）
    stop.store(true, Ordering::Relaxed);
    if let Some(h) = watcher {
        let _ = h.join();
    }
    result
}

/// 按产物文件的增长量估算进度。
///
/// 为什么不解析 ffmpeg 的 `-progress` 输出：那要读子进程 stderr，而 stderr 的 pipe 缓冲
/// 写满会把 ffmpeg 卡住（反过来变成"转不动"）。读产物文件没有这个问题，且与 ffmpeg 解耦。
fn spawn_progress_watcher(
    tmp: &Path,
    total: u64,
    ch: Option<&Channel<RemuxProgress>>,
    stop: &Arc<AtomicBool>,
) -> Option<thread::JoinHandle<()>> {
    let ch = ch?.clone();
    let tmp = tmp.to_path_buf();
    let stop = Arc::clone(stop);
    Some(thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let done = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
            let _ = ch.send(RemuxProgress {
                done,
                total,
                pct: pct_of(done, total),
            });
            thread::sleep(PROGRESS_INTERVAL);
        }
    }))
}

/// 产物可能比源文件略大（muxing overhead），故封顶 99：100% 留给"转好了"那一刻。
fn pct_of(done: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    (done.saturating_mul(100) / total).min(99) as u8
}

/// 编码受支持 → 无损转封装；不受支持 → 重编码（与 `probe::suggest_command` 同一套结论）。
fn remux_args(video_supported: Option<bool>) -> Vec<String> {
    if video_supported == Some(false) {
        [
            "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    } else {
        vec!["-c".to_string(), "copy".to_string()]
    }
}

/// 输出侧硬编码：ffmpeg **靠输出文件名的扩展名推断封装格式**，临时名曾经叫
/// `{key}.part`，ffmpeg 直接报 `Unable to choose an output format`（真机实证 exit -22），
/// 表现为「转封装秒失败、缓存目录空空、界面只回退到手动命令」——极难反查。
/// 两道保险：临时名带 `.mp4`（`cache_tmp_path`）+ 这里显式钉住 muxer。
const OUTPUT_PIN: [&str; 2] = ["-f", "mp4"];

/// 临时产物名：rename 到 `{key}.mp4` 之前的中转文件，**必须带标准扩展名**（见 [`OUTPUT_PIN`]）。
fn cache_tmp_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.part.mp4"))
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法获取数据目录".to_string())?
        .join("remux");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 缓存名：`内容指纹 + 大小`。
///
/// 用库里同一套采样指纹（192KB），文件改名/移动后缓存仍能命中；
/// 采样哈希理论上有碰撞，拼上 size 基本杜绝——**撞了就是播错文件**，比放不了更糟。
fn cache_key(path: &Path, size: u64) -> String {
    let fp = crate::db::compute_fingerprint(path, size).unwrap_or_else(|| {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        path.to_string_lossy().hash(&mut h);
        format!("path{:x}", h.finish())
    });
    let head = &fp[..fp.len().min(16)];
    format!("{head}-{size}")
}

fn touch(p: &Path) {
    if let Ok(f) = fs::OpenOptions::new().write(true).open(p) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("remux-test-{name}"));
        fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn copy_when_codec_is_supported_recode_when_not() {
        // 真机形态：AVI 里的 h264 只需换容器
        let a = remux_args(Some(true));
        assert!(a.contains(&"copy".to_string()), "受支持只该转封装：{a:?}");
        assert!(!a.iter().any(|s| s == "libx264"));

        let b = remux_args(Some(false));
        assert!(b.iter().any(|s| s == "libx264"), "不受支持必须重编码");
    }

    #[test]
    fn cache_key_is_stable_and_size_aware() {
        let p = tmp("k.bin", &[7u8; 4096]);
        let a = cache_key(&p, 4096);
        let b = cache_key(&p, 4096);
        assert_eq!(a, b, "同一文件应稳定命中缓存");
        assert_ne!(cache_key(&p, 4097), a, "size 必须参与，防采样哈希碰撞串播");
        assert!(a.len() <= 40);
    }

    #[test]
    fn tmp_output_has_standard_extension_and_pinned_muxer() {
        // 真机踩过：临时名 `.part` → ffmpeg `Unable to choose an output format`（exit -22），
        // 转封装秒失败、缓存目录空空，界面上还看不出来
        let p = cache_tmp_path(Path::new("/cache"), "abc-123");
        assert_eq!(p.extension().and_then(|e| e.to_str()), Some("mp4"));
        assert!(
            p.to_string_lossy().ends_with(".part.mp4"),
            "临时名要能一眼看出是半成品：{p:?}"
        );
        assert_eq!(OUTPUT_PIN, ["-f", "mp4"], "扩展名与 -f 双保险，缺一不可");
    }

    #[test]
    fn progress_pct_is_capped_at_99_before_done() {
        assert_eq!(pct_of(0, 1000), 0);
        assert_eq!(pct_of(500, 1000), 50);
        // 产物可能比源文件略大：99 封顶，100% 留给「转好了」那一刻
        assert_eq!(pct_of(999, 1000), 99);
        assert_eq!(pct_of(2000, 1000), 99);
        assert_eq!(pct_of(10, 0), 0, "total 未知时不能除零");
    }

    #[test]
    fn missing_source_is_stopped_before_ffmpeg() {
        let r = precheck("Z:/definitely/not/here.mp4").expect("源不存在该被挡下");
        assert_eq!(r.status, "error");
        assert_eq!(r.reason.as_deref(), Some("source_missing"));
        assert!(r.path.is_none());
    }

    #[test]
    fn playable_or_hopeless_file_is_skipped() {
        // 一段随机内容：probe 探不出容器也探不出编码 -> 不在"放不了又救得回"之列
        let p = tmp("skip.bin", &[3u8; 2048]);
        let r = precheck(&p.to_string_lossy()).expect("不该轮到 ffmpeg");
        assert_eq!(r.status, "skipped");
        assert!(r.path.is_none());
    }

    #[test]
    fn lru_keeps_the_file_that_is_probably_playing() {
        // 造两个"大文件"：一个 10 分钟前用过（很可能正在播）、一个一小时前
        let d = std::env::temp_dir().join("remux-lru-test");
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let fresh = d.join("fresh.bin");
        let old = d.join("old.bin");
        for p in [&fresh, &old] {
            let f = fs::File::create(p).unwrap();
            f.set_len(600 * 1024 * 1024).unwrap(); // 稀疏文件，不真占盘
        }
        let now = std::time::SystemTime::now();
        fs::OpenOptions::new()
            .write(true)
            .open(&fresh)
            .unwrap()
            .set_modified(now - Duration::from_secs(60))
            .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(now - Duration::from_secs(3600))
            .unwrap();

        // 上限 500MB：两个 600MB 肯定超限，只能删一个
        lru_cleanup(&d, 500 * 1024 * 1024, CACHE_GRACE_SECS).unwrap();
        assert!(fresh.exists(), "刚用过的（可能在播）不该被删");
        assert!(!old.exists(), "旧的该被清理");
        let _ = fs::remove_dir_all(&d);
    }
}
