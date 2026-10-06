// 影栈 Tauri 入口。W1-4 起注册根目录管理与扫描命令；插件只有 dialog——
// 文件读写走 Rust `std::fs`、数据库走 rusqlite 直连，fs/sql 插件用不上（W7-3 权限最小化已摘除）。
mod assets;
mod commands;
mod db;
mod dirs;
mod ffmpeg;
mod probe;
mod progress;
mod remux;
mod thumbnail;

use commands::AppState;

// 移动端必须由这个宏导出 tauri_app 入口符号（staticlib/cdylib 的入口）。
// 少了它，Gradle 会把 .so symlink 进 jniLibs 之后才校验失败：
// "does not include required runtime symbols ... missing the tauri::mobile_entry_point macro"
// ——报错发生在打包末段，极容易被误读成 Gradle/AGP 的问题。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_roots,
            commands::add_roots,
            commands::remove_root,
            commands::scan_roots,
            commands::cancel_scan,
            commands::set_realtime,
            commands::list_videos,
            assets::grant_asset_root,
            assets::list_asset_rules,
            // 移动端选目录（dialog 插件在移动端没有目录选择器，见 dirs.rs 头注）
            dirs::list_dirs,
            thumbnail::ensure_thumb,
            commands::create_group,
            commands::list_groups,
            commands::add_to_group,
            commands::remove_from_group,
            commands::set_group_order,
            commands::set_sort_order,
            commands::list_group_items,
            commands::remove_group,
            progress::get_progress,
            progress::save_progress,
            progress::clear_progress,
            probe::probe_video,
            remux::remux_to_cache,
        ])
        .setup(|app| {
            // 数据库迁移由 db::run_migrations 在首次连库时执行（见 migrations/0001_init.sql）
            // runtime 放行不落盘：按库里已存的根目录恢复一次，否则重启后旧目录又取不到文件
            crate::assets::grant_persisted_roots(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
