mod download;
mod recorder;
mod supervisor;

use std::sync::Mutex;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(supervisor::DshProc(Mutex::new(None)))
        .manage(supervisor::Health(Mutex::new(false)))
        .manage(recorder::RecorderState {
            inner: Mutex::new(None),
        })
        .manage(download::SetupState(Mutex::new(download::snapshot())))
        .setup(|app| {
            let handle = app.handle().clone();
            supervisor::setup_tray(&handle)?;

            // 应用启动后主动请求屏幕录制权限（只做一次系统提示），并同步状态给前端。
            // 注意：macOS 屏幕录制权限与代码签名身份绑定；ad-hoc 签名每次重新部署后
            // 系统会把它视为新应用，权限会失效。要真正“永久”，需 Apple Developer 证书签名。
            let perm_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if scap::is_supported() && !scap::has_permission() {
                    scap::request_permission();
                }
                let _ = perm_handle.emit("screen-permission", scap::has_permission());
            });

            // 录制能力自检（ffmpeg / 屏幕权限 / BlackHole）
            let self_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let ffmpeg = recorder::find_ffmpeg(&self_handle).is_ok();
                let permitted = scap::has_permission();
                let blackhole = recorder::find_input_device("blackhole").is_some();
                println!(
                    "[SELFCHECK] ffmpeg={} screen_permission={} blackhole={}",
                    ffmpeg, permitted, blackhole
                );
            });

            tauri::async_runtime::spawn(async move {
                supervisor::health_loop(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            supervisor::dsh_start,
            supervisor::dsh_stop,
            supervisor::dsh_restart,
            supervisor::dsh_status,
            supervisor::dsh_detect,
            supervisor::open_browser,
            recorder::recorder_start,
            recorder::recorder_stop,
            recorder::recorder_status,
            recorder::recorder_check_blackhole,
            recorder::recorder_permission_status,
            recorder::recorder_request_permission,
            recorder::recorder_open_settings,
            recorder::recorder_open_folder,
            download::setup_status,
            download::setup_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
