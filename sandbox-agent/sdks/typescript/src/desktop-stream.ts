import type { DesktopMouseButton } from "./types.ts";

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSED = 3;

export interface DesktopStreamReadyStatus {
  type: "ready";
  width: number;
  height: number;
}

export interface DesktopStreamErrorStatus {
  type: "error";
  message: string;
}

export type DesktopStreamStatusMessage = DesktopStreamReadyStatus | DesktopStreamErrorStatus;

export interface DesktopStreamConnectOptions {
  accessToken?: string;
  WebSocket?: typeof WebSocket;
  protocols?: string | string[];
  RTCPeerConnection?: typeof RTCPeerConnection;
  rtcConfig?: RTCConfiguration;
}

/**
 * Neko data channel binary input protocol (Big Endian, v3).
 *
 * Reference implementation:
 *   https://github.com/demodesk/neko-client/blob/37f93eae6bd55b333c94bd009d7f2b079075a026/src/component/internal/webrtc.ts
 *
 * Server-side protocol:
 *   https://github.com/m1k1o/neko/blob/master/server/internal/webrtc/payload/receive.go
 *
 * Pinned to neko server image: m1k1o/neko:base@sha256:14e4012bc361025f71205ffc2a9342a628f39168c0a1d855db033fb18590fcae
 */
const NEKO_OP_MOVE = 0x01;
const NEKO_OP_SCROLL = 0x02;
const NEKO_OP_KEY_DOWN = 0x03;
const NEKO_OP_KEY_UP = 0x04;
const NEKO_OP_BTN_DOWN = 0x05;
const NEKO_OP_BTN_UP = 0x06;

function mouseButtonToX11(button?: DesktopMouseButton): number {
  switch (button) {
    case "middle":
      return 2;
    case "right":
      return 3;
    default:
      return 1;
  }
}

function keyToX11Keysym(key: string): number {
  if (key.length === 1) {
    const cp = key.charCodeAt(0);
    if (cp >= 0x20 && cp <= 0x7e) return cp;
    return 0x01000000 + cp;
  }

  const map: Record<string, number> = {
    Backspace: 0xff08,
    Tab: 0xff09,
    Return: 0xff0d,
    Enter: 0xff0d,
    Escape: 0xff1b,
    Delete: 0xffff,
    Home: 0xff50,
    Left: 0xff51,
    ArrowLeft: 0xff51,
    Up: 0xff52,
    ArrowUp: 0xff52,
    Right: 0xff53,
    ArrowRight: 0xff53,
    Down: 0xff54,
    ArrowDown: 0xff54,
    PageUp: 0xff55,
    PageDown: 0xff56,
    End: 0xff57,
    Insert: 0xff63,
    F1: 0xffbe,
    F2: 0xffbf,
    F3: 0xffc0,
    F4: 0xffc1,
    F5: 0xffc2,
    F6: 0xffc3,
    F7: 0xffc4,
    F8: 0xffc5,
    F9: 0xffc6,
    F10: 0xffc7,
    F11: 0xffc8,
    F12: 0xffc9,
    Shift: 0xffe1,
    ShiftLeft: 0xffe1,
    ShiftRight: 0xffe2,
    Control: 0xffe3,
    ControlLeft: 0xffe3,
    ControlRight: 0xffe4,
    Alt: 0xffe9,
    AltLeft: 0xffe9,
    AltRight: 0xffea,
    Meta: 0xffeb,
    MetaLeft: 0xffeb,
    MetaRight: 0xffec,
    CapsLock: 0xffe5,
    NumLock: 0xff7f,
    ScrollLock: 0xff14,
    " ": 0x0020,
    Space: 0x0020,
  };

  return map[key] ?? 0;
}

export class DesktopStreamSession {
  readonly socket: WebSocket;
  readonly closed: Promise<void>;

  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private mediaStream: MediaStream | null = null;
  private connected = false;
  private pendingCandidates: Record<string, unknown>[] = [];
  private cachedReadyStatus: DesktopStreamReadyStatus | null = null;

  private readonly readyListeners = new Set<(status: DesktopStreamReadyStatus) => void>();
  private readonly trackListeners = new Set<(stream: MediaStream) => void>();
  private readonly connectListeners = new Set<() => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: DesktopStreamErrorStatus | Error) => void>();

  private closedResolve!: () => void;
  private readonly PeerConnection: typeof RTCPeerConnection;
  private readonly rtcConfig: RTCConfiguration;

  constructor(socket: WebSocket, options: DesktopStreamConnectOptions = {}) {
    this.socket = socket;
    this.PeerConnection = options.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    this.rtcConfig = options.rtcConfig ?? {};

    this.closed = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data as string);
    });
    this.socket.addEventListener("error", () => {
      this.emitError(new Error("Desktop stream signaling connection failed."));
    });
    this.socket.addEventListener("close", () => {
      this.teardownPeerConnection();
      this.closedResolve();
      for (const listener of this.disconnectListeners) {
        listener();
      }
    });
  }

  onReady(listener: (status: DesktopStreamReadyStatus) => void): () => void {
    this.readyListeners.add(listener);
    // Deliver cached status to late listeners (handles race where system/init
    // arrives before onReady is called).
    if (this.cachedReadyStatus) {
      listener(this.cachedReadyStatus);
    }
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  onTrack(listener: (stream: MediaStream) => void): () => void {
    this.trackListeners.add(listener);
    if (this.mediaStream) {
      listener(this.mediaStream);
    }
    return () => {
      this.trackListeners.delete(listener);
    };
  }

  onConnect(listener: () => void): () => void {
    this.connectListeners.add(listener);
    return () => {
      this.connectListeners.delete(listener);
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  onError(listener: (error: DesktopStreamErrorStatus | Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** @deprecated Use onDisconnect instead. */
  onClose(listener: () => void): () => void {
    return this.onDisconnect(listener);
  }

  /** @deprecated No longer emits JPEG frames. Use onTrack for WebRTC media. */
  onFrame(_listener: (frame: Uint8Array) => void): () => void {
    return () => {};
  }

  getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }

  /** Build a neko data channel message with the 3-byte header (event + length). */
  private buildNekoMsg(event: number, payloadSize: number): { buf: ArrayBuffer; view: DataView } {
    const totalLen = 3 + payloadSize; // 1 byte event + 2 bytes length + payload
    const buf = new ArrayBuffer(totalLen);
    const view = new DataView(buf);
    view.setUint8(0, event);
    view.setUint16(1, payloadSize, false);
    return { buf, view };
  }

  moveMouse(x: number, y: number): void {
    // Move payload: X(uint16) + Y(uint16) = 4 bytes
    const { buf, view } = this.buildNekoMsg(NEKO_OP_MOVE, 4);
    view.setUint16(3, x, false);
    view.setUint16(5, y, false);
    this.sendDataChannel(buf);
  }

  mouseDown(button?: DesktopMouseButton, x?: number, y?: number): void {
    if (x != null && y != null) {
      this.moveMouse(x, y);
    }
    // Button payload: Key(uint32) = 4 bytes
    const { buf, view } = this.buildNekoMsg(NEKO_OP_BTN_DOWN, 4);
    view.setUint32(3, mouseButtonToX11(button), false);
    this.sendDataChannel(buf);
  }

  mouseUp(button?: DesktopMouseButton, x?: number, y?: number): void {
    if (x != null && y != null) {
      this.moveMouse(x, y);
    }
    const { buf, view } = this.buildNekoMsg(NEKO_OP_BTN_UP, 4);
    view.setUint32(3, mouseButtonToX11(button), false);
    this.sendDataChannel(buf);
  }

  scroll(x: number, y: number, deltaX?: number, deltaY?: number): void {
    this.moveMouse(x, y);
    // Scroll payload: DeltaX(int16) + DeltaY(int16) + ControlKey(uint8) = 5 bytes
    const { buf, view } = this.buildNekoMsg(NEKO_OP_SCROLL, 5);
    view.setInt16(3, deltaX ?? 0, false);
    view.setInt16(5, deltaY ?? 0, false);
    view.setUint8(7, 0); // controlKey = false
    this.sendDataChannel(buf);
  }

  keyDown(key: string): void {
    const keysym = keyToX11Keysym(key);
    if (keysym === 0) return;
    // Key payload: Key(uint32) = 4 bytes
    const { buf, view } = this.buildNekoMsg(NEKO_OP_KEY_DOWN, 4);
    view.setUint32(3, keysym, false);
    this.sendDataChannel(buf);
  }

  keyUp(key: string): void {
    const keysym = keyToX11Keysym(key);
    if (keysym === 0) return;
    const { buf, view } = this.buildNekoMsg(NEKO_OP_KEY_UP, 4);
    view.setUint32(3, keysym, false);
    this.sendDataChannel(buf);
  }

  close(): void {
    this.teardownPeerConnection();
    if (this.socket.readyState !== WS_READY_STATE_CLOSED) {
      this.socket.close();
    }
  }

  private handleMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    const event = (msg.event as string) ?? "";

    // Neko uses "payload" for message data, not "data".
    const payload = (msg.payload ?? msg.data) as Record<string, unknown> | undefined;

    switch (event) {
      case "system/init": {
        const screenData = payload?.screen_size as Record<string, unknown> | undefined;
        if (screenData) {
          const status: DesktopStreamReadyStatus = {
            type: "ready",
            width: Number(screenData.width) || 0,
            height: Number(screenData.height) || 0,
          };
          this.cachedReadyStatus = status;
          for (const listener of this.readyListeners) {
            listener(status);
          }
        }
        // Request control so this session can send input.
        this.sendSignaling("control/request", {});
        // Request WebRTC stream from neko. The server will respond with
        // signal/provide containing the SDP offer.
        this.sendSignaling("signal/request", { video: {}, audio: {} });
        break;
      }

      case "signal/provide":
      case "signal/offer": {
        if (payload?.sdp) {
          void this.handleNekoOffer(payload);
        }
        break;
      }

      case "signal/restart": {
        // Server-initiated renegotiation (treated as a new offer).
        // Ref: https://github.com/demodesk/neko-client/blob/37f93ea/src/component/internal/messages.ts#L190-L192
        if (payload?.sdp) {
          void this.handleNekoOffer(payload);
        }
        break;
      }

      case "signal/candidate": {
        if (payload) {
          void this.handleNekoCandidate(payload);
        }
        break;
      }

      case "signal/close": {
        // Server is closing the WebRTC connection.
        this.teardownPeerConnection();
        break;
      }

      case "system/disconnect": {
        const message = (payload as Record<string, unknown>)?.message as string | undefined;
        this.emitError(new Error(message ?? "Server disconnected."));
        this.close();
        break;
      }

      default:
        break;
    }
  }

  private async handleNekoOffer(data: Record<string, unknown>): Promise<void> {
    try {
      const iceServers: RTCIceServer[] = [];
      const nekoIce = (data.iceservers ?? data.ice) as Array<Record<string, unknown>> | undefined;
      if (nekoIce) {
        for (const server of nekoIce) {
          if (server.urls) {
            iceServers.push(server as unknown as RTCIceServer);
          }
        }
      }
      if (iceServers.length === 0) {
        iceServers.push({ urls: "stun:stun.l.google.com:19302" });
      }

      const config: RTCConfiguration = { ...this.rtcConfig, iceServers };
      const pc = new this.PeerConnection(config);
      this.pc = pc;

      pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.mediaStream = stream;
        for (const listener of this.trackListeners) {
          listener(stream);
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendSignaling("signal/candidate", event.candidate.toJSON());
        }
      };

      // Ref: https://github.com/demodesk/neko-client/blob/37f93ea/src/component/internal/webrtc.ts#L123-L173
      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case "connected":
            if (!this.connected) {
              this.connected = true;
              for (const listener of this.connectListeners) {
                listener();
              }
            }
            break;
          case "closed":
          case "failed":
            this.emitError(new Error(`WebRTC connection ${pc.connectionState}.`));
            break;
        }
      };

      pc.oniceconnectionstatechange = () => {
        switch (pc.iceConnectionState) {
          case "connected":
            if (!this.connected) {
              this.connected = true;
              for (const listener of this.connectListeners) {
                listener();
              }
            }
            break;
          case "closed":
          case "failed":
            this.emitError(new Error(`WebRTC ICE ${pc.iceConnectionState}.`));
            break;
        }
      };

      // Neko v3 creates data channels on the server side.
      // Ref: https://github.com/demodesk/neko-client/blob/37f93ea/src/component/internal/webrtc.ts#L477-L486
      pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.dataChannel.binaryType = "arraybuffer";
        this.dataChannel.onerror = () => {
          this.emitError(new Error("WebRTC data channel error."));
        };
        this.dataChannel.onclose = () => {
          this.dataChannel = null;
        };
      };

      const sdp = data.sdp as string;
      await pc.setRemoteDescription({ type: "offer", sdp });

      // Flush any ICE candidates that arrived before the PC was ready.
      for (const pending of this.pendingCandidates) {
        try {
          await pc.addIceCandidate(pending as unknown as RTCIceCandidateInit);
        } catch {
          // ignore stale candidates
        }
      }
      this.pendingCandidates = [];

      const answer = await pc.createAnswer();
      // Enable stereo audio for Chromium.
      // Ref: https://github.com/demodesk/neko-client/blob/37f93ea/src/component/internal/webrtc.ts#L262
      if (answer.sdp) {
        answer.sdp = answer.sdp.replace(/(stereo=1;)?useinbandfec=1/, "useinbandfec=1;stereo=1");
      }
      await pc.setLocalDescription(answer);

      this.sendSignaling("signal/answer", { sdp: answer.sdp });
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleNekoCandidate(data: Record<string, unknown>): Promise<void> {
    // Buffer candidates that arrive before the peer connection is created.
    if (!this.pc) {
      this.pendingCandidates.push(data);
      return;
    }
    try {
      const candidate = data as unknown as RTCIceCandidateInit;
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private sendSignaling(event: string, payload: unknown): void {
    if (this.socket.readyState !== WS_READY_STATE_OPEN) return;
    this.socket.send(JSON.stringify({ event, payload }));
  }

  private sendDataChannel(buf: ArrayBuffer): void {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(buf);
    }
  }

  /** Tear down the peer connection, nullifying handlers first to prevent stale
   *  callbacks. Matches the reference disconnect() pattern.
   *  Ref: https://github.com/demodesk/neko-client/blob/37f93ea/src/component/internal/webrtc.ts#L321-L363 */
  private teardownPeerConnection(): void {
    if (this.dataChannel) {
      this.dataChannel.onerror = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      try {
        this.dataChannel.close();
      } catch {
        /* ignore */
      }
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onicecandidateerror = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.onsignalingstatechange = null;
      this.pc.onnegotiationneeded = null;
      this.pc.ontrack = null;
      this.pc.ondatachannel = null;
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    this.mediaStream = null;
    this.connected = false;
  }

  private emitError(error: DesktopStreamErrorStatus | Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}
