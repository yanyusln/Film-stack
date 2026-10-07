//! Android 本地媒体服务（回环 HTTP）——只服务本机、只服务已放行路径。
//!
//! **为什么要有它**：Android WebView 的 `<video>` 媒体请求不经过
//! `WebViewClient.shouldInterceptRequest`（media 层自己发起真实网络请求），
//! 于是 asset 协议的 `http://asset.localhost/...` 在无网络环境下根本解析不到，
//! 表现是 `PIPELINE_ERROR_READ` / `MEDIA_ERR_SRC_NOT_SUPPORTED`——封面（走常规资源加载，
//! 会被拦截）能显示、视频不能播，正是这个差别。图片/脚本等通道不受影响。
//!
//! 解法：App 启动后在 `127.0.0.1` 起一个只认本机的最小 HTTP 服务，视频与封面都走真实
//! TCP 回环，天然可达且支持 Range（大文件拖动进度条需要）。
//!
//! **边界**：
//! - 只绑 `127.0.0.1`，不监听外网网卡；请求不携带路径以外的任何数据。
//! - 路径必须同时满足：存在、扩展名在允许表内、且在 asset 协议 scope 内（复用同一份判定，
//!   即桌面端那张动态放行规则 + Android 静态 scope 的 `/storage/**`）。
//! - 日志**不打印完整路径**（C3 日志脱敏），只记状态与扩展名。
//!
//! 本模块在非 Android 目标上不启动（asset 协议够用），但代码照旧参与编译，
//! 好让单测与类型检查覆盖到它——故整模块允许 dead_code。
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 起始端口；被占用则顺序后移，最多试 PORT_TRIES 次。
const PORT_START: u16 = 17888;
const PORT_TRIES: u16 = 20;
/// 写入单块大小（64KB 足够大又不吃内存）
const CHUNK: usize = 64 * 1024;
/// 请求头总大小上限，防止异常请求把线程拖死
const MAX_HEADER_BYTES: usize = 64 * 1024;

static PORT: AtomicU16 = AtomicU16::new(0);

/// 当前端口；未启动返回 None。
pub fn port() -> Option<u16> {
    match PORT.load(Ordering::SeqCst) {
        0 => None,
        p => Some(p),
    }
}

/// 启动服务（幂等：已启动则直接返回端口）。失败只记日志，不影响 App 其他功能。
pub fn start(app: &AppHandle) -> Option<u16> {
    if let Some(p) = port() {
        return Some(p);
    }
    let scope = app.asset_protocol_scope();
    // App 自己生成/缓存的文件（缩略图 thumbs、转封装产物 remux）落在私有目录
    // app_data_dir/app_cache_dir/app_local_data_dir 下，并不在 `/storage/**` 的
    // asset scope 内。媒体服务必须直接放行这些目录，否则服务起来了封面/转封装视频
    // 也会被 403，真机表现为「源不可用」。外部用户文件仍走 scope 校验（见 serve）。
    let allowed: Vec<_> = [
        app.path().app_data_dir(),
        app.path().app_cache_dir(),
        app.path().app_local_data_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    for i in 0..PORT_TRIES {
        let candidate = PORT_START + i;
        match TcpListener::bind(("127.0.0.1", candidate)) {
            Ok(listener) => {
                let scope = scope.clone();
                let allowed = allowed.clone();
                std::thread::spawn(move || {
                    for stream in listener.incoming() {
                        match stream {
                            Ok(s) => {
                                let scope = scope.clone();
                                let allowed = allowed.clone();
                                std::thread::spawn(move || serve(s, &scope, &allowed));
                            }
                            Err(e) => {
                                log::warn!("media server accept failed: {e}");
                                std::thread::sleep(Duration::from_millis(50));
                            }
                        }
                    }
                });
                PORT.store(candidate, Ordering::SeqCst);
                log::info!("media server listening on 127.0.0.1:{candidate}");
                return Some(candidate);
            }
            Err(e) => {
                log::warn!("media server cannot bind {candidate}: {e}");
            }
        }
    }
    log::error!("media server failed to bind any port");
    None
}

/// 允许经本服务取出的扩展名：影片 + 缩略图/封面。其余一律 403。
fn is_servable(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    crate::commands::VIDEO_EXTS.contains(&ext.as_str())
        || matches!(ext.as_str(), "bmp" | "png" | "jpg" | "jpeg" | "webp")
}

/// Content-Type 表：媒体元素靠它决定要不要解码，猜错会直接播不出来。
fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("avi") => "video/x-msvideo",
        Some("mov") => "video/quicktime",
        Some("wmv") => "video/x-ms-wmv",
        Some("flv") => "video/x-flv",
        Some("ts") | Some("m2ts") => "video/mp2t",
        Some("3gp") => "video/3gpp",
        Some("mpg") | Some("mpeg") => "video/mpeg",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// 极简 percent-decode：只还原 `%XX`（`encodeURIComponent` 的产物），不做 `+` → 空格。
fn percent_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 解析单段 Range：`bytes=0-` / `bytes=100-200` / `bytes=-500`（后缀长度）。
/// 多段（`bytes=0-1,3-4`）不解析，交给调用方退回 200 全量，避免 multipart 拖慢首帧。
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let rest = header.trim().strip_prefix("bytes=")?;
    let first = rest.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;
    let (start, end) = if start_s.trim().is_empty() {
        let n: u64 = end_s.trim().parse().ok()?;
        if n == 0 || n > len {
            return None;
        }
        (len - n, len - 1)
    } else {
        let start: u64 = start_s.trim().parse().ok()?;
        let end: u64 = if end_s.trim().is_empty() {
            len - 1
        } else {
            end_s.trim().parse::<u64>().ok()?.min(len - 1)
        };
        (start, end)
    };
    if start >= len || start > end {
        return None;
    }
    Some((start, end))
}

/// 从请求行取出 `/media?p=<path>` 的 p 参数（已解码）。
fn requested_path(request_line: &str) -> Option<PathBuf> {
    let target = request_line.split_whitespace().nth(1)?;
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut raw: Option<&str> = None;
    for kv in query.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            if k == "p" {
                raw = Some(v);
                break;
            }
        }
    }
    let raw = raw?;
    let decoded = percent_decode(raw);
    String::from_utf8(decoded)
        .ok()
        .map(|s| PathBuf::from(s.trim().to_string()))
}

fn write_status<W: Write>(stream: &mut W, status: &str) {
    let _ = stream.write_all(
        format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
    );
    let _ = stream.flush();
}

/// 一个连接可能承载多个请求（keep-alive）；出错或超时即退出线程。
fn serve(stream: TcpStream, scope: &tauri::scope::fs::Scope, allowed: &[PathBuf]) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let mut reader = BufReader::new(&stream);
    let mut stream = &stream;
    loop {
        let mut request_line = String::new();
        match reader.read_line(&mut request_line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if request_line.trim().is_empty() {
            break;
        }

        // 读 header
        let mut range: Option<String> = None;
        let mut keep_alive = false;
        let mut header_bytes = 0usize;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(n) => header_bytes += n,
            }
            if line.trim().is_empty() {
                break;
            }
            if header_bytes > MAX_HEADER_BYTES {
                break;
            }
            let lower = line.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("range:") {
                range = Some(v.trim().to_string());
            }
            if lower.starts_with("connection:") && lower.contains("keep-alive") {
                keep_alive = true;
            }
        }

        let Some(path) = requested_path(&request_line) else {
            write_status(&mut stream, "400 Bad Request");
            break;
        };

        // 三重校验：类型 → 存在 → scope（与 asset 协议同一份判定）
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !is_servable(&path) {
            log::warn!("media server rejected: extension not servable (.{ext})");
            write_status(&mut stream, "403 Forbidden");
            break;
        }
        // 越权路径（含 `..`）一律拒绝：允许 App 私有目录放行，但绝不能让
        // `/data/user/0/<pkg>/files/../shared_prefs/x.mp4` 这类跨出 App 目录。
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            log::warn!("media server rejected: path traversal (.{ext})");
            write_status(&mut stream, "403 Forbidden");
            break;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            log::warn!("media server: file not readable (.{ext})");
            write_status(&mut stream, "404 Not Found");
            break;
        };
        if !meta.is_file() {
            write_status(&mut stream, "404 Not Found");
            break;
        }
        // 内部缓存（缩略图/转封装产物）在 App 私有目录里，直接放行；
        // 外部用户文件（/storage/** 等）仍走 asset scope 校验。
        let in_app_dir = allowed.iter().any(|p| path.starts_with(p));
        if !in_app_dir && !scope.is_allowed(&path) {
            log::warn!("media server rejected: path outside asset scope (.{ext})");
            write_status(&mut stream, "403 Forbidden");
            break;
        }

        let len = meta.len();
        let mut file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => {
                write_status(&mut stream, "403 Forbidden");
                break;
            }
        };

        let (status, start, end) = match range.as_deref().and_then(|r| parse_range(r, len)) {
            Some((s, e)) => ("206 Partial Content", s, e),
            None => ("200 OK", 0, len.saturating_sub(1)),
        };
        let nbytes = end + 1 - start;

        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {nbytes}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\n",
            mime_for(&path)
        );
        if status.starts_with("206") {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
        }
        head.push_str(if keep_alive {
            "Connection: keep-alive\r\n\r\n"
        } else {
            "Connection: close\r\n\r\n"
        });
        if stream.write_all(head.as_bytes()).is_err() {
            break;
        }

        if file.seek(SeekFrom::Start(start)).is_err() {
            break;
        }
        let mut remaining = nbytes;
        let mut buf = vec![0u8; CHUNK];
        let mut ok = true;
        while remaining > 0 {
            let want = remaining.min(CHUNK as u64) as usize;
            match file.read(&mut buf[..want]) {
                Ok(0) => break,
                Ok(n) => {
                    if stream.write_all(&buf[..n]).is_err() {
                        ok = false;
                        break;
                    }
                    remaining -= n as u64;
                }
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok || stream.flush().is_err() || !keep_alive {
            break;
        }
    }
}

#[tauri::command]
pub fn media_server_port() -> Result<u16, String> {
    port().ok_or_else(|| "media_server_not_running".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn decodes_percent_encoding() {
        assert_eq!(
            percent_decode("%2Fstorage%2Fa%20b.mp4"),
            b"/storage/a b.mp4"
        );
        assert_eq!(percent_decode("plain.txt"), b"plain.txt");
        // 残缺的 % 序列原样保留，不 panic
        assert_eq!(percent_decode("%2"), b"%2");
    }

    #[test]
    fn parses_single_ranges() {
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=100-200", 1000), Some((100, 200)));
        // 后缀长度：最后 500 字节
        assert_eq!(parse_range("bytes=-500", 1000), Some((500, 999)));
        // 越界与非法
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=500-400", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        // 结尾超出文件长度时截断到末尾
        assert_eq!(parse_range("bytes=990-9999", 1000), Some((990, 999)));
    }

    #[test]
    fn multi_range_is_not_parsed() {
        // 多段退回 200 全量（首帧优先），由调用方处理
        assert_eq!(parse_range("bytes=0-1,3-4", 1000), Some((0, 1)));
    }

    #[test]
    fn extracts_requested_path() {
        let line = "GET /media?p=%2Fstorage%2Femulated%2F0%2Fa.mp4 HTTP/1.1";
        assert_eq!(
            requested_path(line),
            Some(PathBuf::from("/storage/emulated/0/a.mp4"))
        );
        assert_eq!(requested_path("GET /media HTTP/1.1"), None);
        assert_eq!(requested_path("GET / HTTP/1.1"), None);
    }

    #[test]
    fn only_video_and_thumb_are_servable() {
        assert!(is_servable(Path::new("/storage/a.MP4")));
        assert!(is_servable(Path::new("/storage/a.mkv")));
        assert!(is_servable(Path::new("/data/thumbs/x.png")));
        assert!(!is_servable(Path::new("/data/app/config.json")));
        assert!(!is_servable(Path::new("/storage/no_ext")));
    }

    #[test]
    fn mime_is_guessable_for_media() {
        assert_eq!(mime_for(Path::new("a.mp4")), "video/mp4");
        assert_eq!(mime_for(Path::new("a.mkv")), "video/x-matroska");
        assert_eq!(mime_for(Path::new("a.png")), "image/png");
        assert_eq!(mime_for(Path::new("a.unknown")), "application/octet-stream");
    }
}
