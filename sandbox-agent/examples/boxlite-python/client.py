"""Minimal JSON-RPC client for sandbox-agent's streamable HTTP transport."""

import json
import threading
import time
import uuid

import httpx


class SandboxConnection:
    """Connects to a sandbox-agent server via JSON-RPC over streamable HTTP.

    Endpoints used:
        POST /v1/acp/{server_id}?agent=...  (bootstrap + requests)
        GET  /v1/acp/{server_id}            (SSE event stream)
        DELETE /v1/acp/{server_id}          (close)
    """

    def __init__(self, base_url: str, agent: str):
        self.base_url = base_url.rstrip("/")
        self.agent = agent
        self.server_id = f"py-{uuid.uuid4().hex[:8]}"
        self.url = f"{self.base_url}/v1/acp/{self.server_id}"
        self._next_id = 0
        self._events: list[dict] = []
        self._stop = threading.Event()
        self._sse_thread: threading.Thread | None = None

    def _alloc_id(self) -> int:
        self._next_id += 1
        return self._next_id

    def _post(self, method: str, params: dict | None = None, *, bootstrap: bool = False) -> dict:
        payload: dict = {
            "jsonrpc": "2.0",
            "id": self._alloc_id(),
            "method": method,
        }
        if params is not None:
            payload["params"] = params

        url = f"{self.url}?agent={self.agent}" if bootstrap else self.url
        r = httpx.post(url, json=payload, timeout=120)
        r.raise_for_status()
        body = r.text.strip()
        return json.loads(body) if body else {}

    # -- Lifecycle -----------------------------------------------------------

    def initialize(self) -> dict:
        result = self._post(
            "initialize",
            {
                "protocolVersion": 1,
                "clientInfo": {"name": "python-example", "version": "0.1.0"},
            },
            bootstrap=True,
        )
        self._start_sse()

        # Auto-authenticate if the agent advertises env-var-based auth methods.
        auth_methods = result.get("result", {}).get("authMethods", [])
        env_ids = ("anthropic-api-key", "codex-api-key", "openai-api-key")
        for method in auth_methods:
            if method.get("id") not in env_ids:
                continue
            try:
                resp = self._post("authenticate", {"methodId": method["id"]})
                if "error" not in resp:
                    break
            except Exception:
                continue

        return result

    def new_session(self, cwd: str = "/root") -> str:
        result = self._post("session/new", {"cwd": cwd, "mcpServers": []})
        if "error" in result:
            raise RuntimeError(f"session/new failed: {result['error'].get('message', result['error'])}")
        return result["result"]["sessionId"]

    def prompt(self, session_id: str, text: str) -> dict:
        result = self._post(
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}],
            },
        )
        return result

    def close(self) -> None:
        self._stop.set()
        try:
            httpx.delete(self.url, timeout=2)
        except Exception:
            pass

    # -- SSE event stream (background thread) --------------------------------

    @property
    def events(self) -> list[dict]:
        return list(self._events)

    def _start_sse(self) -> None:
        self._sse_thread = threading.Thread(target=self._sse_loop, daemon=True)
        self._sse_thread.start()

    def _sse_loop(self) -> None:
        while not self._stop.is_set():
            try:
                with httpx.stream(
                    "GET",
                    self.url,
                    headers={"Accept": "text/event-stream"},
                    timeout=httpx.Timeout(connect=5, read=None, write=5, pool=5),
                ) as resp:
                    buffer = ""
                    for chunk in resp.iter_text():
                        if self._stop.is_set():
                            break
                        buffer += chunk.replace("\r\n", "\n")
                        while "\n\n" in buffer:
                            event_chunk, buffer = buffer.split("\n\n", 1)
                            self._process_sse_event(event_chunk)
            except Exception:
                if self._stop.is_set():
                    return
                time.sleep(0.15)

    def _process_sse_event(self, chunk: str) -> None:
        data_lines: list[str] = []
        for line in chunk.split("\n"):
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if not data_lines:
            return
        payload = "\n".join(data_lines).strip()
        if not payload:
            return
        try:
            self._events.append(json.loads(payload))
        except json.JSONDecodeError:
            pass
