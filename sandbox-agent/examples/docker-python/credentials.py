"""Agent detection and credential helpers for sandbox-agent examples."""

import os
import sys


def detect_agent() -> str:
    """Pick an agent based on env vars. Exits if no credentials are found."""
    if os.environ.get("SANDBOX_AGENT"):
        return os.environ["SANDBOX_AGENT"]
    has_claude = bool(
        os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("CLAUDE_API_KEY")
        or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    )
    has_codex = (os.environ.get("OPENAI_API_KEY") or "").startswith("sk-")
    if has_codex:
        return "codex"
    if has_claude:
        return "claude"
    print("No API keys found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.")
    sys.exit(1)


def build_container_env() -> dict[str, str]:
    """Collect credential env vars to forward into the Docker container."""
    env: dict[str, str] = {}
    for key in ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"):
        val = os.environ.get(key)
        if val:
            env[key] = val
    return env
