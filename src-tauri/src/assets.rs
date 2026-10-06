//! 动态资源放行（dynamic asset release）——W4 播放页前置。
//!
//! 静态 scope（`tauri.conf.json > app.security.assetProtocol.scope`）只能覆盖**构建期已知**路径
//! （本项目只有 `$APPDATA/thumbs/**`），而用户运行时选择的影片根目录、外挂字幕/字体，必须在运行时
//! 按需放行，否则 `convertFileSrc()` 出来的 URL 会被 asset 协议拦下，表现为看不见/放不了。
//!
//! 本模块把「什么能放行」抽成一张**可配置规则表**，并明确三条边界：
//!
//! - **适用目标**：除 iOS / Android 以外的所有目标（桌面三大件、Web、小程序容器、其他跨平台宿主）。
//!   iOS / Android 走既有逻辑，本模块对它们只是 no-op（见 [`dynamic_grant_supported`]）。
//! - **资源类型**：影片 / 字幕 / 封面 / 缩略图 / 字体 / 配置，**全都是本地文件**。
//!   远程脚本、CDN 样式、插件包**不在本机制之内**——它们受 CSP 与网络白名单约束，
//!   本机制不会、也不应为其开绿灯（asset 协议 scope 只能描述本地路径）。
//! - **优先级**（[`grant`] 的判定顺序）：显式拒绝 > 既有允许 > 平台不支持（跳过）> 类型规则 > 授权。

use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 动态资源类型。
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Video,
    Subtitle,
    Cover,
    Thumb,
    Font,
    Config,
}

/// 授权粒度。目录按「用户选中的根」处理（递归），单文件只给这一个文件。
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantMode {
    DirRecursive,
    File,
}

/// 对外可见的规则（供前端核对放行范围与调试用）。
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct AssetRuleView {
    pub kind: AssetKind,
    pub exts: &'static [&'static str],
    pub mode: GrantMode,
    pub enabled: bool,
}

struct AssetRule {
    kind: AssetKind,
    exts: &'static [&'static str],
    mode: GrantMode,
    enabled: bool,
}

impl AssetRule {
    const fn new(
        kind: AssetKind,
        exts: &'static [&'static str],
        mode: GrantMode,
        enabled: bool,
    ) -> Self {
        Self {
            kind,
            exts,
            mode,
            enabled,
        }
    }

    const fn view(&self) -> AssetRuleView {
        AssetRuleView {
            kind: self.kind,
            exts: self.exts,
            mode: self.mode,
            enabled: self.enabled,
        }
    }
}

/// 规则表：想扩展放行范围，改这里即可，不需要改调用方。
/// `enabled: false` 的条目保留在表里，方便将来按需开放而不丢上下文。
static RULES: &[AssetRule] = &[
    AssetRule::new(AssetKind::Video, VIDEO_EXTS, GrantMode::DirRecursive, true),
    AssetRule::new(
        AssetKind::Subtitle,
        &["srt", "ass", "ssa", "vtt", "sub", "idx"],
        GrantMode::File,
        true,
    ),
    AssetRule::new(
        AssetKind::Cover,
        &["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp"],
        GrantMode::File,
        true,
    ),
    AssetRule::new(AssetKind::Thumb, &["bmp", "png"], GrantMode::File, true),
    AssetRule::new(
        AssetKind::Font,
        &["ttf", "otf", "woff", "woff2"],
        GrantMode::File,
        true,
    ),
    AssetRule::new(AssetKind::Config, &["json", "toml"], GrantMode::File, false),
];

/// 与扫描器共用同一份影片扩展名表，避免「能扫出来却放不了行」。
const VIDEO_EXTS: &[&str] = crate::commands::VIDEO_EXTS;

/// Unix 侧永不放行的系统区。
const DENY_UNIX: &[&str] = &[
    "/etc",
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/proc",
    "/dev",
    "/sys",
    "/System",
    "/boot",
];

/// Unix 系统区 + Windows 由环境变量指认的系统目录。
fn protected_dirs() -> Vec<PathBuf> {
    // `push` 只发生在下面的 windows 分支，非 Windows（Android / macOS）下这里会被判
    // `unused_mut`——移动端构建已经有警告，别让它在 `clippy -D warnings` 下变成错误。
    #[allow(unused_mut)]
    let mut out: Vec<PathBuf> = DENY_UNIX.iter().map(PathBuf::from).collect();
    #[cfg(windows)]
    for key in [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ] {
        if let Ok(v) = std::env::var(key) {
            out.push(PathBuf::from(v));
        }
    }
    out
}

/// iOS / Android 保持既有逻辑不变：本模块对它们只是 no-op。
pub fn dynamic_grant_supported() -> bool {
    !cfg!(any(target_os = "android", target_os = "ios"))
}

/// 规范化成绝对路径用于 scope 比对。
///
/// 关键坑（Windows）：`Path::canonicalize()` 一律带出 `\\?\` 长路径前缀，
/// 而前端 `convertFileSrc()` 是拿**库里存的原始路径**拼 asset URL 的。两边形态不一致，
/// scope 的逐段比较会判为「不在允许范围」，表现为「grant 返回 granted、播放依旧 403」。
fn normalize(p: &Path) -> PathBuf {
    strip_verbatim(p.canonicalize().unwrap_or_else(|_| p.to_path_buf()))
}

/// 剥掉 Windows 长路径前缀：`\\?\E:\a` → `E:\a`、`\\?\UNC\nas\s` → `\\nas\s`。
fn strip_verbatim(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.as_os_str().to_string_lossy().to_string();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p
}

/// 逐段比较，避免 `/tmpfoo` 被误判成 `/tmp` 的子路径。
fn is_under(base: &Path, target: &Path) -> bool {
    let base: Vec<Component> = base.components().collect();
    let target: Vec<Component> = target.components().collect();
    target.len() >= base.len() && base.iter().zip(target.iter()).all(|(a, b)| a == b)
}

fn is_protected(p: &Path) -> bool {
    let target = normalize(p);
    protected_dirs().iter().any(|d| is_under(d, &target))
}

/// 由扩展名判定资源类型；目录没有类型（按「用户选中的根」处理）。
fn classify(p: &Path) -> Option<AssetKind> {
    if p.is_dir() {
        return None;
    }
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    RULES
        .iter()
        .find(|r| r.exts.contains(&ext.as_str()))
        .map(|r| r.kind)
}

/// 决定授权粒度：`None` 表示该资源不在规则表内，不放行。
fn plan(p: &Path, kind: Option<AssetKind>) -> Option<GrantMode> {
    if p.is_dir() {
        return Some(GrantMode::DirRecursive);
    }
    kind.and_then(|k| {
        RULES
            .iter()
            .find(|r| r.kind == k && r.enabled)
            .map(|r| r.mode)
    })
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AssetGrant {
    pub path: String,
    pub kind: Option<AssetKind>,
    pub mode: Option<GrantMode>,
    pub applied: bool,
    pub reason: &'static str,
}

/// 为一条用户选择的路径补齐 asset 协议授权。幂等：重复调用不会堆重复规则。
pub fn grant(app: &AppHandle, raw: &str) -> AssetGrant {
    let done =
        |applied: bool, reason: &'static str, mode: Option<GrantMode>, kind: Option<AssetKind>| {
            AssetGrant {
                path: raw.to_string(),
                kind,
                mode,
                applied,
                reason,
            }
        };

    let p = PathBuf::from(raw);
    if raw.trim().is_empty() || !p.exists() {
        return done(false, "path_missing", None, None);
    }
    let scope = app.asset_protocol_scope();
    if is_protected(&p) {
        // 显式禁止优先级最高：即便别处给了更宽的 allow，也把它压回去
        let _ = scope.forbid_directory(&p, true);
        return done(false, "denied_protected", None, None);
    }
    if !dynamic_grant_supported() {
        return done(false, "skipped_mobile", None, None);
    }

    let kind = classify(&p);
    let Some(mode) = plan(&p, kind) else {
        return done(false, "kind_not_allowed", None, kind);
    };
    let canonical = normalize(&p);
    if scope.is_allowed(&canonical) {
        return done(false, "already_allowed", Some(mode), kind);
    }
    let res = match mode {
        GrantMode::DirRecursive => scope.allow_directory(&canonical, true),
        GrantMode::File => scope.allow_file(&canonical),
    };
    match res {
        Ok(()) => done(true, "granted", Some(mode), kind),
        Err(_) => done(false, "scope_error", Some(mode), kind),
    }
}

/// 移除根目录时收回：`forbidden` 优先级高于 `allowed`，此前给过的 allow 会失效。
pub fn revoke(app: &AppHandle, raw: &str) -> AssetGrant {
    let p = PathBuf::from(raw);
    if !dynamic_grant_supported() || raw.trim().is_empty() || !p.exists() {
        return AssetGrant {
            path: raw.to_string(),
            kind: None,
            mode: None,
            applied: false,
            reason: "skipped",
        };
    }
    let scope = app.asset_protocol_scope();
    let target = normalize(&p);
    let res = if target.is_dir() {
        scope.forbid_directory(&target, true)
    } else {
        scope.forbid_file(&target)
    };
    AssetGrant {
        path: raw.to_string(),
        kind: None,
        mode: None,
        applied: res.is_ok(),
        reason: if res.is_ok() {
            "revoked"
        } else {
            "scope_error"
        },
    }
}

/// 启动恢复：runtime 授权不落盘，每次冷启动都要按库里的根目录重新放行。
pub fn grant_persisted_roots(app: &AppHandle) -> usize {
    if !dynamic_grant_supported() {
        return 0;
    }
    let Ok(conn) = crate::db::open_db(app) else {
        return 0;
    };
    let Ok(mut stmt) = conn.prepare("SELECT path FROM roots") else {
        return 0;
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return 0;
    };
    let mut granted = 0;
    for path in rows.flatten() {
        if grant(app, &path).applied {
            granted += 1;
        }
    }
    granted
}

#[tauri::command]
pub async fn grant_asset_root(root: String, app: AppHandle) -> Result<AssetGrant, String> {
    Ok(grant(&app, &root))
}

#[tauri::command]
pub async fn list_asset_rules() -> Result<Vec<AssetRuleView>, String> {
    Ok(RULES.iter().map(AssetRule::view).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_extensions_to_kinds() {
        assert_eq!(classify(Path::new("a.MP4")), Some(AssetKind::Video));
        assert_eq!(classify(Path::new("a.mkv")), Some(AssetKind::Video));
        assert_eq!(classify(Path::new("a.srt")), Some(AssetKind::Subtitle));
        assert_eq!(classify(Path::new("a.jpg")), Some(AssetKind::Cover));
        assert_eq!(classify(Path::new("a.ttf")), Some(AssetKind::Font));
        assert_eq!(classify(Path::new("a.exe")), None);
        assert_eq!(classify(Path::new("no_ext")), None);
    }

    #[test]
    fn disabled_kind_is_not_granted() {
        // Config 规则 enabled=false：单文件场景应被拦下
        assert_eq!(plan(Path::new("a.json"), Some(AssetKind::Config)), None);
        assert_eq!(
            plan(Path::new("a.srt"), Some(AssetKind::Subtitle)),
            Some(GrantMode::File)
        );
    }

    #[test]
    fn directory_is_always_recursive_and_unknown_kind_is_dropped() {
        let cwd = std::env::current_dir().unwrap();
        // 目录无论是什么名字都按「用户选中的根」递归放行
        assert_eq!(plan(&cwd, None), Some(GrantMode::DirRecursive));
        // 表外的单文件（toml 属于 enabled=false 的 Config）不放行
        assert_eq!(plan(&cwd.join("Cargo.toml"), None), None);
    }

    #[test]
    fn prefix_match_is_component_wise() {
        assert!(is_under(Path::new("/etc"), Path::new("/etc/passwd")));
        assert!(!is_under(Path::new("/etc"), Path::new("/etcx/passwd")));
        assert!(!is_under(Path::new("/etc/passwd"), Path::new("/etc")));
    }

    #[test]
    fn normalize_has_no_windows_verbatim_prefix() {
        // Windows 上 canonicalize 会带 `\\?\` 前缀；它与 convertFileSrc() 生成的
        // asset URL 形态不一致，留在 scope 里会导致「放行成功但仍 403」。
        let n = normalize(&std::env::temp_dir());
        let s = n.to_string_lossy();
        assert!(
            !s.starts_with(r"\\?\"),
            "scope 路径不得带长路径前缀，实际：{s}"
        );
    }

    #[test]
    fn rules_table_exposes_enabled_flag() {
        let views: Vec<AssetRuleView> = RULES.iter().map(AssetRule::view).collect();
        assert_eq!(views.len(), RULES.len());
        assert!(views
            .iter()
            .any(|v| v.kind == AssetKind::Video && v.enabled));
        assert!(views
            .iter()
            .any(|v| v.kind == AssetKind::Config && !v.enabled));
    }
}
