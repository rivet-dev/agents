import {
  AppWindow,
  Camera,
  Circle,
  Clipboard,
  Download,
  ExternalLink,
  Loader2,
  Monitor,
  MousePointer,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SandboxAgentError } from "sandbox-agent";
import type { DesktopRecordingInfo, DesktopStatusResponse, DesktopWindowInfo, SandboxAgent } from "sandbox-agent";
import { DesktopViewer } from "@sandbox-agent/react";
import type { DesktopViewerClient } from "@sandbox-agent/react";
const MIN_SPIN_MS = 350;
type DesktopScreenshotRequest = Parameters<SandboxAgent["takeDesktopScreenshot"]>[0] & {
  showCursor?: boolean;
};
type DesktopStartRequestWithAdvanced = Parameters<SandboxAgent["startDesktop"]>[0] & {
  streamVideoCodec?: string;
  streamAudioCodec?: string;
  streamFrameRate?: number;
  webrtcPortRange?: string;
  recordingFps?: number;
};
const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof SandboxAgentError && error.problem?.detail) return error.problem.detail;
  if (error instanceof Error) return error.message;
  return fallback;
};
const formatStartedAt = (value: string | null | undefined): string => {
  if (!value) return "Not started";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
};
const formatDuration = (start: string, end?: string | null): string => {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return "Unknown";
  const seconds = Math.round((endMs - startMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
};
const createScreenshotUrl = async (bytes: Uint8Array, mimeType = "image/png"): Promise<string> => {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const blob = new Blob([payload.buffer], { type: mimeType });
  if (typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(blob);
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read screenshot blob."));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read screenshot blob."));
      }
    };
    reader.readAsDataURL(blob);
  });
};
const DesktopTab = ({ getClient }: { getClient: () => SandboxAgent }) => {
  const [status, setStatus] = useState<DesktopStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState("1440");
  const [height, setHeight] = useState("900");
  const [dpi, setDpi] = useState("96");
  // Screenshot fallback
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [screenshotFormat, setScreenshotFormat] = useState<"png" | "jpeg" | "webp">("png");
  const [screenshotQuality, setScreenshotQuality] = useState("85");
  const [screenshotScale, setScreenshotScale] = useState("1.0");
  const [showCursor, setShowCursor] = useState(false);
  // Live view
  const [liveViewActive, setLiveViewActive] = useState(false);
  const [liveViewError, setLiveViewError] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [mousePosLoading, setMousePosLoading] = useState(false);
  // Memoize the client as a DesktopViewerClient so the reference is stable
  // across renders and doesn't cause the DesktopViewer effect to re-fire.
  const viewerClient = useMemo<DesktopViewerClient>(() => {
    const c = getClient();
    return {
      startDesktopStream: () => c.startDesktopStream(),
      stopDesktopStream: () => c.stopDesktopStream(),
      connectDesktopStream: (opts?: Parameters<SandboxAgent["connectDesktopStream"]>[0]) => c.connectDesktopStream(opts),
    };
  }, [getClient]);
  // Recording
  const [recordings, setRecordings] = useState<DesktopRecordingInfo[]>([]);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingActing, setRecordingActing] = useState<"start" | "stop" | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingFps, setRecordingFps] = useState("30");
  const [deletingRecordingId, setDeletingRecordingId] = useState<string | null>(null);
  const [downloadingRecordingId, setDownloadingRecordingId] = useState<string | null>(null);
  const [showAdvancedStart, setShowAdvancedStart] = useState(false);
  const [streamVideoCodec, setStreamVideoCodec] = useState("vp8");
  const [streamAudioCodec, setStreamAudioCodec] = useState("opus");
  const [streamFrameRate, setStreamFrameRate] = useState("30");
  const [webrtcPortRange, setWebrtcPortRange] = useState("59050-59070");
  const [defaultRecordingFps, setDefaultRecordingFps] = useState("30");
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardSelection, setClipboardSelection] = useState<"clipboard" | "primary">("clipboard");
  const [clipboardLoading, setClipboardLoading] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [clipboardWriteText, setClipboardWriteText] = useState("");
  const [clipboardWriting, setClipboardWriting] = useState(false);
  const [windows, setWindows] = useState<DesktopWindowInfo[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [windowsError, setWindowsError] = useState<string | null>(null);
  const [windowActing, setWindowActing] = useState<string | null>(null);
  const [editingWindow, setEditingWindow] = useState<{ id: string; action: "move" | "resize" } | null>(null);
  const [editX, setEditX] = useState("");
  const [editY, setEditY] = useState("");
  const [editW, setEditW] = useState("");
  const [editH, setEditH] = useState("");
  const [launchApp, setLaunchApp] = useState("firefox");
  const [launchArgs, setLaunchArgs] = useState("");
  const [launchWait, setLaunchWait] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [openTarget, setOpenTarget] = useState("");
  const [opening, setOpening] = useState(false);
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // Active recording tracking
  const activeRecording = useMemo(() => recordings.find((r) => r.status === "recording"), [recordings]);
  const visibleWindows = useMemo(() => {
    return windows.filter((win) => {
      const title = win.title.trim();
      if (win.isActive) return true;
      if (!title || title === "Openbox") return false;
      return win.width >= 120 && win.height >= 80;
    });
  }, [windows]);
  const revokeScreenshotUrl = useCallback(() => {
    setScreenshotUrl((current) => {
      if (current?.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  }, []);
  const loadStatus = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (mode === "initial") setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const next = await getClient().getDesktopStatus();
        setStatus(next);
        // Status response now includes windows; sync them so we get window
        // updates for free every time status is polled.
        if (next.state === "active" && next.windows?.length) {
          setWindows(next.windows);
        }
        return next;
      } catch (loadError) {
        setError(extractErrorMessage(loadError, "Unable to load desktop status."));
        return null;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [getClient],
  );
  const refreshScreenshot = useCallback(async () => {
    setScreenshotLoading(true);
    setScreenshotError(null);
    try {
      const quality = Number.parseInt(screenshotQuality, 10);
      const scale = Number.parseFloat(screenshotScale);
      const request: DesktopScreenshotRequest = {
        format: screenshotFormat !== "png" ? screenshotFormat : undefined,
        quality: screenshotFormat !== "png" && Number.isFinite(quality) ? quality : undefined,
        scale: Number.isFinite(scale) && scale !== 1.0 ? scale : undefined,
        showCursor: showCursor || undefined,
      };
      const bytes = await getClient().takeDesktopScreenshot(request);
      revokeScreenshotUrl();
      const mimeType = screenshotFormat === "jpeg" ? "image/jpeg" : screenshotFormat === "webp" ? "image/webp" : "image/png";
      setScreenshotUrl(await createScreenshotUrl(bytes, mimeType));
    } catch (captureError) {
      revokeScreenshotUrl();
      setScreenshotError(extractErrorMessage(captureError, "Unable to capture desktop screenshot."));
    } finally {
      setScreenshotLoading(false);
    }
  }, [getClient, revokeScreenshotUrl, screenshotFormat, screenshotQuality, screenshotScale, showCursor]);
  const loadMousePosition = useCallback(async () => {
    setMousePosLoading(true);
    try {
      const pos = await getClient().getDesktopMousePosition();
      setMousePos({ x: pos.x, y: pos.y });
    } catch {
      setMousePos(null);
    } finally {
      setMousePosLoading(false);
    }
  }, [getClient]);
  const loadRecordings = useCallback(async () => {
    setRecordingLoading(true);
    setRecordingError(null);
    try {
      const result = await getClient().listDesktopRecordings();
      setRecordings(result.recordings);
    } catch (loadError) {
      setRecordingError(extractErrorMessage(loadError, "Unable to load recordings."));
    } finally {
      setRecordingLoading(false);
    }
  }, [getClient]);
  const loadClipboard = useCallback(async () => {
    setClipboardLoading(true);
    setClipboardError(null);
    try {
      const result = await getClient().getDesktopClipboard({ selection: clipboardSelection });
      setClipboardText(result.text);
    } catch (err) {
      setClipboardError(extractErrorMessage(err, "Unable to read clipboard."));
    } finally {
      setClipboardLoading(false);
    }
  }, [clipboardSelection, getClient]);
  const loadWindows = useCallback(async () => {
    setWindowsLoading(true);
    setWindowsError(null);
    try {
      const result = await getClient().listDesktopWindows();
      setWindows(result.windows);
    } catch (err) {
      setWindowsError(extractErrorMessage(err, "Unable to list windows."));
    } finally {
      setWindowsLoading(false);
    }
  }, [getClient]);
  const handleFocusWindow = async (windowId: string) => {
    setWindowActing(windowId);
    try {
      await getClient().focusDesktopWindow(windowId);
      await loadWindows();
    } catch (err) {
      setWindowsError(extractErrorMessage(err, "Unable to focus window."));
    } finally {
      setWindowActing(null);
    }
  };
  const handleMoveWindow = async (windowId: string) => {
    const x = Number.parseInt(editX, 10);
    const y = Number.parseInt(editY, 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    setWindowActing(windowId);
    try {
      await getClient().moveDesktopWindow(windowId, { x, y });
      setEditingWindow(null);
      await loadWindows();
    } catch (err) {
      setWindowsError(extractErrorMessage(err, "Unable to move window."));
    } finally {
      setWindowActing(null);
    }
  };
  const handleResizeWindow = async (windowId: string) => {
    const nextWidth = Number.parseInt(editW, 10);
    const nextHeight = Number.parseInt(editH, 10);
    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth <= 0 || nextHeight <= 0) return;
    setWindowActing(windowId);
    try {
      await getClient().resizeDesktopWindow(windowId, { width: nextWidth, height: nextHeight });
      setEditingWindow(null);
      await loadWindows();
    } catch (err) {
      setWindowsError(extractErrorMessage(err, "Unable to resize window."));
    } finally {
      setWindowActing(null);
    }
  };
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  // Auto-refresh status (and windows via status) every 5 seconds when active
  useEffect(() => {
    if (status?.state !== "active") return;
    const interval = setInterval(() => void loadStatus("refresh"), 5000);
    return () => clearInterval(interval);
  }, [status?.state, loadStatus]);
  useEffect(() => {
    if (status?.state === "active") {
      void loadRecordings();
    } else {
      revokeScreenshotUrl();
      setLiveViewActive(false);
      setMousePos(null);
      setEditingWindow(null);
    }
  }, [status?.state, loadRecordings, revokeScreenshotUrl]);
  useEffect(() => {
    return () => revokeScreenshotUrl();
  }, [revokeScreenshotUrl]);
  // Poll recording list while a recording is active
  useEffect(() => {
    if (!activeRecording) return;
    const interval = setInterval(() => void loadRecordings(), 3000);
    return () => clearInterval(interval);
  }, [activeRecording, loadRecordings]);
  useEffect(() => {
    if (status?.state !== "active") {
      setWindows([]);
      return;
    }
    // Initial load; subsequent updates come from the status auto-refresh.
    void loadWindows();
  }, [status?.state, loadWindows]);
  const handleStart = async () => {
    const parsedWidth = Number.parseInt(width, 10);
    const parsedHeight = Number.parseInt(height, 10);
    const parsedDpi = Number.parseInt(dpi, 10);
    const parsedFrameRate = Number.parseInt(streamFrameRate, 10);
    const parsedRecordingFps = Number.parseInt(defaultRecordingFps, 10);
    setActing("start");
    setError(null);
    const startedAt = Date.now();
    try {
      const request: DesktopStartRequestWithAdvanced = {
        width: Number.isFinite(parsedWidth) ? parsedWidth : undefined,
        height: Number.isFinite(parsedHeight) ? parsedHeight : undefined,
        dpi: Number.isFinite(parsedDpi) ? parsedDpi : undefined,
        streamVideoCodec: streamVideoCodec !== "vp8" ? streamVideoCodec : undefined,
        streamAudioCodec: streamAudioCodec !== "opus" ? streamAudioCodec : undefined,
        streamFrameRate: Number.isFinite(parsedFrameRate) && parsedFrameRate !== 30 ? parsedFrameRate : undefined,
        webrtcPortRange: webrtcPortRange !== "59050-59070" ? webrtcPortRange : undefined,
        recordingFps: Number.isFinite(parsedRecordingFps) && parsedRecordingFps !== 30 ? parsedRecordingFps : undefined,
      };
      const next = await getClient().startDesktop(request);
      setStatus(next);
    } catch (startError) {
      setError(extractErrorMessage(startError, "Unable to start desktop runtime."));
      await loadStatus("refresh");
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_SPIN_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS - elapsedMs));
      }
      setActing(null);
    }
  };
  const handleStop = async () => {
    setActing("stop");
    setError(null);
    const startedAt = Date.now();
    try {
      const next = await getClient().stopDesktop();
      setStatus(next);
      revokeScreenshotUrl();
      setLiveViewActive(false);
    } catch (stopError) {
      setError(extractErrorMessage(stopError, "Unable to stop desktop runtime."));
      await loadStatus("refresh");
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_SPIN_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS - elapsedMs));
      }
      setActing(null);
    }
  };
  const handleWriteClipboard = async () => {
    setClipboardWriting(true);
    setClipboardError(null);
    try {
      await getClient().setDesktopClipboard({ text: clipboardWriteText, selection: clipboardSelection });
      setClipboardText(clipboardWriteText);
    } catch (err) {
      setClipboardError(extractErrorMessage(err, "Unable to write clipboard."));
    } finally {
      setClipboardWriting(false);
    }
  };
  const handleStartRecording = async () => {
    const fps = Number.parseInt(recordingFps, 10);
    setRecordingActing("start");
    setRecordingError(null);
    try {
      await getClient().startDesktopRecording({
        fps: Number.isFinite(fps) && fps > 0 ? fps : undefined,
      });
      await loadRecordings();
    } catch (err) {
      setRecordingError(extractErrorMessage(err, "Unable to start recording."));
    } finally {
      setRecordingActing(null);
    }
  };
  const handleStopRecording = async () => {
    setRecordingActing("stop");
    setRecordingError(null);
    try {
      await getClient().stopDesktopRecording();
      await loadRecordings();
    } catch (err) {
      setRecordingError(extractErrorMessage(err, "Unable to stop recording."));
    } finally {
      setRecordingActing(null);
    }
  };
  const handleDeleteRecording = async (id: string) => {
    setDeletingRecordingId(id);
    try {
      await getClient().deleteDesktopRecording(id);
      setRecordings((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setRecordingError(extractErrorMessage(err, "Unable to delete recording."));
    } finally {
      setDeletingRecordingId(null);
    }
  };
  const handleDownloadRecording = async (id: string, fileName: string) => {
    setDownloadingRecordingId(id);
    try {
      const bytes = await getClient().downloadDesktopRecording(id);
      const blob = new Blob([bytes as BlobPart], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setRecordingError(extractErrorMessage(err, "Unable to download recording."));
    } finally {
      setDownloadingRecordingId(null);
    }
  };
  const handleLaunchApp = async () => {
    if (!launchApp.trim()) return;
    setLaunching(true);
    setLaunchError(null);
    setLaunchResult(null);
    try {
      const args = launchArgs.trim() ? launchArgs.trim().split(/\s+/) : undefined;
      const result = await getClient().launchDesktopApp({
        app: launchApp.trim(),
        args,
        wait: launchWait || undefined,
      });
      setLaunchResult(`Started ${result.processId}${result.windowId ? ` (window: ${result.windowId})` : ""}`);
      await loadWindows();
    } catch (err) {
      setLaunchError(extractErrorMessage(err, "Unable to launch app."));
    } finally {
      setLaunching(false);
    }
  };
  const handleOpenTarget = async () => {
    if (!openTarget.trim()) return;
    setOpening(true);
    setOpenError(null);
    setOpenResult(null);
    try {
      const result = await getClient().openDesktopTarget({ target: openTarget.trim() });
      setOpenResult(`Opened via ${result.processId}`);
      await loadWindows();
    } catch (err) {
      setOpenError(extractErrorMessage(err, "Unable to open target."));
    } finally {
      setOpening(false);
    }
  };
  const canRefreshScreenshot = status?.state === "active";
  const isActive = status?.state === "active";
  const resolutionLabel = useMemo(() => {
    const resolution = status?.resolution;
    if (!resolution) return "Unknown";
    const dpiLabel = resolution.dpi ? ` @ ${resolution.dpi} DPI` : "";
    return `${resolution.width} x ${resolution.height}${dpiLabel}`;
  }, [status?.resolution]);
  return (
    <div className="desktop-panel">
      <div className="inline-row" style={{ marginBottom: 16 }}>
        <button className="button secondary small" onClick={() => void loadStatus("refresh")} disabled={loading || refreshing}>
          <RefreshCw className={`button-icon ${loading || refreshing ? "spinner-icon" : ""}`} />
          Refresh Status
        </button>
        {isActive && !liveViewActive && (
          <button className="button secondary small" onClick={() => void refreshScreenshot()} disabled={!canRefreshScreenshot || screenshotLoading}>
            {screenshotLoading ? <Loader2 className="button-icon spinner-icon" /> : <Camera className="button-icon" />}
            Screenshot
          </button>
        )}
      </div>
      {isActive && !liveViewActive && (
        <div className="desktop-screenshot-controls">
          <div className="desktop-input-group">
            <label className="label">Format</label>
            <select
              className="setup-input mono"
              value={screenshotFormat}
              onChange={(event) => setScreenshotFormat(event.target.value as "png" | "jpeg" | "webp")}
            >
              <option value="png">PNG</option>
              <option value="jpeg">JPEG</option>
              <option value="webp">WebP</option>
            </select>
          </div>
          {screenshotFormat !== "png" && (
            <div className="desktop-input-group">
              <label className="label">Quality</label>
              <input
                className="setup-input mono"
                value={screenshotQuality}
                onChange={(event) => setScreenshotQuality(event.target.value)}
                inputMode="numeric"
                style={{ maxWidth: 60 }}
              />
            </div>
          )}
          <div className="desktop-input-group">
            <label className="label">Scale</label>
            <input
              className="setup-input mono"
              value={screenshotScale}
              onChange={(event) => setScreenshotScale(event.target.value)}
              inputMode="decimal"
              style={{ maxWidth: 60 }}
            />
          </div>
          <label className="desktop-checkbox-label">
            <input type="checkbox" checked={showCursor} onChange={(event) => setShowCursor(event.target.checked)} />
            Show cursor
          </label>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {screenshotError && <div className="banner error">{screenshotError}</div>}
      {/* ========== Runtime Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Monitor size={14} style={{ marginRight: 6 }} />
            Desktop Runtime
          </span>
          <span
            className={`pill ${
              status?.state === "active" ? "success" : status?.state === "install_required" ? "warning" : status?.state === "failed" ? "danger" : ""
            }`}
          >
            {status?.state ?? "unknown"}
          </span>
        </div>
        <div className="desktop-state-grid">
          <div>
            <div className="card-meta">Display</div>
            <div className="mono">{status?.display ?? "Not assigned"}</div>
          </div>
          <div>
            <div className="card-meta">Resolution</div>
            <div className="mono">{resolutionLabel}</div>
          </div>
          <div>
            <div className="card-meta">Started</div>
            <div>{formatStartedAt(status?.startedAt)}</div>
          </div>
        </div>
        <div className="desktop-start-controls">
          <div className="desktop-input-group">
            <label className="label">Width</label>
            <input className="setup-input mono" value={width} onChange={(event) => setWidth(event.target.value)} inputMode="numeric" />
          </div>
          <div className="desktop-input-group">
            <label className="label">Height</label>
            <input className="setup-input mono" value={height} onChange={(event) => setHeight(event.target.value)} inputMode="numeric" />
          </div>
          <div className="desktop-input-group">
            <label className="label">DPI</label>
            <input className="setup-input mono" value={dpi} onChange={(event) => setDpi(event.target.value)} inputMode="numeric" />
          </div>
        </div>
        <button
          className="button ghost small"
          onClick={() => setShowAdvancedStart((value) => !value)}
          style={{ marginTop: 8, fontSize: 11, padding: "4px 8px" }}
        >
          {showAdvancedStart ? "v Advanced" : "> Advanced"}
        </button>
        {showAdvancedStart && (
          <div className="desktop-advanced-grid">
            <div className="desktop-input-group">
              <label className="label">Video Codec</label>
              <select className="setup-input mono" value={streamVideoCodec} onChange={(event) => setStreamVideoCodec(event.target.value)} disabled={isActive}>
                <option value="vp8">vp8</option>
                <option value="vp9">vp9</option>
                <option value="h264">h264</option>
              </select>
            </div>
            <div className="desktop-input-group">
              <label className="label">Audio Codec</label>
              <select className="setup-input mono" value={streamAudioCodec} onChange={(event) => setStreamAudioCodec(event.target.value)} disabled={isActive}>
                <option value="opus">opus</option>
                <option value="g722">g722</option>
              </select>
            </div>
            <div className="desktop-input-group">
              <label className="label">Frame Rate</label>
              <input
                className="setup-input mono"
                value={streamFrameRate}
                onChange={(event) => setStreamFrameRate(event.target.value)}
                inputMode="numeric"
                disabled={isActive}
              />
            </div>
            <div className="desktop-input-group">
              <label className="label">WebRTC Ports</label>
              <input className="setup-input mono" value={webrtcPortRange} onChange={(event) => setWebrtcPortRange(event.target.value)} disabled={isActive} />
            </div>
            <div className="desktop-input-group">
              <label className="label">Recording FPS</label>
              <input
                className="setup-input mono"
                value={defaultRecordingFps}
                onChange={(event) => setDefaultRecordingFps(event.target.value)}
                inputMode="numeric"
                disabled={isActive}
              />
            </div>
          </div>
        )}
        <div className="card-actions">
          {isActive ? (
            <button className="button danger small" onClick={() => void handleStop()} disabled={acting === "stop"}>
              {acting === "stop" ? <Loader2 className="button-icon spinner-icon" /> : <Square className="button-icon" />}
              Stop Desktop
            </button>
          ) : (
            <button className="button success small" onClick={() => void handleStart()} disabled={acting === "start"}>
              {acting === "start" ? <Loader2 className="button-icon spinner-icon" /> : <Play className="button-icon" />}
              Start Desktop
            </button>
          )}
        </div>
      </div>
      {/* ========== Missing Dependencies ========== */}
      {status?.missingDependencies && status.missingDependencies.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Missing Dependencies</span>
          </div>
          <div className="desktop-chip-list">
            {status.missingDependencies.map((dependency) => (
              <span key={dependency} className="pill warning">
                {dependency}
              </span>
            ))}
          </div>
          {status.installCommand && (
            <>
              <div className="card-meta" style={{ marginTop: 12 }}>
                Install command
              </div>
              <div className="mono desktop-command">{status.installCommand}</div>
            </>
          )}
        </div>
      )}
      {/* ========== Live View Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Video size={14} style={{ marginRight: 6 }} />
            Live View
          </span>
          {isActive && (
            <button
              className={`button small ${liveViewActive ? "danger" : "success"}`}
              onClick={(e) => {
                e.stopPropagation();
                if (liveViewActive) {
                  // Stop: close viewer then stop the stream process
                  setLiveViewActive(false);
                  void getClient()
                    .stopDesktopStream()
                    .catch(() => undefined);
                } else {
                  // Start stream first, then show viewer
                  void getClient()
                    .startDesktopStream()
                    .then(() => {
                      setLiveViewActive(true);
                    })
                    .catch(() => undefined);
                }
              }}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {liveViewActive ? (
                <>
                  <Square size={12} style={{ marginRight: 4 }} />
                  Stop Stream
                </>
              ) : (
                <>
                  <Play size={12} style={{ marginRight: 4 }} />
                  Start Stream
                </>
              )}
            </button>
          )}
        </div>
        {liveViewError && (
          <div className="banner error" style={{ marginBottom: 8 }}>
            {liveViewError}
          </div>
        )}
        {!isActive && <div className="desktop-screenshot-empty">Start the desktop runtime to enable live view.</div>}
        {isActive && liveViewActive && (
          <>
            <div className="desktop-stream-hint">
              <span>Right click to open window</span>
              {status?.resolution && (
                <span className="mono" style={{ color: "var(--muted)" }}>
                  {status.resolution.width}x{status.resolution.height}
                </span>
              )}
            </div>
            <DesktopViewer
              client={viewerClient}
              height={360}
              showStatusBar={false}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "linear-gradient(180deg, rgba(15, 23, 42, 0.92) 0%, rgba(17, 24, 39, 0.98) 100%)",
                boxShadow: "none",
              }}
            />
          </>
        )}
        {isActive && !liveViewActive && (
          <>
            {screenshotUrl ? (
              <div className="desktop-screenshot-frame">
                <img src={screenshotUrl} alt="Desktop screenshot" className="desktop-screenshot-image" />
              </div>
            ) : (
              <div className="desktop-screenshot-empty">Click "Start Stream" for live desktop view, or use the Screenshot button above.</div>
            )}
          </>
        )}
        {isActive && (
          <div className="desktop-mouse-pos">
            <button
              className="button ghost small"
              onClick={() => void loadMousePosition()}
              disabled={mousePosLoading}
              style={{ padding: "4px 8px", fontSize: 11 }}
            >
              {mousePosLoading ? <Loader2 size={12} className="spinner-icon" /> : <MousePointer size={12} style={{ marginRight: 4 }} />}
              Position
            </button>
            {mousePos && (
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                ({mousePos.x}, {mousePos.y})
              </span>
            )}
          </div>
        )}
      </div>
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Clipboard size={14} style={{ marginRight: 6 }} />
              Clipboard
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select
                className="setup-input mono"
                value={clipboardSelection}
                onChange={(event) => setClipboardSelection(event.target.value as "clipboard" | "primary")}
                style={{ fontSize: 11, padding: "2px 6px", width: "auto" }}
              >
                <option value="clipboard">clipboard</option>
                <option value="primary">primary</option>
              </select>
              <button
                className="button secondary small"
                onClick={() => void loadClipboard()}
                disabled={clipboardLoading}
                style={{ padding: "4px 8px", fontSize: 11 }}
              >
                {clipboardLoading ? <Loader2 size={12} className="spinner-icon" /> : <RefreshCw size={12} />}
              </button>
            </div>
          </div>
          {clipboardError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {clipboardError}
            </div>
          )}
          <div className="desktop-clipboard-content">
            <div className="card-meta">Current contents</div>
            <pre className="desktop-clipboard-text">
              {clipboardText ? clipboardText : <span style={{ color: "var(--muted)", fontStyle: "italic" }}>(empty)</span>}
            </pre>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="card-meta">Write to clipboard</div>
            <textarea
              className="setup-input mono"
              value={clipboardWriteText}
              onChange={(event) => setClipboardWriteText(event.target.value)}
              rows={2}
              style={{ width: "100%", resize: "vertical", marginTop: 4 }}
              placeholder="Text to copy..."
            />
            <button className="button secondary small" onClick={() => void handleWriteClipboard()} disabled={clipboardWriting} style={{ marginTop: 6 }}>
              {clipboardWriting ? <Loader2 className="button-icon spinner-icon" /> : null}
              Update Clipboard
            </button>
          </div>
        </div>
      )}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <AppWindow size={14} style={{ marginRight: 6 }} />
              Windows
            </span>
            <button
              className="button secondary small"
              onClick={() => void loadWindows()}
              disabled={windowsLoading}
              style={{ padding: "4px 8px", fontSize: 11 }}
            >
              {windowsLoading ? <Loader2 size={12} className="spinner-icon" /> : <RefreshCw size={12} />}
            </button>
          </div>
          {windowsError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {windowsError}
            </div>
          )}
          {visibleWindows.length > 0 ? (
            <div className="desktop-process-list">
              {windows.length !== visibleWindows.length && (
                <div className="card-meta">
                  Showing {visibleWindows.length} top-level windows ({windows.length - visibleWindows.length} helper entries hidden)
                </div>
              )}
              {visibleWindows.map((win) => (
                <div key={win.id} className={`desktop-window-item ${win.isActive ? "desktop-window-focused" : ""}`}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ minWidth: 0 }}>
                      <strong style={{ fontSize: 12 }}>{win.title || "(untitled)"}</strong>
                      {win.isActive && (
                        <span className="pill success" style={{ marginLeft: 8 }}>
                          focused
                        </span>
                      )}
                      <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                        id: {win.id}
                        {" \u00b7 "}
                        {win.x},{win.y}
                        {" \u00b7 "}
                        {win.width}x{win.height}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button
                        className="button ghost small"
                        title="Focus"
                        onClick={() => void handleFocusWindow(win.id)}
                        disabled={windowActing === win.id}
                        style={{ padding: "4px 6px", fontSize: 10 }}
                      >
                        Focus
                      </button>
                      <button
                        className="button ghost small"
                        title="Move"
                        onClick={() => {
                          setEditingWindow({ id: win.id, action: "move" });
                          setEditX(String(win.x));
                          setEditY(String(win.y));
                        }}
                        style={{ padding: "4px 6px", fontSize: 10 }}
                      >
                        Move
                      </button>
                      <button
                        className="button ghost small"
                        title="Resize"
                        onClick={() => {
                          setEditingWindow({ id: win.id, action: "resize" });
                          setEditW(String(win.width));
                          setEditH(String(win.height));
                        }}
                        style={{ padding: "4px 6px", fontSize: 10 }}
                      >
                        Resize
                      </button>
                    </div>
                  </div>
                  {editingWindow?.id === win.id && editingWindow.action === "move" && (
                    <div className="desktop-window-editor">
                      <input
                        className="setup-input mono"
                        placeholder="x"
                        value={editX}
                        onChange={(event) => setEditX(event.target.value)}
                        style={{ width: 60 }}
                        inputMode="numeric"
                      />
                      <input
                        className="setup-input mono"
                        placeholder="y"
                        value={editY}
                        onChange={(event) => setEditY(event.target.value)}
                        style={{ width: 60 }}
                        inputMode="numeric"
                      />
                      <button
                        className="button success small"
                        onClick={() => void handleMoveWindow(win.id)}
                        disabled={windowActing === win.id}
                        style={{ padding: "4px 8px", fontSize: 10 }}
                      >
                        Apply
                      </button>
                      <button className="button ghost small" onClick={() => setEditingWindow(null)} style={{ padding: "4px 8px", fontSize: 10 }}>
                        Cancel
                      </button>
                    </div>
                  )}
                  {editingWindow?.id === win.id && editingWindow.action === "resize" && (
                    <div className="desktop-window-editor">
                      <input
                        className="setup-input mono"
                        placeholder="width"
                        value={editW}
                        onChange={(event) => setEditW(event.target.value)}
                        style={{ width: 60 }}
                        inputMode="numeric"
                      />
                      <input
                        className="setup-input mono"
                        placeholder="height"
                        value={editH}
                        onChange={(event) => setEditH(event.target.value)}
                        style={{ width: 60 }}
                        inputMode="numeric"
                      />
                      <button
                        className="button success small"
                        onClick={() => void handleResizeWindow(win.id)}
                        disabled={windowActing === win.id}
                        style={{ padding: "4px 8px", fontSize: 10 }}
                      >
                        Apply
                      </button>
                      <button className="button ghost small" onClick={() => setEditingWindow(null)} style={{ padding: "4px 8px", fontSize: 10 }}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="desktop-screenshot-empty">{windowsLoading ? "Loading..." : "No windows detected. Click refresh to update."}</div>
          )}
        </div>
      )}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <ExternalLink size={14} style={{ marginRight: 6 }} />
              Launch / Open
            </span>
          </div>
          <div className="card-meta">Launch application</div>
          <div className="desktop-launch-row">
            <input
              className="setup-input mono"
              placeholder="binary name (e.g. firefox)"
              value={launchApp}
              onChange={(event) => setLaunchApp(event.target.value)}
              style={{ flex: 1 }}
            />
            <input
              className="setup-input mono"
              placeholder="args (optional)"
              value={launchArgs}
              onChange={(event) => setLaunchArgs(event.target.value)}
              style={{ flex: 1 }}
            />
            <label className="desktop-checkbox-label">
              <input type="checkbox" checked={launchWait} onChange={(event) => setLaunchWait(event.target.checked)} />
              Wait
            </label>
            <button
              className="button success small"
              onClick={() => void handleLaunchApp()}
              disabled={launching || !launchApp.trim()}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {launching ? <Loader2 size={12} className="spinner-icon" /> : <Play size={12} style={{ marginRight: 4 }} />}
              Launch
            </button>
          </div>
          {launchError && (
            <div className="banner error" style={{ marginTop: 6 }}>
              {launchError}
            </div>
          )}
          {launchResult && (
            <div className="mono" style={{ fontSize: 11, color: "var(--success)", marginTop: 4 }}>
              {launchResult}
            </div>
          )}
          <div className="card-meta" style={{ marginTop: 14 }}>
            Open file or URL
          </div>
          <div className="desktop-launch-row">
            <input
              className="setup-input mono"
              placeholder="https://example.com or /path/to/file"
              value={openTarget}
              onChange={(event) => setOpenTarget(event.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="button success small"
              onClick={() => void handleOpenTarget()}
              disabled={opening || !openTarget.trim()}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {opening ? <Loader2 size={12} className="spinner-icon" /> : <ExternalLink size={12} style={{ marginRight: 4 }} />}
              Open
            </button>
          </div>
          {openError && (
            <div className="banner error" style={{ marginTop: 6 }}>
              {openError}
            </div>
          )}
          {openResult && (
            <div className="mono" style={{ fontSize: 11, color: "var(--success)", marginTop: 4 }}>
              {openResult}
            </div>
          )}
        </div>
      )}
      {/* ========== Recording Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Circle size={14} style={{ marginRight: 6, fill: activeRecording ? "#ff3b30" : "none" }} />
            Recording
          </span>
          {activeRecording && <span className="pill danger">Recording</span>}
        </div>
        {recordingError && (
          <div className="banner error" style={{ marginBottom: 8 }}>
            {recordingError}
          </div>
        )}
        {!isActive && <div className="desktop-screenshot-empty">Start the desktop runtime to enable recording.</div>}
        {isActive && (
          <>
            <div className="desktop-start-controls" style={{ gridTemplateColumns: "1fr" }}>
              <div className="desktop-input-group">
                <label className="label">FPS</label>
                <input
                  className="setup-input mono"
                  value={recordingFps}
                  onChange={(e) => setRecordingFps(e.target.value)}
                  inputMode="numeric"
                  style={{ maxWidth: 80 }}
                  disabled={!!activeRecording}
                />
              </div>
            </div>
            <div className="card-actions">
              {!activeRecording ? (
                <button className="button danger small" onClick={() => void handleStartRecording()} disabled={recordingActing === "start"}>
                  {recordingActing === "start" ? (
                    <Loader2 className="button-icon spinner-icon" />
                  ) : (
                    <Circle size={14} className="button-icon" style={{ fill: "#ff3b30" }} />
                  )}
                  Start Recording
                </button>
              ) : (
                <button className="button secondary small" onClick={() => void handleStopRecording()} disabled={recordingActing === "stop"}>
                  {recordingActing === "stop" ? <Loader2 className="button-icon spinner-icon" /> : <Square className="button-icon" />}
                  Stop Recording
                </button>
              )}
              <button className="button secondary small" onClick={() => void loadRecordings()} disabled={recordingLoading}>
                <RefreshCw className={`button-icon ${recordingLoading ? "spinner-icon" : ""}`} />
                Refresh
              </button>
            </div>
            {recordings.length > 0 && (
              <div className="desktop-process-list" style={{ marginTop: 12 }}>
                {recordings.map((rec) => (
                  <div key={rec.id} className="desktop-process-item">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div>
                        <strong className="mono" style={{ fontSize: 12 }}>
                          {rec.fileName}
                        </strong>
                        <span
                          className={`pill ${rec.status === "recording" ? "danger" : rec.status === "completed" ? "success" : "warning"}`}
                          style={{ marginLeft: 8 }}
                        >
                          {rec.status}
                        </span>
                      </div>
                      {rec.status === "completed" && (
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            className="button ghost small"
                            title="Download"
                            onClick={() => void handleDownloadRecording(rec.id, rec.fileName)}
                            disabled={downloadingRecordingId === rec.id}
                            style={{ padding: "4px 6px" }}
                          >
                            {downloadingRecordingId === rec.id ? <Loader2 size={14} className="spinner-icon" /> : <Download size={14} />}
                          </button>
                          <button
                            className="button ghost small"
                            title="Delete"
                            onClick={() => void handleDeleteRecording(rec.id)}
                            disabled={deletingRecordingId === rec.id}
                            style={{ padding: "4px 6px", color: "var(--danger)" }}
                          >
                            {deletingRecordingId === rec.id ? <Loader2 size={14} className="spinner-icon" /> : <Trash2 size={14} />}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                      {formatBytes(rec.bytes)}
                      {" \u00b7 "}
                      {formatDuration(rec.startedAt, rec.endedAt)}
                      {" \u00b7 "}
                      {formatStartedAt(rec.startedAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {recordings.length === 0 && !recordingLoading && (
              <div className="desktop-screenshot-empty" style={{ marginTop: 8 }}>
                No recordings yet. Click "Start Recording" to begin.
              </div>
            )}
          </>
        )}
      </div>
      {/* ========== Diagnostics Section ========== */}
      {(status?.lastError || status?.runtimeLogPath || (status?.processes?.length ?? 0) > 0) && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Diagnostics</span>
          </div>
          {status?.lastError && (
            <div className="desktop-diagnostic-block">
              <div className="card-meta">Last error</div>
              <div className="mono">{status.lastError.code}</div>
              <div>{status.lastError.message}</div>
            </div>
          )}
          {status?.runtimeLogPath && (
            <div className="desktop-diagnostic-block">
              <div className="card-meta">Runtime log</div>
              <div className="mono">{status.runtimeLogPath}</div>
            </div>
          )}
          {status?.processes && status.processes.length > 0 && (
            <div className="desktop-diagnostic-block">
              <div className="card-meta">Processes</div>
              <div className="desktop-process-list">
                {status.processes.map((process) => (
                  <div key={`${process.name}-${process.pid ?? "none"}`} className="desktop-process-item">
                    <div>
                      <strong>{process.name}</strong>
                      <span className={`pill ${process.running ? "success" : "danger"}`} style={{ marginLeft: 8 }}>
                        {process.running ? "running" : "stopped"}
                      </span>
                    </div>
                    <div className="mono">{process.pid ? `pid ${process.pid}` : "no pid"}</div>
                    {process.logPath && <div className="mono">{process.logPath}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
export default DesktopTab;
