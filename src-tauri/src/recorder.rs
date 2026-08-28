//! M4：屏幕 + 音频录制。
//! 视频：scap（NV12 帧）；音频：cpal（麦克风 / BlackHole 系统声音）；
//! 编码：ffmpeg sidecar（libx264 + aac）。
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SizedSample, SupportedStreamConfig};
use scap::capturer::{Capturer, Options, Resolution};
use scap::frame::Frame;
use serde::Serialize;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

pub struct RecorderState {
    pub inner: Mutex<Option<ActiveRecording>>,
}

pub struct ActiveRecording {
    pub stop: Arc<AtomicBool>,
    pub thread: Option<std::thread::JoinHandle<()>>,
    pub output: PathBuf,
    pub started: Instant,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub recording: bool,
    pub output: Option<String>,
    pub duration_secs: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StopResult {
    pub path: String,
    pub size: u64,
    pub duration_secs: f64,
}

fn recordings_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    let dir = dirs::video_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Movies"))
        .join("dsh-recordings");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn tmp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tmp");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn ffmpeg_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

pub fn find_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().resource_dir() {
        let name = ffmpeg_name();
        for candidate in [dir.join("binaries").join(name), dir.join(name)] {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    if Command::new(ffmpeg_name())
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Ok(PathBuf::from(ffmpeg_name()));
    }
    Err("未找到 ffmpeg：请安装（brew install ffmpeg）或放置静态二进制".into())
}

fn quality_to_args(quality: &str) -> (Resolution, String) {
    match quality {
        "720p" => (Resolution::_720p, "4M".into()),
        "1080p" => (Resolution::_1080p, "8M".into()),
        _ => (Resolution::Captured, "5M".into()),
    }
}

/// 查找名字包含关键字的输入设备（用于系统声音：BlackHole 虚拟声卡）。
pub fn find_input_device(hint: &str) -> Option<Device> {
    let host = cpal::default_host();
    host.input_devices().ok()?.find(|d| {
        d.name()
            .map(|n| n.to_lowercase().contains(hint))
            .unwrap_or(false)
    })
}

fn audio_config(device: &Device) -> Result<SupportedStreamConfig, String> {
    device
        .default_input_config()
        .map_err(|e| format!("无法读取音频设备配置: {e}"))
}

/// 用 cpal 采集输入设备，写成 f32le 原始 PCM，直到 stop 置位。
fn capture_audio(
    device: Device,
    file: Arc<Mutex<BufWriter<fs::File>>>,
    stop: Arc<AtomicBool>,
) -> Result<(u32, u16), String> {
    let config = audio_config(&device)?;
    let rate = config.sample_rate().0;
    let channels = config.channels();
    let stream_config: cpal::StreamConfig = config.clone().into();

    fn build<T: SizedSample>(
        device: &Device,
        cfg: &cpal::StreamConfig,
        file: &Arc<Mutex<BufWriter<fs::File>>>,
    ) -> Result<cpal::Stream, String>
    where
        f32: dasp_sample::conv::FromSample<T>,
    {
        let file = file.clone();
        device
            .build_input_stream(
                cfg,
                move |data: &[T], _| {
                    if let Ok(mut f) = file.lock() {
                        let bytes: Vec<u8> = data
                            .iter()
                            .flat_map(|s| s.to_sample::<f32>().to_le_bytes())
                            .collect();
                        let _ = f.write_all(&bytes);
                    }
                },
                move |e| eprintln!("[recorder] audio error: {e}"),
                None,
            )
            .map_err(|e| format!("音频流创建失败: {e}"))
    }

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, &stream_config, &file)?,
        cpal::SampleFormat::I16 => build::<i16>(&device, &stream_config, &file)?,
        cpal::SampleFormat::U16 => build::<u16>(&device, &stream_config, &file)?,
        other => return Err(format!("不支持的音频格式: {other:?}")),
    };
    stream.play().map_err(|e| format!("音频启动失败: {e}"))?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(stream);
    Ok((rate, channels))
}

fn build_ffmpeg_encode_cmd(
    ffmpeg: &Path,
    w: u32,
    h: u32,
    fps: u32,
    bitrate: &str,
    silent: &Path,
) -> Command {
    let mut c = Command::new(ffmpeg);
    c.args(["-y", "-f", "rawvideo", "-pix_fmt", "nv12"])
        .args(["-s", &format!("{w}x{h}"), "-r", &fps.to_string()])
        .args(["-i", "pipe:0"])
        .args(["-an", "-c:v", "libx264", "-preset", "veryfast", "-b:v", bitrate])
        .args(["-pix_fmt", "yuv420p", silent.to_str().unwrap()]);
    c
}

/// 合成：无声 mp4 + 若干 f32le 音轨 → 最终 mp4。
fn mux(
    ffmpeg: &Path,
    silent: &Path,
    tracks: &[(PathBuf, u32, u16)],
    out: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y").arg("-i").arg(silent);
    for (i, (f, rate, ch)) in tracks.iter().enumerate() {
        cmd.args(["-f", "f32le", "-ar", &rate.to_string(), "-ac", &ch.to_string()])
            .arg("-i")
            .arg(f);
        let _ = i;
    }
    match tracks.len() {
        0 => {
            fs::rename(silent, out).map_err(|e| e.to_string())?;
            return Ok(());
        }
        1 => {
            cmd.args(["-map", "0:v", "-map", "1:a", "-c:v", "copy"])
                .args(["-c:a", "aac", "-b:a", "192k", "-shortest"])
                .arg(out);
        }
        n => {
            let mut fc = String::new();
            for i in 1..=n {
                fc.push_str(&format!("[{i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];"));
            }
            for i in 1..=n {
                fc.push_str(&format!("[a{i}]"));
            }
            fc.push_str(&format!("amix=inputs={n}:normalize=0[a]"));
            cmd.args(["-filter_complex", &fc, "-map", "0:v", "-map", "[a]"])
                .args(["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest"])
                .arg(out);
        }
    }
    let output = cmd
        .output()
        .map_err(|e| format!("ffmpeg 运行失败: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg 合成失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn record_loop(
    app: AppHandle,
    stop: Arc<AtomicBool>,
    output: PathBuf,
    with_mic: bool,
    with_sys: bool,
    quality: &str,
) -> Result<(), String> {
    let ffmpeg = find_ffmpeg(&app)?;
    let tmp = tmp_dir(&app)?;
    let silent = tmp.join(format!("silent_{}.mp4", std::process::id()));
    let (res, bitrate) = quality_to_args(quality);

    // 音频轨（先打开文件，避免线程内再出错）
    let mut tracks: Vec<(PathBuf, u32, u16)> = Vec::new();
    let mut audio_jobs: Vec<(std::thread::JoinHandle<Result<(u32, u16), String>>, PathBuf)> = Vec::new();

    if with_mic {
        let dev = cpal::default_host()
            .default_input_device()
            .ok_or("未找到麦克风设备")?;
        let f = fs::File::create(tmp.join("mic.raw")).map_err(|e| e.to_string())?;
        let guard = Arc::new(Mutex::new(BufWriter::new(f)));
        let s = stop.clone();
        let p = tmp.join("mic.raw");
        audio_jobs.push((std::thread::spawn(move || capture_audio(dev, guard, s)), p));
    }

    if with_sys {
        let dev = find_input_device("blackhole")
            .ok_or("未检测到 BlackHole 虚拟声卡。macOS 系统声音需先安装 BlackHole（https://github.com/ExistentialAudio/BlackHole）")?;
        let f = fs::File::create(tmp.join("sys.raw")).map_err(|e| e.to_string())?;
        let guard = Arc::new(Mutex::new(BufWriter::new(f)));
        let s = stop.clone();
        let p = tmp.join("sys.raw");
        audio_jobs.push((std::thread::spawn(move || capture_audio(dev, guard, s)), p));
    }

    // 屏幕捕获
    let options = Options {
        fps: 30,
        show_cursor: true,
        show_highlight: false,
        target: None,
        crop_area: None,
        output_type: scap::frame::FrameType::YUVFrame,
        output_resolution: res,
        excluded_targets: None,
    };
    let mut capturer = Capturer::build(options).map_err(|e| format!("屏幕捕获初始化失败: {e}"))?;
    let [w, h] = capturer.get_output_frame_size();

    // ffmpeg 编码器
    let mut cmd = build_ffmpeg_encode_cmd(&ffmpeg, w, h, 30, &bitrate, &silent);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg 启动失败: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("ffmpeg stdin 不可用")?;

    capturer.start_capture();
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match capturer.get_next_frame() {
            Ok(Frame::YUVFrame(f)) => {
                if stdin.write_all(&f.luminance_bytes).is_err() {
                    break;
                }
                if stdin.write_all(&f.chrominance_bytes).is_err() {
                    break;
                }
            }
            Ok(_) => continue,
            Err(_) => break,
        }
    }
    capturer.stop_capture();

    // 结束视频流
    drop(stdin);
    let _ = child.wait();

    // 结束音频并收集各轨 (文件, 采样率, 声道)
    stop.store(true, Ordering::Relaxed);
    for (handle, path) in audio_jobs {
        match handle.join() {
            Ok(Ok((rate, ch))) => tracks.push((path, rate, ch)),
            Ok(Err(e)) => eprintln!("[recorder] 音频采集结束异常: {e}"),
            Err(_) => eprintln!("[recorder] 音频线程崩溃"),
        }
    }

    mux(&ffmpeg, &silent, &tracks, &output)?;
    let _ = fs::remove_file(&silent);
    let _ = fs::remove_file(tmp.join("mic.raw"));
    let _ = fs::remove_file(tmp.join("sys.raw"));
    let _ = app.emit("recorder-done", output.to_string_lossy().into_owned());
    Ok(())
}

// ── Tauri commands ────────────────────────────────────

#[tauri::command]
pub fn recorder_start(
    app: AppHandle,
    with_mic: Option<bool>,
    with_sys: Option<bool>,
    quality: Option<String>,
) -> Result<String, String> {
    let state = app.state::<RecorderState>();
    let mut guard = state.inner.lock().unwrap();
    if guard.is_some() {
        return Err("已在录制中".into());
    }

    if !scap::is_supported() {
        return Err("当前系统不支持屏幕捕获".into());
    }
    if !scap::has_permission() {
        scap::request_permission();
        return Err("需要屏幕录制权限。请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许本应用后重试。".into());
    }

    let out_dir = recordings_dir(&app)?;
    let output = out_dir.join(format!(
        "rec_{}.mp4",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ));

    let stop = Arc::new(AtomicBool::new(false));
    let app_loop = app.clone();
    let app_err = app.clone();
    let stop2 = stop.clone();
    let quality = quality.unwrap_or_else(|| "auto".into());
    let with_mic = with_mic.unwrap_or(false);
    let with_sys = with_sys.unwrap_or(false);
    let out_for_loop = output.clone();

    let handle = std::thread::spawn(move || {
        if let Err(e) = record_loop(app_loop, stop2, out_for_loop, with_mic, with_sys, &quality) {
            eprintln!("[recorder] {e}");
            let _ = app_err.emit("recorder-error", e);
        }
    });

    *guard = Some(ActiveRecording {
        stop,
        thread: Some(handle),
        output: output.clone(),
        started: Instant::now(),
    });
    Ok(output.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn recorder_stop(app: AppHandle) -> Result<StopResult, String> {
    let state = app.state::<RecorderState>();
    let mut guard = state.inner.lock().unwrap();
    let Some(rec) = guard.take() else {
        return Err("当前没有进行中的录制".into());
    };
    rec.stop.store(true, Ordering::Relaxed);
    if let Some(t) = rec.thread {
        let _ = t.join();
    }
    let dur = rec.started.elapsed().as_secs_f64();
    let size = fs::metadata(&rec.output).map(|m| m.len()).unwrap_or(0);
    Ok(StopResult {
        path: rec.output.to_string_lossy().into_owned(),
        size,
        duration_secs: dur,
    })
}

#[tauri::command]
pub fn recorder_status(app: AppHandle) -> RecorderStatus {
    let state = app.state::<RecorderState>();
    let guard = state.inner.lock().unwrap();
    match guard.as_ref() {
        Some(r) => RecorderStatus {
            recording: true,
            output: Some(r.output.to_string_lossy().into_owned()),
            duration_secs: r.started.elapsed().as_secs_f64(),
        },
        None => RecorderStatus {
            recording: false,
            output: None,
            duration_secs: 0.0,
        },
    }
}

#[tauri::command]
pub fn recorder_check_blackhole() -> bool {
    find_input_device("blackhole").is_some()
}

#[tauri::command]
pub fn recorder_request_permission() -> Result<(), String> {
    if !scap::has_permission() {
        scap::request_permission();
        return Err("请在系统设置中授权屏幕录制后重试".into());
    }
    Ok(())
}

#[tauri::command]
pub fn recorder_open_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = recordings_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}
