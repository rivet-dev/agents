import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function candidateInstallDirs(dataHome: string): string[] {
  const dirs = [join(dataHome, "sandbox-agent", "bin")];
  if (process.platform === "darwin") {
    dirs.push(join(dataHome, "Library", "Application Support", "sandbox-agent", "bin"));
  } else if (process.platform === "win32") {
    dirs.push(join(dataHome, "AppData", "Roaming", "sandbox-agent", "bin"));
  }
  return dirs;
}

export function prepareMockAgentDataHome(dataHome: string): Record<string, string> {
  const runtimeEnv: Record<string, string> = {};
  if (process.platform === "darwin") {
    runtimeEnv.HOME = dataHome;
    runtimeEnv.XDG_DATA_HOME = join(dataHome, ".local", "share");
  } else if (process.platform === "win32") {
    runtimeEnv.USERPROFILE = dataHome;
    runtimeEnv.APPDATA = join(dataHome, "AppData", "Roaming");
    runtimeEnv.LOCALAPPDATA = join(dataHome, "AppData", "Local");
  } else {
    runtimeEnv.HOME = dataHome;
    runtimeEnv.XDG_DATA_HOME = dataHome;
  }

  const nodeScript = String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");

let nextSession = 0;
let nextPermission = 0;
const pendingPermissions = new Map();

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function firstText(prompt) {
  if (!Array.isArray(prompt)) {
    return "";
  }

  for (const block of prompt) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }

  return "";
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const hasMethod = typeof msg?.method === "string";
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  const method = hasMethod ? msg.method : undefined;

  if (!hasMethod && hasId) {
    const pending = pendingPermissions.get(String(msg.id));
    if (pending) {
      pendingPermissions.delete(String(msg.id));
      const outcome = msg?.result?.outcome;
      const optionId = outcome?.outcome === "selected" ? outcome.optionId : "cancelled";
      const suffix = optionId === "reject-once" ? "rejected" : "approved";
      emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: pending.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "mock permission " + suffix + ": " + optionId,
            },
          },
        },
      });
      emit({
        jsonrpc: "2.0",
        id: pending.promptId,
        result: {
          stopReason: "end_turn",
        },
      });
    }
    return;
  }

  if (method === "session/prompt") {
    const sessionId = typeof msg?.params?.sessionId === "string" ? msg.params.sessionId : "";
    const text = firstText(msg?.params?.prompt);
    emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "mock: " + text,
          },
        },
      },
    });

    if (text.includes("permission")) {
      nextPermission += 1;
      const permissionId = "permission-" + nextPermission;
      pendingPermissions.set(permissionId, {
        promptId: msg.id,
        sessionId,
      });
      emit({
        jsonrpc: "2.0",
        id: permissionId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "tool-call-" + nextPermission,
            title: "Write mock.txt",
            kind: "edit",
            status: "pending",
            locations: [{ path: "/tmp/mock.txt" }],
            rawInput: {
              path: "/tmp/mock.txt",
              content: "hello",
            },
          },
          options: [
            {
              kind: "allow_once",
              name: "Allow once",
              optionId: "allow-once",
            },
            {
              kind: "allow_always",
              name: "Always allow",
              optionId: "allow-always",
            },
            {
              kind: "reject_once",
              name: "Reject",
              optionId: "reject-once",
            },
          ],
        },
      });
    }
  }

  if (!hasMethod || !hasId) {
    return;
  }

  if (method === "initialize") {
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        capabilities: {},
        serverInfo: {
          name: "mock-acp-agent",
          version: "0.0.1",
        },
      },
    });
    return;
  }

  if (method === "session/new") {
    nextSession += 1;
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "mock-session-" + nextSession,
      },
    });
    return;
  }

  if (method === "session/prompt") {
    const text = firstText(msg?.params?.prompt);
    if (text.includes("permission")) {
      return;
    }
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: "end_turn",
      },
    });
    return;
  }

  emit({
    jsonrpc: "2.0",
    id: msg.id,
    result: {
      ok: true,
      echoedMethod: method,
    },
  });
});
`;

  for (const installDir of candidateInstallDirs(dataHome)) {
    const processDir = join(installDir, "agent_processes");
    mkdirSync(processDir, { recursive: true });

    const runner = process.platform === "win32" ? join(processDir, "mock-acp.cmd") : join(processDir, "mock-acp");

    const scriptFile = process.platform === "win32" ? join(processDir, "mock-acp.js") : runner;

    writeFileSync(scriptFile, nodeScript);

    if (process.platform === "win32") {
      writeFileSync(runner, `@echo off\r\nnode "${scriptFile}" %*\r\n`);
    }

    chmodSync(scriptFile, 0o755);
    if (process.platform === "win32") {
      chmodSync(runner, 0o755);
    }
  }

  return runtimeEnv;
}
