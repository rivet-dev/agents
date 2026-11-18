import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type NotifyUrgency = "low" | "normal" | "high";

export interface NotifyBackend {
  name: string;
  available(): Promise<boolean>;
  send(title: string, body: string, urgency: NotifyUrgency): Promise<boolean>;
}

async function isOnPath(binary: string): Promise<boolean> {
  try {
    await execFileAsync("which", [binary]);
    return true;
  } catch {
    return false;
  }
}

export class OpenclawBackend implements NotifyBackend {
  readonly name = "openclaw";

  async available(): Promise<boolean> {
    return isOnPath("openclaw");
  }

  async send(title: string, body: string, _urgency: NotifyUrgency): Promise<boolean> {
    try {
      await execFileAsync("openclaw", ["wake", "--title", title, "--body", body]);
      return true;
    } catch {
      return false;
    }
  }
}

export class MacOsNotifyBackend implements NotifyBackend {
  readonly name = "macos-osascript";

  async available(): Promise<boolean> {
    return process.platform === "darwin";
  }

  async send(title: string, body: string, _urgency: NotifyUrgency): Promise<boolean> {
    try {
      const escaped_body = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const escaped_title = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `display notification "${escaped_body}" with title "${escaped_title}"`;
      await execFileAsync("osascript", ["-e", script]);
      return true;
    } catch {
      return false;
    }
  }
}

export class LinuxNotifySendBackend implements NotifyBackend {
  readonly name = "linux-notify-send";

  async available(): Promise<boolean> {
    return isOnPath("notify-send");
  }

  async send(title: string, body: string, urgency: NotifyUrgency): Promise<boolean> {
    const urgencyMap: Record<NotifyUrgency, string> = {
      low: "low",
      normal: "normal",
      high: "critical",
    };

    try {
      await execFileAsync("notify-send", ["-u", urgencyMap[urgency], title, body]);
      return true;
    } catch {
      return false;
    }
  }
}

export class TerminalBellBackend implements NotifyBackend {
  readonly name = "terminal";

  async available(): Promise<boolean> {
    return true;
  }

  async send(title: string, body: string, _urgency: NotifyUrgency): Promise<boolean> {
    try {
      process.stderr.write("\x07");
      process.stderr.write(`[${title}] ${body}\n`);
      return true;
    } catch {
      return false;
    }
  }
}

const backendFactories: Record<string, () => NotifyBackend> = {
  openclaw: () => new OpenclawBackend(),
  "macos-osascript": () => new MacOsNotifyBackend(),
  "linux-notify-send": () => new LinuxNotifySendBackend(),
  terminal: () => new TerminalBellBackend(),
};

export async function createBackends(configOrder: string[]): Promise<NotifyBackend[]> {
  const backends: NotifyBackend[] = [];

  for (const name of configOrder) {
    const backendBuilder = backendFactories[name];
    if (!backendBuilder) {
      continue;
    }

    const backend = backendBuilder();
    if (await backend.available()) {
      backends.push(backend);
    }
  }

  return backends;
}
