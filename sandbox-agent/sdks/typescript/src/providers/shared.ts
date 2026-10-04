export const SANDBOX_AGENT_VERSION = "0.5.0-rc.2";
export const DEFAULT_SANDBOX_AGENT_IMAGE = `rivetdev/sandbox-agent:${SANDBOX_AGENT_VERSION}-full`;
export const SANDBOX_AGENT_INSTALL_SCRIPT = `https://releases.rivet.dev/sandbox-agent/${SANDBOX_AGENT_VERSION}/install.sh`;
export const SANDBOX_AGENT_NPX_SPEC = `@sandbox-agent/cli@${SANDBOX_AGENT_VERSION}`;
export const DEFAULT_AGENTS = ["claude", "codex"] as const;

export function buildServerStartCommand(port: number): string {
  return `nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${port} >/tmp/sandbox-agent.log 2>&1 &`;
}
