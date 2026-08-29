import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  kind: string;
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
  const [screenPerm, setScreenPerm] = useState<boolean | null>(null);
  const recStart = useRef<number>(0);
  // iframe 重载计数（重启后强制刷新）
  const [frameKey, setFrameKey] = useState(0);
  // 防止多次触发自动启动
  const autoStarted = useRef(false);

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

  useEffect(() => {
    let un: UnlistenFn[] = [];
    let alive = true;
    (async () => {
      const subs = [
        ["dsh-status", (p: DshStatus) => alive && setStatus(p)],
        ["setup-status", (p: SetupInfo) => alive && setSetup(p)],
        ["setup-progress", (p: ProgressPayload) => alive && setProgress(p)],
        ["screen-permission", (p: boolean) => alive && setScreenPerm(p)],
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
      const [s, d, st, perm] = await Promise.all([
        invoke<DshStatus>("dsh_status"),
        invoke<DetectResult>("dsh_detect"),
        invoke<SetupInfo>("setup_status"),
        invoke<boolean>("recorder_permission_status"),
      ]);
      if (alive) setScreenPerm(perm);
      if (alive) {
        setStatus(s);
        setDetect(d);
        setSetup(st);
        // 自动启动：检测到 dsh 且尚未运行时在后台直接启动
        if (d.found && !s.running && !autoStarted.current) {
          autoStarted.current = true;
          start();
        }
      }
    })();
    return () => {
      alive = false;
      un.forEach((f) => f?.());
    };
  }, [start]);

  // 录制计时
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecDur(Math.floor((Date.now() - recStart.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [recording]);

  // toast 自动消失（3 秒）
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const restart = useCallback(async () => {
    setBusy(true);
    setError(null);
    setToast(null);
    try {
      await invoke("dsh_restart");
      setToast("dsh 已重启");
      // 等待 dsh 重新监听端口后刷新状态与 iframe
      setTimeout(async () => {
        try {
          const s = await invoke<DshStatus>("dsh_status");
          setStatus(s);
        } catch {
          /* ignore */
        }
        setFrameKey((k) => k + 1);
      }, 1500);
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

  const requestScreenPermission = useCallback(async () => {
    try {
      await invoke("recorder_request_permission");
    } catch {
      /* ignore */
    }
    try {
      const ok = await invoke<boolean>("recorder_permission_status");
      setScreenPerm(ok);
      if (!ok) {
        await invoke("recorder_open_settings");
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const toggleRec = useCallback(async () => {
    setError(null);
    setToast(null);
    if (screenPerm === false) {
      await requestScreenPermission();
      return;
    }
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
  }, [recording, screenPerm, requestScreenPermission]);

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

  // 桌面端加载 dsh UI 时附加 client=desktop 参数，供 webui 插件识别（如 dsh-recorder 据此隐藏侧栏录制按钮，避免与右上角录制重复）
  const frameUrl = useMemo(() => {
    if (!status?.url) return "about:blank";
    try {
      const u = new URL(status.url);
      u.searchParams.set("client", "desktop");
      return u.toString();
    } catch {
      return status.url;
    }
  }, [status]);

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
                {recording ? `⏹ ${fmt(recDur)}` : screenPerm === false ? "● 授权录制" : "● 录制"}
              </button>
              <button onClick={openBrowser} title="在系统浏览器中打开">
                ↗ 浏览器
              </button>
              <button onClick={restart} disabled={busy} title="重启 dsh 服务">
                {busy ? "重启中…" : "⟳ 重启"}
              </button>
            </div>
          </header>
          {screenPerm === false && (
            <div className="perm-bar">
              需要屏幕录制权限。请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许「鲸灵」，或
              <button onClick={requestScreenPermission}>打开系统设置</button>
            </div>
          )}
          {error && <div className="error-bar">{error}</div>}
          {toast && <div className="toast">{toast}</div>}
          <iframe
            key={frameKey}
            className="main-frame"
            src={frameUrl}
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
              <span>dsh 运行时</span>
              <span className={detect?.found ? "ok" : "bad"}>
                {detect?.found
                  ? detect.kind === "builtin"
                    ? `✓ 内置运行时 v${detect.version ?? "?"}`
                    : `✓ ${detect.path} (${detect.version ?? "?"})`
                  : detect
                    ? `✗ ${detect.note ?? "未找到"}`
                    : "检测中…"}
              </span>
            </div>
            {detect?.node && detect.kind !== "builtin" && (
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
