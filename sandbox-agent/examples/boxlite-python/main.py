"""
Sandbox Agent – Python + BoxLite example.

Builds a Docker image, exports it to OCI layout, runs it inside a BoxLite
sandbox, connects to the sandbox-agent server, creates a session, and sends a prompt.

Usage:
    pip install -r requirements.txt
    python main.py
"""

import asyncio
import json
import signal
import time

import boxlite
import httpx

from client import SandboxConnection
from credentials import build_box_env, detect_agent
from setup_image import OCI_DIR, setup_image

PORT = 3000


def wait_for_health(base_url: str, timeout_s: float = 120) -> None:
    deadline = time.monotonic() + timeout_s
    last_err: str | None = None
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{base_url}/v1/health", timeout=5)
            if r.status_code == 200 and r.json().get("status") == "ok":
                return
            last_err = f"health returned {r.status_code}"
        except Exception as exc:
            last_err = str(exc)
        time.sleep(0.5)
    raise RuntimeError(f"Timed out waiting for /v1/health: {last_err}")


async def main() -> None:
    agent = detect_agent()
    print(f"Agent: {agent}")

    setup_image()

    env = build_box_env()

    print("Creating BoxLite sandbox...")
    box = boxlite.SimpleBox(
        rootfs_path=OCI_DIR,
        env=env,
        ports=[(PORT, PORT, "tcp")],
    )

    async with box:
        print("Starting server...")
        result = await box.exec(
            "sh", "-c",
            f"nohup sandbox-agent server --no-token --host 0.0.0.0 --port {PORT} "
            ">/tmp/sandbox-agent.log 2>&1 &",
        )
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to start server: {result.stderr}")

        base_url = f"http://localhost:{PORT}"
        print("Waiting for server...")
        wait_for_health(base_url)
        print("Server ready.")
        print(f"Inspector: {base_url}/ui/")

        # -- Session flow ----------------------------------------------------
        conn = SandboxConnection(base_url, agent)

        print("Connecting...")
        init_result = conn.initialize()
        agent_info = init_result.get("result", {}).get("agentInfo", {})
        print(f"Connected to: {agent_info.get('title', agent)} {agent_info.get('version', '')}")

        session_id = conn.new_session()
        print(f"Session: {session_id}")

        prompt_text = "Say hello and tell me what you are. Be brief (one sentence)."
        print(f"\n> {prompt_text}")
        response = conn.prompt(session_id, prompt_text)

        if "error" in response:
            err = response["error"]
            print(f"Error: {err.get('message', err)}")
        else:
            print(f"Stop reason: {response.get('result', {}).get('stopReason', 'unknown')}")

        # Give SSE events a moment to arrive.
        time.sleep(1)

        if conn.events:
            for ev in conn.events:
                if ev.get("method") == "session/update":
                    content = ev.get("params", {}).get("update", {}).get("content", {})
                    if content.get("text"):
                        print(content["text"], end="")
            print()

        conn.close()
        print("\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
