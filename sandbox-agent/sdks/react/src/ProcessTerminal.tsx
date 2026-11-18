"use client";

import type { FitAddon as GhosttyFitAddon, Terminal as GhosttyTerminal } from "ghostty-web";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import type { SandboxAgent, TerminalErrorStatus, TerminalExitStatus, TerminalReadyStatus } from "sandbox-agent";

type ConnectionState = "connecting" | "ready" | "closed" | "error";

export type ProcessTerminalClient = Pick<SandboxAgent, "connectProcessTerminal">;

export interface ProcessTerminalProps {
  client: ProcessTerminalClient;
  processId: string;
  className?: string;
  style?: CSSProperties;
  terminalStyle?: CSSProperties;
  statusBarStyleOverride?: CSSProperties;
  height?: number | string;
  showStatusBar?: boolean;
  onExit?: (status: TerminalExitStatus) => void;
  onError?: (error: TerminalErrorStatus | Error) => void;
}

const terminalTheme = {
  background: "#09090b",
  foreground: "#f4f4f5",
  cursor: "#f97316",
  cursorAccent: "#09090b",
  selectionBackground: "#27272a",
  black: "#18181b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#f472b6",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#3f3f46",
  brightRed: "#fb7185",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#f9a8d4",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  borderRadius: 10,
  background: "rgba(0, 0, 0, 0.3)",
};

const statusBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 12px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
  background: "rgba(0, 0, 0, 0.2)",
  color: "rgba(244, 244, 245, 0.86)",
  fontSize: 11,
  lineHeight: 1.4,
};

const hostBaseStyle: CSSProperties = {
  minHeight: 320,
  padding: 10,
  overflow: "hidden",
};

const exitCodeStyle: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace",
  opacity: 0.72,
};

const getStatusColor = (state: ConnectionState): string => {
  switch (state) {
    case "ready":
      return "#4ade80";
    case "error":
      return "#fb7185";
    case "closed":
      return "#fbbf24";
    default:
      return "rgba(244, 244, 245, 0.72)";
  }
};

export const ProcessTerminal = ({
  client,
  processId,
  className,
  style,
  terminalStyle,
  statusBarStyleOverride,
  height = 360,
  showStatusBar = true,
  onExit,
  onError,
}: ProcessTerminalProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [statusMessage, setStatusMessage] = useState("Connecting to PTY...");
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let terminal: GhosttyTerminal | null = null;
    let fitAddon: GhosttyFitAddon | null = null;
    let session: ReturnType<ProcessTerminalClient["connectProcessTerminal"]> | null = null;
    let resizeRaf = 0;
    let removeDataListener: { dispose(): void } | null = null;
    let removeResizeListener: { dispose(): void } | null = null;

    setConnectionState("connecting");
    setStatusMessage("Connecting to PTY...");
    setExitCode(null);

    const syncSize = () => {
      if (!terminal || !session) {
        return;
      }

      session.resize({
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const connect = async () => {
      try {
        const ghostty = await import("ghostty-web");
        await ghostty.init();

        if (cancelled || !hostRef.current) {
          return;
        }

        terminal = new ghostty.Terminal({
          allowTransparency: true,
          cursorBlink: true,
          cursorStyle: "block",
          fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace",
          fontSize: 13,
          smoothScrollDuration: 90,
          theme: terminalTheme,
        });
        fitAddon = new ghostty.FitAddon();

        terminal.open(hostRef.current);
        const terminalRoot = hostRef.current.firstElementChild;
        if (terminalRoot instanceof HTMLElement) {
          terminalRoot.style.width = "100%";
          terminalRoot.style.height = "100%";
        }
        terminal.loadAddon(fitAddon);
        fitAddon.fit();
        fitAddon.observeResize();
        terminal.focus();

        removeDataListener = terminal.onData((data) => {
          session?.sendInput(data);
        });

        removeResizeListener = terminal.onResize(() => {
          if (resizeRaf) {
            window.cancelAnimationFrame(resizeRaf);
          }
          resizeRaf = window.requestAnimationFrame(syncSize);
        });

        const nextSession = client.connectProcessTerminal(processId);
        session = nextSession;

        nextSession.onReady((frame: TerminalReadyStatus) => {
          if (cancelled || frame.type !== "ready") {
            return;
          }

          setConnectionState("ready");
          setStatusMessage("Connected");
          syncSize();
        });

        nextSession.onData((bytes: Uint8Array) => {
          if (cancelled || !terminal) {
            return;
          }
          terminal.write(bytes);
        });

        nextSession.onExit((frame: TerminalExitStatus) => {
          if (cancelled || frame.type !== "exit") {
            return;
          }

          setConnectionState("closed");
          setExitCode(frame.exitCode ?? null);
          setStatusMessage(frame.exitCode == null ? "Process exited." : `Process exited with code ${frame.exitCode}.`);
          onExit?.(frame);
        });

        nextSession.onError((error: TerminalErrorStatus | Error) => {
          if (cancelled) {
            return;
          }

          setConnectionState("error");
          setStatusMessage(error instanceof Error ? error.message : error.message);
          onError?.(error);
        });

        nextSession.onClose(() => {
          if (cancelled) {
            return;
          }

          setConnectionState((current) => (current === "error" ? current : "closed"));
          setStatusMessage((current) => (current === "Connected" ? "Terminal disconnected." : current));
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        const nextError = error instanceof Error ? error : new Error("Failed to initialize terminal.");
        setConnectionState("error");
        setStatusMessage(nextError.message);
        onError?.(nextError);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (resizeRaf) {
        window.cancelAnimationFrame(resizeRaf);
      }
      removeDataListener?.dispose();
      removeResizeListener?.dispose();
      session?.close();
      terminal?.dispose();
    };
  }, [client, onError, onExit, processId]);

  return (
    <div className={className} style={{ ...shellStyle, ...style }}>
      {showStatusBar ? (
        <div style={{ ...statusBarStyle, ...statusBarStyleOverride }}>
          <span style={{ color: getStatusColor(connectionState) }}>{statusMessage}</span>
          {exitCode != null ? <span style={exitCodeStyle}>exit={exitCode}</span> : null}
        </div>
      ) : null}
      <div
        ref={hostRef}
        role="presentation"
        style={{
          ...hostBaseStyle,
          height,
          ...terminalStyle,
        }}
        onClick={() => {
          hostRef.current?.querySelector("textarea")?.focus();
        }}
      />
    </div>
  );
};
