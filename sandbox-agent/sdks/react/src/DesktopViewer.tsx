"use client";

import type { CSSProperties, MouseEvent, WheelEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { DesktopMouseButton, DesktopStreamErrorStatus, DesktopStreamReadyStatus, SandboxAgent } from "sandbox-agent";

type ConnectionState = "connecting" | "ready" | "closed" | "error";

export type DesktopViewerClient = Pick<SandboxAgent, "connectDesktopStream">;

export interface DesktopViewerProps {
  client: DesktopViewerClient;
  className?: string;
  style?: CSSProperties;
  imageStyle?: CSSProperties;
  height?: number | string;
  showStatusBar?: boolean;
  onConnect?: (status: DesktopStreamReadyStatus) => void;
  onDisconnect?: () => void;
  onError?: (error: DesktopStreamErrorStatus | Error) => void;
}

const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  border: "1px solid rgba(15, 23, 42, 0.14)",
  borderRadius: 14,
  background: "linear-gradient(180deg, rgba(248, 250, 252, 0.96) 0%, rgba(226, 232, 240, 0.92) 100%)",
  boxShadow: "0 20px 40px rgba(15, 23, 42, 0.08)",
};

const statusBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 14px",
  borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
  background: "rgba(255, 255, 255, 0.78)",
  color: "#0f172a",
  fontSize: 12,
  lineHeight: 1.4,
};

const viewportStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  background: "radial-gradient(circle at top, rgba(14, 165, 233, 0.18), transparent 45%), linear-gradient(180deg, #0f172a 0%, #111827 100%)",
};

const videoBaseStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "contain",
  userSelect: "none",
};

const hintStyle: CSSProperties = {
  opacity: 0.66,
};

const getStatusColor = (state: ConnectionState): string => {
  switch (state) {
    case "ready":
      return "#15803d";
    case "error":
      return "#b91c1c";
    case "closed":
      return "#b45309";
    default:
      return "#475569";
  }
};

export const DesktopViewer = ({
  client,
  className,
  style,
  imageStyle,
  height = 480,
  showStatusBar = true,
  onConnect,
  onDisconnect,
  onError,
}: DesktopViewerProps) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<ReturnType<DesktopViewerClient["connectDesktopStream"]> | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [statusMessage, setStatusMessage] = useState("Starting desktop stream...");
  const [hasVideo, setHasVideo] = useState(false);
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    setConnectionState("connecting");
    setStatusMessage("Connecting to desktop stream...");
    setResolution(null);
    setHasVideo(false);

    const session = client.connectDesktopStream();
    sessionRef.current = session;

    session.onReady((status) => {
      if (cancelled) return;
      setConnectionState("ready");
      setStatusMessage("Desktop stream connected.");
      setResolution({ width: status.width, height: status.height });
      onConnect?.(status);
    });
    session.onTrack((stream) => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        void video.play().catch(() => undefined);
        setHasVideo(true);
      }
    });
    session.onError((error) => {
      if (cancelled) return;
      setConnectionState("error");
      setStatusMessage(error instanceof Error ? error.message : error.message);
      onError?.(error);
    });
    session.onDisconnect(() => {
      if (cancelled) return;
      setConnectionState((current) => (current === "error" ? current : "closed"));
      setStatusMessage((current) => (current === "Desktop stream connected." ? "Desktop stream disconnected." : current));
      onDisconnect?.();
    });

    return () => {
      cancelled = true;
      session.close();
      sessionRef.current = null;
      const video = videoRef.current;
      if (video) {
        video.srcObject = null;
      }
      setHasVideo(false);
    };
  }, [client, onConnect, onDisconnect, onError]);

  const scalePoint = (clientX: number, clientY: number) => {
    const video = videoRef.current;
    if (!video || !resolution) {
      return null;
    }
    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    // The video uses objectFit: "contain", so we need to compute the actual
    // rendered content area within the <video> element to map coordinates
    // accurately (ignoring letterbox bars).
    const videoAspect = resolution.width / resolution.height;
    const elemAspect = rect.width / rect.height;
    let renderW: number;
    let renderH: number;
    if (elemAspect > videoAspect) {
      // Pillarboxed (black bars on left/right)
      renderH = rect.height;
      renderW = rect.height * videoAspect;
    } else {
      // Letterboxed (black bars on top/bottom)
      renderW = rect.width;
      renderH = rect.width / videoAspect;
    }
    const offsetX = (rect.width - renderW) / 2;
    const offsetY = (rect.height - renderH) / 2;
    const relX = clientX - rect.left - offsetX;
    const relY = clientY - rect.top - offsetY;
    const x = Math.max(0, Math.min(resolution.width, (relX / renderW) * resolution.width));
    const y = Math.max(0, Math.min(resolution.height, (relY / renderH) * resolution.height));
    return {
      x: Math.round(x),
      y: Math.round(y),
    };
  };

  const buttonFromMouseEvent = (event: MouseEvent<HTMLDivElement>): DesktopMouseButton => {
    switch (event.button) {
      case 1:
        return "middle";
      case 2:
        return "right";
      default:
        return "left";
    }
  };

  const withSession = (callback: (session: NonNullable<ReturnType<DesktopViewerClient["connectDesktopStream"]>>) => void) => {
    const session = sessionRef.current;
    if (session) {
      callback(session);
    }
  };

  return (
    <div className={className} style={{ ...shellStyle, ...style }}>
      {showStatusBar ? (
        <div style={statusBarStyle}>
          <span style={{ color: getStatusColor(connectionState) }}>{statusMessage}</span>
          <span style={hintStyle}>{resolution ? `${resolution.width}×${resolution.height}` : "Awaiting stream"}</span>
        </div>
      ) : null}
      <div
        ref={wrapperRef}
        role="button"
        tabIndex={0}
        style={{ ...viewportStyle, height }}
        onMouseMove={(event) => {
          const point = scalePoint(event.clientX, event.clientY);
          if (!point) {
            return;
          }
          withSession((session) => session.moveMouse(point.x, point.y));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          // preventDefault on mousedown suppresses the default focus behavior,
          // so we must explicitly focus the wrapper to receive keyboard events.
          wrapperRef.current?.focus();
          const point = scalePoint(event.clientX, event.clientY);
          withSession((session) => session.mouseDown(buttonFromMouseEvent(event), point?.x, point?.y));
        }}
        onMouseUp={(event) => {
          const point = scalePoint(event.clientX, event.clientY);
          withSession((session) => session.mouseUp(buttonFromMouseEvent(event), point?.x, point?.y));
        }}
        onWheel={(event: WheelEvent<HTMLDivElement>) => {
          event.preventDefault();
          const point = scalePoint(event.clientX, event.clientY);
          if (!point) {
            return;
          }
          withSession((session) => session.scroll(point.x, point.y, Math.round(event.deltaX), Math.round(event.deltaY)));
        }}
        onKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          withSession((session) => session.keyDown(event.key));
        }}
        onKeyUp={(event) => {
          event.preventDefault();
          event.stopPropagation();
          withSession((session) => session.keyUp(event.key));
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          tabIndex={-1}
          draggable={false}
          style={{ ...videoBaseStyle, ...imageStyle, display: hasVideo ? "block" : "none", pointerEvents: "none" }}
        />
      </div>
    </div>
  );
};
