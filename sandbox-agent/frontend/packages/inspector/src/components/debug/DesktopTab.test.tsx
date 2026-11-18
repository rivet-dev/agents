// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxAgent } from "sandbox-agent";
import {
  createDockerTestLayout,
  disposeDockerTestLayout,
  startDockerSandboxAgent,
  type DockerSandboxAgentHandle,
} from "../../../../../../sdks/typescript/tests/helpers/docker.ts";
import DesktopTab from "./DesktopTab";

type DockerTestLayout = ReturnType<typeof createDockerTestLayout>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 20_000, stepMs = 50): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value !== undefined && value !== null) {
      return value;
    }
    await sleep(stepMs);
  }
  throw new Error("timed out waiting for condition");
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(label)) as HTMLButtonElement | undefined;
}

describe.sequential("DesktopTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let layout: DockerTestLayout | undefined;
  let handle: DockerSandboxAgentHandle | undefined;
  let client: SandboxAgent | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    if (client) {
      await client.stopDesktop().catch(() => {});
      await client.dispose().catch(() => {});
    }
    if (handle) {
      await handle.dispose();
    }
    if (layout) {
      disposeDockerTestLayout(layout);
    }
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    client = undefined;
    handle = undefined;
    layout = undefined;
  });

  async function connectDesktopClient(options?: { pathMode?: "merge" | "replace" }): Promise<SandboxAgent> {
    layout = createDockerTestLayout();
    handle = await startDockerSandboxAgent(layout, {
      timeoutMs: 30_000,
      pathMode: options?.pathMode,
      env: options?.pathMode === "replace" ? { PATH: layout.rootDir } : undefined,
    });
    client = await SandboxAgent.connect({
      baseUrl: handle.baseUrl,
      token: handle.token,
    });
    return client;
  }

  it("renders install remediation when desktop deps are missing", async () => {
    const connectedClient = await connectDesktopClient({ pathMode: "replace" });

    await act(async () => {
      root.render(<DesktopTab getClient={() => connectedClient} />);
    });

    await waitFor(() => {
      const text = container.textContent ?? "";
      return text.includes("install_required") ? text : undefined;
    });

    expect(container.textContent).toContain("install_required");
    expect(container.textContent).toContain("sandbox-agent install desktop --yes");
    expect(container.textContent).toContain("Xvfb");
  });

  it("starts desktop, refreshes screenshot, and stops desktop", async () => {
    const connectedClient = await connectDesktopClient();

    await act(async () => {
      root.render(<DesktopTab getClient={() => connectedClient} />);
    });

    await waitFor(() => {
      const text = container.textContent ?? "";
      return text.includes("inactive") ? true : undefined;
    });

    const startButton = await waitFor(() => findButton(container, "Start Desktop"));
    await act(async () => {
      startButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      const screenshot = container.querySelector("img[alt='Desktop screenshot']") as HTMLImageElement | null;
      return screenshot?.src ? screenshot : undefined;
    });

    const screenshot = container.querySelector("img[alt='Desktop screenshot']") as HTMLImageElement | null;
    expect(screenshot).toBeTruthy();
    expect(screenshot?.src.startsWith("blob:") || screenshot?.src.startsWith("data:image/png")).toBe(true);
    expect(container.textContent).toContain("active");

    const stopButton = await waitFor(() => findButton(container, "Stop Desktop"));
    await act(async () => {
      stopButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      const text = container.textContent ?? "";
      return text.includes("inactive") ? true : undefined;
    });

    expect(container.textContent).toContain("inactive");
  });
});
