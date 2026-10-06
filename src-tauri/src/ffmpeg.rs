//! ffmpeg 的定位与限时执行——抽帧与转封装共用同一条外部工具依赖。
//!
//! **真机实证（v1 反馈）**：winget 装完 ffmpeg **PATH 里未必有**——`where.exe ffmpeg`
//! 找不到，二进制却躺在 `%LOCALAPPDATA%\Microsoft\WinGet\Links`。此前所有按名字直接
//! 起进程的调用都因此静默降级（抽帧全走系统图，界面上看不出原因）。
//! 这里显式查一遍：PATH 优先，Windows 上兜底 winget 目录；**查不到就让调用方明确报错**，
//! 不假装"ffmpeg 失败"。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 找到 ffmpeg 可执行文件的完整路径；找不到返回 `None`（调用方据此给明确原因）。
pub fn ffmpeg_binary() -> Option<PathBuf> {
    let name = exe_name();
    if let Some(paths) = std::env::var_os("PATH") {
        let hit = std::env::split_paths(&paths)
            .map(|d| d.join(name))
            .find(|p| p.is_file());
        if hit.is_some() {
            return hit;
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let p = PathBuf::from(local)
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// 本平台是否具备「外部 ffmpeg」这一能力（**能力判定，不是"有没有装"**）。
///
/// Android / iOS 恒为 false：APK 里不打包 ffmpeg（与 §1.2 的 APK <12MB 直接冲突），
/// 也没有用户能自己装的入口。这两者与"装了但 PATH 里没有"必须分开报——
/// 报 `ffmpeg_missing` 会让人以为装一个就好，手机上却根本没有可装的地方。
pub const fn platform_supports_ffmpeg() -> bool {
    !cfg!(any(target_os = "android", target_os = "ios"))
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// 跑一个子进程并限时：超时就 kill，避免慢盘 / 异常文件把线程占死。
pub fn run_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|e| e.to_string()),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    return Err("timeout".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_name_matches_platform() {
        if cfg!(windows) {
            assert_eq!(exe_name(), "ffmpeg.exe");
        } else {
            assert_eq!(exe_name(), "ffmpeg");
        }
    }

    #[test]
    fn timeout_kills_slow_child() {
        // sleep 5s 的子进程配 200ms 超时：必须在超时点返回，而不是等它跑完
        let mut cmd = if cfg!(windows) {
            // 不能用 `timeout /T`：无控制台时它立刻退出，测不出超时
            let mut c = Command::new("cmd");
            c.args(["/C", "ping", "-n", "6", "127.0.0.1", ">", "nul"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("5");
            c
        };
        let start = Instant::now();
        let r = run_with_timeout(&mut cmd, Duration::from_millis(200));
        assert!(r.is_err(), "超时应返回 Err");
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "不该等子进程跑完，实际耗时 {:?}",
            start.elapsed()
        );
    }
}
