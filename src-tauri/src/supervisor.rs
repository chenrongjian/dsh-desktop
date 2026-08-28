//! dsh supervisor：探测、拉起、停止、健康检查、系统托盘。
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const DEFAULT_PORT: u16 = 3080;

/// 托管的 dsh 子进程句柄。
pub struct DshProc(pub Mutex<Option<Child>>);
/// 健康状态缓存（上一次探测结果）。
pub struct Health(pub Mutex<bool>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: u16,
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub log_file: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub node: Option<String>,
    pub note: Option<String>,
    /// 内部：启动方式 "cli" | "project"
    pub kind: String,
    pub project: Option<String>,
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dsh-desktop")
}

fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

fn dsh_home() -> PathBuf {
    std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".dsh"))
}

fn node_version() -> Option<String> {
    let out = Command::new("node").arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 常见 dsh 源码项目目录（源码运行模式）
fn candidate_projects() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut v = vec![
        home.join("WorkBuddy/DeepSeek/deepseek-harness"),
        home.join("deepseek-harness"),
        home.join(".dsh"),
    ];
    if let Ok(p) = std::env::var("DSH_PROJECT_DIR") {
        v.insert(0, PathBuf::from(p));
    }
    v
}

fn run_version(cmd: &mut Command) -> Option<String> {
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Some(
        s.lines()
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches("dsh")
            .trim()
            .to_string(),
    )
}

/// 探测本机可用的 dsh：
/// 1) PATH 中的 dsh 可执行；2) 常见 dsh 源码项目（node bin.ts）。
pub fn detect() -> DetectResult {
    let node = node_version();

    // 1) PATH 中的 dsh
    let cli_ver = run_version(Command::new("dsh").arg("--version"));
    if let Some(ver) = cli_ver {
        return DetectResult {
            found: true,
            path: Some("dsh".into()),
            version: Some(ver),
            node,
            note: None,
            kind: "cli".into(),
            project: None,
        };
    }

    // 2) 源码项目模式
    for proj in candidate_projects() {
        if !proj.join("apps/cli/src/bin.ts").exists() {
            continue;
        }
        let ver = run_version(
            Command::new("node")
                .args(["--import", "tsx/esm", "apps/cli/src/bin.ts", "--version"])
                .current_dir(&proj),
        );
        if let Some(ver) = ver {
            return DetectResult {
                found: true,
                path: Some(proj.to_string_lossy().into_owned()),
                version: Some(ver),
                node,
                note: None,
                kind: "project".into(),
                project: Some(proj.to_string_lossy().into_owned()),
            };
        }
        break;
    }

    DetectResult {
        found: false,
        path: None,
        version: None,
        node,
        note: Some(
            "未找到 dsh：请通过 PATH 安装 dsh，或将源码项目放在常见位置（~/WorkBuddy/DeepSeek/deepseek-harness）。"
                .into(),
        ),
        kind: String::new(),
        project: None,
    }
}

fn build_dsh_command(det: &DetectResult, port: u16) -> Result<Command, String> {
    let mut cmd = match det.kind.as_str() {
        "cli" => {
            let mut c = Command::new("dsh");
            c.args([
                "--profile",
                "web",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ]);
            c
        }
        "project" => {
            let dir = det
                .project
                .as_ref()
                .ok_or_else(|| "缺少项目路径".to_string())?;
            let mut c = Command::new("node");
            c.args([
                "--import",
                "tsx/esm",
                "apps/cli/src/bin.ts",
                "--profile",
                "web",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ]);
            c.current_dir(dir);
            c
        }
        _ => return Err("未找到可用的 dsh".into()),
    };
    cmd.env("DSH_HOME", dsh_home());
    Ok(cmd)
}

pub fn start(app: &AppHandle, port: u16) -> Result<u32, String> {
    let state = app.state::<DshProc>();
    let mut guard = state.0.lock().unwrap();

    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err(format!("dsh 已在运行 (PID {})", child.id()));
        }
    }
    if port_open(port) {
        // 端口已被 dsh 占用（例如外部启动的），直接接入而不重复启动
        let _ = app.emit("dsh-log", format!("端口 {port} 已有 dsh 在运行，直接接入"));
        return Ok(0);
    }

    let det = detect();
    if !det.found {
        return Err(det.note.unwrap_or_else(|| "未找到 dsh".into()));
    }

    std::fs::create_dir_all(log_dir()).map_err(|e| e.to_string())?;
    let log_file = log_dir().join("dsh.log");
    let out = std::fs::File::create(&log_file).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = build_dsh_command(&det, port)?;
    let child = cmd
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("启动 dsh 失败: {e}"))?;
    let pid = child.id();
    *guard = Some(child);
    let _ = app.emit("dsh-log", format!("dsh 已启动 (PID {pid})，日志: {log_file:?}"));
    Ok(pid)
}

pub fn stop(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DshProc>();
    let mut guard = state.0.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
        *guard = None;
    }
    let _ = app.emit("dsh-log", "dsh 已停止");
    Ok(())
}

pub fn restart(app: &AppHandle) -> Result<u32, String> {
    stop(app)?;
    start(app, DEFAULT_PORT)
}

pub fn status(app: &AppHandle) -> DshStatus {
    let state = app.state::<DshProc>();
    let mut guard = state.0.lock().unwrap();
    let proc_running = match guard.as_mut() {
        Some(c) => match c.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            Ok(None) => true,
            Err(_) => false,
        },
        None => false,
    };
    // 端口可达（例如在浏览器中已打开的 dsh）同样视为运行中
    let up = port_open(DEFAULT_PORT);
    let running = proc_running || up;
    let det = detect();
    DshStatus {
        running,
        url: Some(format!("http://127.0.0.1:{DEFAULT_PORT}")),
        port: DEFAULT_PORT,
        pid: guard.as_ref().map(|c| c.id()),
        version: det.version,
        source: det.path,
        log_file: Some(log_dir().join("dsh.log").to_string_lossy().into_owned()),
    }
}

fn port_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(addr) = addr.parse() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok()
}

/// 后台健康检查：端口可达性变化时向前端推送 dsh-status。
pub async fn health_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let up = tokio::task::spawn_blocking(|| port_open(DEFAULT_PORT))
            .await
            .unwrap_or(false);
        let health = app.state::<Health>();
        let mut guard = health.0.lock().unwrap();
        if up != *guard {
            *guard = up;
            drop(guard);
            let s = status(&app);
            let _ = app.emit("dsh-status", s);
        }
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, "open", "打开主窗口", true, None::<&str>)?;
    let restart_item = MenuItem::with_id(app, "restart", "重启 dsh", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &restart_item, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "restart" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = restart(&h);
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

// ── Tauri commands ────────────────────────────────────

#[tauri::command]
pub fn dsh_start(app: AppHandle) -> Result<u32, String> {
    start(&app, DEFAULT_PORT)
}

#[tauri::command]
pub fn dsh_stop(app: AppHandle) -> Result<(), String> {
    stop(&app)
}

#[tauri::command]
pub fn dsh_restart(app: AppHandle) -> Result<u32, String> {
    restart(&app)
}

#[tauri::command]
pub fn dsh_status(app: AppHandle) -> DshStatus {
    status(&app)
}

#[tauri::command]
pub fn dsh_detect() -> DetectResult {
    detect()
}

#[tauri::command]
pub fn open_browser(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_finds_dsh() {
        let d = detect();
        assert!(d.found, "应检测到 dsh：{d:?}");
        assert!(matches!(d.kind.as_str(), "cli" | "project"));
    }

    #[test]
    fn build_command_uses_port() {
        let d = detect();
        assert!(d.found);
        let cmd = build_dsh_command(&d, 3080).unwrap();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|a| a == "3080"), "args={args:?}");
    }
}
