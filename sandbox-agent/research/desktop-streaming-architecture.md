# Desktop Streaming Architecture

## Decision: neko over GStreamer (direct) and VNC

We evaluated three approaches for streaming the virtual desktop to browser clients:

1. **VNC (noVNC/websockify)** - traditional remote desktop
2. **GStreamer WebRTC (direct)** - custom GStreamer pipeline in the sandbox agent process
3. **neko** - standalone WebRTC streaming server with its own GStreamer pipeline

We chose **neko**.

## Approach comparison

### VNC (noVNC)

- Uses RFB protocol, not WebRTC. Relies on pixel-diff framebuffer updates over WebSocket.
- Higher latency than WebRTC (no hardware-accelerated codec, no adaptive bitrate).
- Requires a VNC server (x11vnc or similar) plus websockify for browser access.
- Input handling is mature but tied to the RFB protocol.
- No audio support without additional plumbing.

**Rejected because:** Latency is noticeably worse than WebRTC-based approaches. The pixel-diff approach doesn't scale well at higher resolutions or frame rates. No native audio path.

### GStreamer WebRTC (direct)

- Custom pipeline: `ximagesrc -> videoconvert -> vp8enc -> rtpvp8pay -> webrtcbin`.
- Runs inside the sandbox agent Rust process using `gstreamer-rs` bindings.
- Requires feature-gating (`desktop-gstreamer` Cargo feature) and linking GStreamer at compile time.
- ICE candidate handling is complex: Docker-internal IPs (172.17.x.x) must be rewritten to 127.0.0.1 for host browser connectivity.
- UDP port range must be constrained via libnice NiceAgent properties to stay within Docker-forwarded ports.
- Input must be implemented separately (xdotool or custom X11 input injection).
- No built-in session management, authentication, or multi-client support.

**Rejected because:** Too much complexity for the sandbox agent to own directly. ICE/NAT traversal bugs are hard to debug. The GStreamer Rust bindings add significant compile-time dependencies. Input handling requires a separate implementation. We built and tested this approach (branch `desktop-computer-use`, PR #226) and found:
- Black screen issues due to GStreamer pipeline negotiation failures
- ICE candidate rewriting fragility across Docker networking modes
- libnice port range configuration requires accessing internal NiceAgent properties that vary across GStreamer versions
- No data channel for low-latency input (had to fall back to WebSocket-based input which adds a round trip)

### neko (chosen)

- Standalone Go binary extracted from `ghcr.io/m1k1o/neko/base`.
- Has its own GStreamer pipeline internally (same `ximagesrc -> vp8enc -> webrtcbin` approach, but battle-tested).
- Provides WebSocket signaling, WebRTC media, and a binary data channel for input, all out of the box.
- Input via data channel is low-latency (sub-frame, no HTTP round trip). Uses X11 XTEST extension.
- Multi-session support with `noauth` provider (each browser tab gets its own session).
- ICE-lite mode with `--webrtc.nat1to1 127.0.0.1` eliminates NAT traversal issues for Docker-to-host.
- EPR (ephemeral port range) flag constrains UDP ports cleanly.
- Sandbox agent acts as a thin WebSocket proxy: browser WS connects to sandbox agent, which creates a per-connection neko login session and relays signaling messages bidirectionally.
- Audio codec support (opus) included for free.

**Chosen because:** Neko encapsulates all the hard WebRTC/GStreamer/input complexity into a single binary. The sandbox agent only needs to:
1. Manage the neko process lifecycle (start/stop via the process runtime)
2. Proxy WebSocket signaling (bidirectional relay, ~60 lines of code)
3. Handle neko session creation (HTTP login to get a session cookie)

This keeps the sandbox agent's desktop streaming code simple (~300 lines for the manager, ~120 lines for the WS proxy) while delivering production-quality WebRTC streaming with data channel input.

## Architecture

```
Browser                    Sandbox Agent              neko (internal)
  |                            |                          |
  |-- WS /stream/signaling --> |-- WS ws://127.0.0.1:18100/api/ws -->|
  |                            |   (bidirectional relay)  |
  |<-- neko signaling ---------|<-- neko signaling -------|
  |                            |                          |
  |<========= WebRTC (UDP 59000-59100) ==================>|
  |   VP8 video, Opus audio, binary data channel          |
  |                                                       |
  |-- data channel input (mouse/keyboard) --------------->|
  |   (binary protocol: opcode + payload, big-endian)     |
```

Key points:
- neko listens on internal port 18100 (not exposed externally).
- UDP ports 59000-59100 are forwarded through Docker for WebRTC media.
- `--webrtc.icelite` + `--webrtc.nat1to1 127.0.0.1` means neko advertises 127.0.0.1 as its ICE candidate, so the browser connects to localhost UDP ports directly.
- `--desktop.input.enabled=false` disables neko's custom xf86-input driver (not available outside neko's official Docker images). Input falls back to XTEST.
- Each WebSocket proxy connection creates a fresh neko login session with a unique username to avoid session conflicts when multiple clients connect.

## Trade-offs

| Concern | neko | GStreamer direct |
|---------|------|-----------------|
| Binary size | ~30MB additional binary | ~0 (uses system GStreamer libs) |
| Compile-time deps | None (external binary) | gstreamer-rs crate + GStreamer dev libs |
| Input latency | Sub-frame (data channel) | WebSocket round trip |
| ICE/NAT complexity | Handled by neko flags | Must implement in Rust |
| Multi-client | Built-in session management | Must implement |
| Maintenance | Upstream neko updates | Own all the code |
| Audio | Built-in (opus) | Must add audio pipeline |

The main trade-off is the additional ~30MB binary size from neko. This is acceptable for the Docker-based deployment model where image size is less critical than reliability and development velocity.

## References

- neko v3: https://github.com/m1k1o/neko
- neko client reference: https://github.com/demodesk/neko-client
- neko data channel protocol: https://github.com/m1k1o/neko/blob/master/server/internal/webrtc/payload/receive.go
- GStreamer branch (closed): PR #226, branch `desktop-computer-use`
- Image digest: `ghcr.io/m1k1o/neko/base@sha256:0c384afa56268aaa2d5570211d284763d0840dcdd1a7d9a24be3081d94d3dfce`
