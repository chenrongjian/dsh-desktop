import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface DshStatus {
  running: boolean;
  url: string | null;
  port: number;
  pid: number | null;
  version: string | null;
  source: string | null;
  logFile: string | null;
}

interface DetectResult {
  found: boolean;
  path: string | null;
  version: string | null;
  node: string | null;
  note: string | null;
}

interface SetupInfo {
  nodeReady: boolean;
  dshReady: boolean;
  nodeVersion: string | null;
  dshVersion: string | null;
  runtimeDir: string;
}

interface ProgressPayload {
  label: string;
  done: number;
  total: number;
  pct: number;
}

interface StopResult {
  path: string;
  size: number;
  durationSecs: number;
}

export default function App() {
  const [status, setStatus] = useState<DshStatus | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 录制状态
  const [recording, setRecording] = useState(false);
  const [recDur, setRecDur] = useState(0);
  const recStart = useRef<number>(0);

  useEffect(() => {
    let un: UnlistenFn[] = [];
    let alive = true;
    (async () => {
      const subs = [
        ["dsh-status", (p: DshStatus) => alive && setStatus(p)],
        ["setup-status", (p: SetupInfo) => alive && setSetup(p)],
        ["setup-progress", (p: ProgressPayload) => alive && setProgress(p)],
        ["recorder-done", (p: string) => {
          if (!alive) return;
          setRecording(false);
          setToast(`录制完成：${p}`);
        }],
        ["recorder-error", (p: string) => {
          if (!alive) return;
          setRecording(false);
          setError(p);
        }],
      ] as const;
      for (const [ev, fn] of subs) {
        try {
          un.push(await listen(ev, (e) => (fn as (p: unknown) => void)(e.payload)));
        } catch {
          /* ignore */
        }
      }
      const [s, d, st] = await Promise.all([
        invoke<DshStatus>("dsh_status"),
        invoke<DetectResult>("dsh_detect"),
        invoke<SetupInfo>("setup_status"),
      ]);
      if (alive) {
        setStatus(s);
        setDetect(d);
        setSetup(st);
      }
    })();
    return () => {
      alive = false;
      un.forEach((f) => f?.());
    };
  }, []);

  // 录制计时
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecDur(Math.floor((Date.now() - recStart.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [recording]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("dsh_start");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setError(null);
    try {
      await invoke("dsh_stop");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const restart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("dsh_restart");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const openBrowser = useCallback(async () => {
    if (!status?.url) return;
    try {
      await invoke("open_browser", { url: status.url });
    } catch (e) {
      setError(String(e));
    }
  }, [status]);

  const toggleRec = useCallback(async () => {
    setError(null);
    setToast(null);
    if (recording) {
      try {
        const r = await invoke<StopResult>("recorder_stop");
        setToast(`已保存：${r.path}（${(r.size / 1024 / 1024).toFixed(1)} MB，${fmt(r.durationSecs)}）`);
      } catch (e) {
        setError(String(e));
      }
    } else {
      try {
        await invoke("recorder_start", { withMic: true, withSys: false, quality: "auto" });
        recStart.current = Date.now();
        setRecDur(0);
        setRecording(true);
      } catch (e) {
        setError(String(e));
      }
    }
  }, [recording]);

  const install = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("setup_install");
      setToast("内置运行时安装完成，请重新启动应用生效");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const running = status?.running === true;
  const installing = progress !== null && progress.total > 0 && progress.pct < 100;

  return (
    <div className="shell">
      {running ? (
        <>
          <header className="topbar">
            <div className="brand">
              <span className={`dot ${running ? "on" : ""}`} />
              <span className="brand-name">DeepSeek Harness</span>
              {status?.version && <span className="ver">{status.version}</span>}
            </div>
            <div className="actions">
              <button
                onClick={toggleRec}
                className={recording ? "rec-btn recording" : "rec-btn"}
                title={recording ? "停止录制" : "开始录制（屏幕 + 麦克风）"}
              >
                {recording ? `⏹ ${fmt(recDur)}` : "● 录制"}
              </button>
              <button onClick={openBrowser} title="在系统浏览器中打开">
                ↗ 浏览器
              </button>
              <button onClick={restart} disabled={busy} title="重启 dsh 服务">
                ⟳ 重启
              </button>
              <button onClick={stop} className="danger" title="停止 dsh 服务">
                ⏹ 停止
              </button>
            </div>
          </header>
          {error && <div className="error-bar">{error}</div>}
          {toast && <div className="toast">{toast}</div>}
          <iframe
            className="main-frame"
            src={status?.url ?? "about:blank"}
            title="DeepSeek Harness"
            allow="clipboard-read; clipboard-write; microphone; camera"
          />
        </>
      ) : (
        <div className="launcher">
          <div className="logo">DSH</div>
          <h1>DeepSeek Harness Desktop</h1>
          <p className="sub">本地运行 dsh 的桌面入口，无需终端与浏览器</p>

          <div className="card">
            <div className="row">
              <span>dsh 检测</span>
              <span className={detect?.found ? "ok" : "bad"}>
                {detect?.found
                  ? `✓ ${detect.path} (${detect.version ?? "?"})`
                  : detect
                    ? `✗ ${detect.note ?? "未找到"}`
                    : "检测中…"}
              </span>
            </div>
            {detect?.node && (
              <div className="row">
                <span>Node 运行时</span>
                <span className="dim">{detect.node}</span>
              </div>
            )}
            {!detect?.found && setup && (
              <>
                <div className="row">
                  <span>内置运行时</span>
                  <span className="dim">
                    Node: {setup.nodeReady ? "✓" : "✗"} · dsh: {setup.dshReady ? "✓" : "✗"}
                  </span>
                </div>
                {progress && (
                  <div className="row">
                    <span>{progress.label}</span>
                    <span className="dim">{progress.pct.toFixed(0)}%</span>
                  </div>
                )}
              </>
            )}
          </div>

          {error && <div className="error">{error}</div>}

          {!detect?.found ? (
            <button
              className="primary"
              onClick={install}
              disabled={busy || (setup?.nodeReady && setup?.dshReady)}
              style={{ marginTop: 24 }}
            >
              {busy && installing ? "安装中…" : busy ? "处理中…" : "↓ 安装内置运行时"}
            </button>
          ) : (
            <button
              className="primary"
              onClick={start}
              disabled={busy}
              style={{ marginTop: 24 }}
            >
              {busy ? "启动中…" : "▶ 启动 DeepSeek Harness"}
            </button>
          )}
          {!detect?.found && (
            <p className="hint">
              未检测到 dsh，可安装内置运行时；或安装 dsh 后重启应用。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
