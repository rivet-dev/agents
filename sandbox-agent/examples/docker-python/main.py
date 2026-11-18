"""
Sandbox Agent – Python + Docker example.

Starts a Docker container running sandbox-agent, connects to the sandbox-agent server, creates a session, sends a prompt, and
prints the streamed response.

Usage:
    pip install -r requirements.txt
    python main.py
"""

import json
import os
import signal
import subprocess
import sys
import time

import docker
import httpx

from client import SandboxConnection
from credentials import build_container_env, detect_agent

PORT = 3000
DOCKERFILE_DIR = os.path.join(os.path.dirname(__file__), "..", "shared")
IMAGE_NAME = "sandbox-agent-examples:latest"


def build_image(client: docker.DockerClient) -> str:
    """Build the shared example Docker image if it doesn't exist."""
    try:
        client.images.get(IMAGE_NAME)
        return IMAGE_NAME
    except docker.errors.ImageNotFound:
        pass

    print(f"Building {IMAGE_NAME} (first run only)...")
    subprocess.run(
        ["docker", "build", "-t", IMAGE_NAME, DOCKERFILE_DIR],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    return IMAGE_NAME


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


def main() -> None:
    agent = detect_agent()
    print(f"Agent: {agent}")

    client = docker.from_env()
    image = build_image(client)

    env = build_container_env()

    print("Starting container...")
    container = client.containers.run(
        image,
        command=[
            "sh", "-c",
            f"sandbox-agent install-agent {agent} && "
            f"sandbox-agent server --no-token --host 0.0.0.0 --port {PORT}",
        ],
        environment=env,
        ports={f"{PORT}/tcp": PORT},
        detach=True,
        auto_remove=True,
    )

    def cleanup(*_args: object) -> None:
        print("\nCleaning up...")
        try:
            container.stop(timeout=5)
        except Exception:
            pass

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    try:
        base_url = f"http://127.0.0.1:{PORT}"
        print(f"Waiting for server at {base_url}...")
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

    finally:
        cleanup()


if __name__ == "__main__":
    main()
