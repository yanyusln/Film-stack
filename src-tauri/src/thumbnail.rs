// 缩略图（W2-2，技术方案 §8.2）：系统图优先 -> 缺失再入 ffmpeg 抽帧队列。
// 队列：并发 2、单任务超时 30s、>500MB 带进度、LRU 磁盘缓存 500MB、终态失败 24h 内不重试。
// 系统图（Windows IShellFolder / macOS Quick Look / Android MediaStore）见 extract_system_thumb：
// 当前仅占位（需平台原生 API），缺失时降级 ffmpeg；ffmpeg 不可用时仅占位，不下载解码器。
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;

const MAX_CACHE_BYTES: u64 = 500 * 1024 * 1024; // LRU 上限
const TASK_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CONCURRENT: usize = 2;
const RETRY_INTERVAL: i64 = 24 * 60 * 60; // 终态失败 24h 内不重试
const LARGE_FILE: i64 = 500 * 1024 * 1024; // >500MB 显示进度
const THUMB_WIDTH: u32 = 320;
// 只给 Windows 系统缩略图的 SIZE 用；ffmpeg 抽帧是 scale=W:-2（按宽等比），不需要高度。
// 不 cfg 的话，非 Windows 目标（含 Android 构建）会报 dead_code。
#[cfg(windows)]
const THUMB_HEIGHT: u32 = 180;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThumbProgress {
    pub video_id: String,
    pub state: &'static str,
    pub progress: f32,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法获取数据目录".to_string())?
        .join("thumbs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 缓存文件名：sha256(root_id:video_id)
fn cache_name(root_id: &str, video_id: &str) -> String {
    let digest = Sha256::digest(format!("{}:{}", root_id, video_id).as_bytes());
    format!("{:x}.bmp", digest)
}

/// 系统缩略图（优先路径，§8.2）。Windows 走 IShellItemImageFactory，不依赖任何外部二进制。
/// 在专用线程里初始化 STA COM：避免 tokio 阻塞线程池既有的 COM 单元状态干扰取图。
#[cfg(windows)]
fn extract_system_thumb(path: &Path, out: &Path) -> Result<(), String> {
    let p = path.to_path_buf();
    let o = out.to_path_buf();
    std::thread::spawn(move || -> Result<(), String> { unsafe { shell_thumb_inner(&p, &o) } })
        .join()
        .map_err(|_| "system_thumb_panic".to_string())?
}

#[cfg(windows)]
unsafe fn shell_thumb_inner(path: &Path, out: &Path) -> Result<(), String> {
    use std::mem::size_of;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
        SIIGBF_RESIZETOFIT,
    };

    unsafe {
        // COM 初始化；已初始化时返回非成功码，忽略即可（不影响 GetImage）
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let wide: Vec<u16> = path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
                .map_err(|e| format!("SHCreateItemFromParsingName: {}", e))?;

        let size = SIZE {
            cx: THUMB_WIDTH as i32,
            cy: THUMB_HEIGHT as i32,
        };
        let hbmp = factory
            .GetImage(size, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK)
            .map_err(|e| format!("GetImage: {}", e))?;

        let mut bm = BITMAP::default();
        let got = GetObjectW(
            HGDIOBJ(hbmp.0),
            size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut std::ffi::c_void),
        );
        if got == 0 {
            let _ = DeleteObject(HGDIOBJ(hbmp.0));
            return Err("GetObjectW failed".to_string());
        }

        let w = bm.bmWidth;
        let h = bm.bmHeight.abs();
        if w <= 0 || h <= 0 {
            let _ = DeleteObject(HGDIOBJ(hbmp.0));
            return Err("empty bitmap".to_string());
        }

        // 以自上而下（biHeight 为负）32bpp BGRA 取像素，便于直接写 BMP
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        let hdc = CreateCompatibleDC(None);
        let lines = GetDIBits(
            hdc,
            hbmp,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut std::ffi::c_void),
            &mut bmi as *mut BITMAPINFO,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(hdc);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        if lines == 0 {
            return Err("GetDIBits failed".to_string());
        }

        write_bmp(out, w, h, &pixels)
    }
}

/// 写 32bpp BGRA 自上而下 BMP（不引入图片库，减少依赖与编译面）。
#[cfg(windows)]
fn write_bmp(out: &Path, w: i32, h: i32, bgra: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let row = (w as usize) * 4;
    let pixel_bytes = row * (h as usize);
    let mut f = std::fs::File::create(out).map_err(|e| e.to_string())?;
    // BITMAPFILEHEADER
    f.write_all(b"BM").map_err(|e| e.to_string())?;
    f.write_all(&((14 + 40 + pixel_bytes) as u32).to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&0u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&0u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&54u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    // BITMAPINFOHEADER
    f.write_all(&40u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&w.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&(-h).to_le_bytes())
        .map_err(|e| e.to_string())?; // 负值 = 自上而下
    f.write_all(&1u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&32u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&0u32.to_le_bytes())
        .map_err(|e| e.to_string())?; // BI_RGB
    f.write_all(&(pixel_bytes as u32).to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&0u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&0u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&0u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&0u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(bgra).map_err(|e| e.to_string())?;
    Ok(())
}

/// 非 Windows 平台：系统取图未接入，交由 ffmpeg 降级。
#[cfg(not(windows))]
fn extract_system_thumb(_path: &Path, _out: &Path) -> Result<(), String> {
    Err("system_thumb_unavailable".to_string())
}

/// ffmpeg 抽帧：定位 1s、取 1 帧、缩放到 320 宽，超时 30s。
fn extract_ffmpeg_thumb(src: &Path, out: &Path) -> Result<(), String> {
    // 两种失败要分开：平台压根没有 ffmpeg 能力（Android / iOS） vs 有但没找到
    // （winget 装完 PATH 里常常没有，见 ffmpeg.rs）。混成一句会误导排查方向。
    let ffmpeg = if !crate::ffmpeg::platform_supports_ffmpeg() {
        return Err("unsupported_platform".to_string());
    } else {
        crate::ffmpeg::ffmpeg_binary().ok_or("ffmpeg_missing".to_string())?
    };
    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-ss",
        "1",
        "-i",
        &src.to_string_lossy(),
        "-frames:v",
        "1",
        "-vf",
        &format!("scale={}:-2", THUMB_WIDTH),
        "-y",
        &out.to_string_lossy(),
    ]);
    let output = crate::ffmpeg::run_with_timeout(&mut cmd, TASK_TIMEOUT)?;
    if !output.status.success() || !out.exists() {
        return Err("ffmpeg_failed".to_string());
    }
    Ok(())
}

/// LRU：超过 `max_bytes` 时按修改时间从旧到新删除，直到低于上限。
///
/// `grace_secs`：刚被用过（`grace_secs` 秒内）的文件**跳过不删**——缓存里很可能
/// 正放着一个几百 MB 的文件，按 mtime 排它是"最旧"的，直接删会把它播到一半掐掉。
/// 缩略图不需要这层保护（传 0）。
pub(crate) fn lru_cleanup(dir: &Path, max_bytes: u64, grace_secs: u64) -> Result<(), String> {
    let now = SystemTime::now();
    let mut entries: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
    let mut total = 0u64;
    let rd = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        total += meta.len();
        entries.push((
            e.path(),
            meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            meta.len(),
        ));
    }
    if total <= max_bytes {
        return Ok(());
    }
    entries.sort_by_key(|a| a.1);
    for (p, mtime, len) in entries {
        if total <= max_bytes {
            break;
        }
        if let Ok(age) = now.duration_since(mtime) {
            if age.as_secs() < grace_secs {
                continue;
            }
        }
        if fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
        }
    }
    Ok(())
}

/// 获取（必要时生成）某视频缩略图，返回可显示的本地路径。
#[tauri::command]
pub async fn ensure_thumb(
    video_id: String,
    on_progress: Channel<ThumbProgress>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = crate::db::open_db(&app)?;

    let row = conn
        .query_row(
            "SELECT root_id, path, size, thumbnail_state, thumbnail_path, updated_at FROM videos WHERE id = ?1",
            rusqlite::params![video_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )
        .map_err(|_| format!("视频不存在: {}", video_id))?;
    let (root_id, path, size, t_state, t_path, updated_at) = row;

    // 已就绪且文件仍在 -> 直接复用
    if t_state == "ready" {
        if let Some(p) = &t_path {
            if Path::new(p).exists() {
                return Ok(p.clone());
            }
        }
    }
    // 终态失败：24h 内不重试，避免重复占用 CPU
    if t_state == "failed" && now_secs() - updated_at < RETRY_INTERVAL {
        return Err("skip_retry".to_string());
    }

    let dir = cache_dir(&app)?;
    let out = dir.join(cache_name(&root_id, &video_id));
    let large = size > LARGE_FILE;
    on_progress
        .send(ThumbProgress {
            video_id: video_id.clone(),
            state: "pending",
            progress: 0.0,
        })
        .ok();

    // 并发上限 2：占用槽位，满了等待（tokio::time::sleep，不阻塞运行时）
    let active = state.thumb_active.clone();
    loop {
        let cur = active.load(Ordering::SeqCst);
        if cur < MAX_CONCURRENT
            && active
                .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let src = PathBuf::from(&path);
    let out_c = out.clone();
    let done = Arc::new(AtomicBool::new(false));
    let done_c = done.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        // 系统图优先，失败降级 ffmpeg（§8.2）
        let r = if extract_system_thumb(&src, &out_c).is_ok() && out_c.exists() {
            Ok(())
        } else {
            extract_ffmpeg_thumb(&src, &out_c)
        };
        done_c.store(true, Ordering::SeqCst);
        r as Result<(), String>
    });

    // >500MB：等待期间推进近似进度（不解析 ffmpeg 输出，避免主线程负担）
    if large {
        let mut p = 0.1f32;
        while !done.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(400)).await;
            p = (p + 0.1).min(0.9);
            on_progress
                .send(ThumbProgress {
                    video_id: video_id.clone(),
                    state: "extracting",
                    progress: p,
                })
                .ok();
        }
    }

    let result = handle.await.map_err(|e| e.to_string())?;

    active.fetch_sub(1, Ordering::SeqCst);

    match result {
        Ok(()) => {
            on_progress
                .send(ThumbProgress {
                    video_id: video_id.clone(),
                    state: "ready",
                    progress: 1.0,
                })
                .ok();
            conn.execute(
                "UPDATE videos SET thumbnail_state='ready', thumbnail_path=?2, updated_at=?3 WHERE id=?1",
                rusqlite::params![video_id, out.to_string_lossy(), now_secs()],
            )
            .map_err(|e| e.to_string())?;
            lru_cleanup(&dir, MAX_CACHE_BYTES, 0).ok();
            Ok(out.to_string_lossy().to_string())
        }
        Err(reason) => {
            on_progress
                .send(ThumbProgress {
                    video_id: video_id.clone(),
                    state: "failed",
                    progress: 0.0,
                })
                .ok();
            conn.execute(
                "UPDATE videos SET thumbnail_state='failed', thumbnail_path=NULL, updated_at=?2 WHERE id=?1",
                rusqlite::params![video_id, now_secs()],
            )
            .map_err(|e| e.to_string())?;
            Err(reason)
        }
    }
}
