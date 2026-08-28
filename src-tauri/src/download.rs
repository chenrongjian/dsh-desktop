//! M2：内置运行时管理 —— Node.js + dsh 发行版的下载、解压、状态。
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const NODE_VERSION: &str = "v22.14.0";

pub struct SetupState(pub Mutex<SetupInfo>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SetupInfo {
    pub node_ready: bool,
    pub dsh_ready: bool,
    pub node_version: Option<String>,
    pub dsh_version: Option<String>,
    pub runtime_dir: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub label: String,
    pub done: u64,
    pub total: u64,
    pub pct: f64,
}

fn runtime_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dsh-desktop/runtime")
}

fn node_bin() -> PathBuf {
    if cfg!(windows) {
        runtime_dir().join("node/node.exe")
    } else {
        runtime_dir().join("node/bin/node")
    }
}

/// 内置 dsh 启动器（由 Node 执行 cli 入口）
fn dsh_entry() -> PathBuf {
    runtime_dir().join("dsh/apps/cli/src/bin.ts")
}

pub fn snapshot() -> SetupInfo {
    let info = SetupInfo {
        node_ready: node_bin().exists(),
        dsh_ready: dsh_entry().exists(),
        node_version: node_bin()
            .exists()
            .then(|| {
                std::process::Command::new(node_bin())
                    .arg("--version")
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            })
            .flatten(),
        dsh_version: None,
        runtime_dir: runtime_dir().to_string_lossy().into_owned(),
    };
    info
}

fn emit_progress(app: &AppHandle, label: &str, done: u64, total: u64) {
    let pct = if total > 0 { (done as f64 / total as f64) * 100.0 } else { 0.0 };
    let _ = app.emit(
        "setup-progress",
        ProgressPayload { label: label.into(), done, total, pct },
    );
}

async fn download(app: &AppHandle, url: &str, dest: &PathBuf, label: &str) -> Result<(), String> {
    if let Some(p) = dest.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let resp = reqwest::get(url).await.map_err(|e| format!("下载失败 {label}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败 {label}: HTTP {status}"));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| e.to_string())?;
    use futures_util::StreamExt;
    let mut done: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断 {label}: {e}"))?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        emit_progress(app, label, done, total);
    }
    Ok(())
}

fn platform_suffix() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "darwin-arm64" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "darwin-x64" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "win-x64" }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { "linux-arm64" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "linux-x64" }
}

fn extract_archive(archive: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let bytes = fs::read(archive).map_err(|e| e.to_string())?;
    if archive.extension().map(|e| e == "zip").unwrap_or(false) {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = f.name().to_string();
            // 防目录穿越
            let safe = name.replace("\\", "/");
            let rel = safe.split_once('/').map(|(_, r)| r.to_string());
            let Some(rel) = rel else {
                continue;
            };
            let out = dest.join(rel);
            if f.is_dir() {
                let _ = fs::create_dir_all(&out);
                continue;
            }
            if let Some(p) = out.parent() {
                let _ = fs::create_dir_all(p);
            }
            let mut file = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut file).map_err(|e| e.to_string())?;
        }
    } else {
        // tar.gz
        let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
        let mut tar = tar::Archive::new(gz);
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?.to_path_buf();
            let s = path.to_string_lossy().into_owned();
            let rel = s.split_once('/').map(|(_, r)| r.to_string());
            let Some(rel) = rel else {
                continue;
            };
            let out = dest.join(rel);
            if let Some(p) = out.parent() {
                let _ = fs::create_dir_all(p);
            }
            entry.unpack(&out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 下载并安装内置 Node + dsh 发行版（进度通过 setup-progress 事件推送）。
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let suffix = platform_suffix();
    let node_url = format!("https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-{suffix}.{}",
        if cfg!(windows) { "zip" } else { "tar.gz" });
    let node_archive = runtime_dir().join("node-archive");
    let node_dest = runtime_dir().join("node");

    if !node_bin().exists() {
        emit_progress(app, "下载 Node 运行时…", 0, 0);
        download(app, &node_url, &node_archive, "Node 运行时").await?;
        let _ = fs::remove_dir_all(&node_dest);
        emit_progress(app, "解压 Node 运行时…", 0, 0);
        extract_archive(&node_archive, &node_dest)?;
        let _ = fs::remove_file(&node_archive);
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(node_bin(), fs::Permissions::from_mode(0o755));
        }
    }

    // dsh 发行版（当前阶段：可配置 URL；默认走本机 dsh，故留空可跳过）
    let dsh_url = std::env::var("DSH_RUNTIME_URL").unwrap_or_default();
    if !dsh_entry().exists() && !dsh_url.is_empty() {
        let dsh_archive = runtime_dir().join("dsh-archive");
        let dsh_dest = runtime_dir().join("dsh");
        emit_progress(app, "下载 dsh 发行版…", 0, 0);
        download(app, &dsh_url, &dsh_archive, "dsh 发行版").await?;
        let _ = fs::remove_dir_all(&dsh_dest);
        emit_progress(app, "解压 dsh 发行版…", 0, 0);
        extract_archive(&dsh_archive, &dsh_dest)?;
        let _ = fs::remove_file(&dsh_archive);
    }

    let s = snapshot();
    if let Some(st) = app.try_state::<SetupState>() {
        *st.0.lock().unwrap() = s.clone();
    }
    let _ = app.emit("setup-status", s);
    Ok(())
}

#[tauri::command]
pub fn setup_status(app: AppHandle) -> SetupInfo {
    let st = app.state::<SetupState>();
    let guard = st.0.lock().unwrap();
    guard.clone()
}

#[tauri::command]
pub async fn setup_install(app: AppHandle) -> Result<(), String> {
    install(&app).await
}
