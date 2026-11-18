import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxAgent, SandboxDestroyedError, type SandboxProvider } from "../src/index.ts";

const e2bMocks = vi.hoisted(() => {
  class MockNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NotFoundError";
    }
  }

  return {
    MockNotFoundError,
    betaCreate: vi.fn(),
    connect: vi.fn(),
  };
});

const modalMocks = vi.hoisted(() => ({
  appsFromName: vi.fn(),
  imageFromRegistry: vi.fn(),
  secretFromObject: vi.fn(),
  sandboxCreate: vi.fn(),
  sandboxFromId: vi.fn(),
}));

const computeSdkMocks = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const spritesMocks = vi.hoisted(() => ({
  createSprite: vi.fn(),
  getSprite: vi.fn(),
  deleteSprite: vi.fn(),
}));

vi.mock("@e2b/code-interpreter", () => ({
  NotFoundError: e2bMocks.MockNotFoundError,
  Sandbox: {
    betaCreate: e2bMocks.betaCreate,
    connect: e2bMocks.connect,
  },
}));

vi.mock("modal", () => ({
  ModalClient: class MockModalClient {
    apps = { fromName: modalMocks.appsFromName };
    images = { fromRegistry: modalMocks.imageFromRegistry };
    secrets = { fromObject: modalMocks.secretFromObject };
    sandboxes = {
      create: modalMocks.sandboxCreate,
      fromId: modalMocks.sandboxFromId,
    };
  },
}));

vi.mock("computesdk", () => ({
  compute: {
    sandbox: {
      create: computeSdkMocks.create,
      getById: computeSdkMocks.getById,
    },
  },
}));

vi.mock("@fly/sprites", () => ({
  SpritesClient: class MockSpritesClient {
    readonly token: string;
    readonly baseURL: string;

    constructor(token: string, options: { baseURL?: string } = {}) {
      this.token = token;
      this.baseURL = options.baseURL ?? "https://api.sprites.dev";
    }

    createSprite = spritesMocks.createSprite;
    getSprite = spritesMocks.getSprite;
    deleteSprite = spritesMocks.deleteSprite;
  },
}));

import { e2b } from "../src/providers/e2b.ts";
import { modal } from "../src/providers/modal.ts";
import { computesdk } from "../src/providers/computesdk.ts";
import { agentcomputer } from "../src/providers/agentcomputer.ts";
import { sprites } from "../src/providers/sprites.ts";

function createFetch(): typeof fetch {
  return async () => new Response(null, { status: 200 });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function createBaseProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    name: "mock",
    async create(): Promise<string> {
      return "created";
    },
    async destroy(): Promise<void> {},
    async getUrl(): Promise<string> {
      return "http://127.0.0.1:3000";
    },
    ...overrides,
  };
}

function createMockSandbox() {
  return {
    sandboxId: "sbx-123",
    getHost: vi.fn(() => "sandbox.example"),
    betaPause: vi.fn(async () => true),
    kill: vi.fn(async () => undefined),
    commands: {
      run: vi.fn(async () => ({ exitCode: 0, stderr: "" })),
    },
  };
}

function createMockModalImage() {
  return {
    dockerfileCommands: vi.fn(function dockerfileCommands() {
      return this;
    }),
  };
}

beforeEach(() => {
  e2bMocks.betaCreate.mockReset();
  e2bMocks.connect.mockReset();
  modalMocks.appsFromName.mockReset();
  modalMocks.imageFromRegistry.mockReset();
  modalMocks.secretFromObject.mockReset();
  modalMocks.sandboxCreate.mockReset();
  modalMocks.sandboxFromId.mockReset();
  computeSdkMocks.create.mockReset();
  computeSdkMocks.getById.mockReset();
  spritesMocks.createSprite.mockReset();
  spritesMocks.getSprite.mockReset();
  spritesMocks.deleteSprite.mockReset();
});

describe("SandboxAgent provider lifecycle", () => {
  it("reconnects an existing sandbox before ensureServer", async () => {
    const order: string[] = [];
    const provider = createBaseProvider({
      reconnect: vi.fn(async () => {
        order.push("reconnect");
      }),
      ensureServer: vi.fn(async () => {
        order.push("ensureServer");
      }),
    });

    const sdk = await SandboxAgent.start({
      sandbox: provider,
      sandboxId: "mock/existing",
      skipHealthCheck: true,
      fetch: createFetch(),
    });

    expect(order).toEqual(["reconnect", "ensureServer"]);

    await sdk.killSandbox();
  });

  it("surfaces SandboxDestroyedError from reconnect", async () => {
    const provider = createBaseProvider({
      reconnect: vi.fn(async () => {
        throw new SandboxDestroyedError("existing", "mock");
      }),
      ensureServer: vi.fn(async () => undefined),
    });

    await expect(
      SandboxAgent.start({
        sandbox: provider,
        sandboxId: "mock/existing",
        skipHealthCheck: true,
        fetch: createFetch(),
      }),
    ).rejects.toBeInstanceOf(SandboxDestroyedError);

    expect(provider.ensureServer).not.toHaveBeenCalled();
  });

  it("uses provider pause and kill hooks for explicit lifecycle control", async () => {
    const pause = vi.fn(async () => undefined);
    const kill = vi.fn(async () => undefined);
    const provider = createBaseProvider({ pause, kill });

    const paused = await SandboxAgent.start({
      sandbox: provider,
      skipHealthCheck: true,
      fetch: createFetch(),
    });
    await paused.pauseSandbox();
    expect(pause).toHaveBeenCalledWith("created");

    const killed = await SandboxAgent.start({
      sandbox: provider,
      skipHealthCheck: true,
      fetch: createFetch(),
    });
    await killed.killSandbox();
    expect(kill).toHaveBeenCalledWith("created");
  });

  it("uses provider-specific inspector URLs when provided", async () => {
    const provider = createBaseProvider({
      async getUrl(): Promise<string> {
        return "https://sandbox.example";
      },
      async getInspectorUrl(): Promise<string> {
        return "https://sandbox.example/ui/?access_token=test-token";
      },
    });

    const sdk = await SandboxAgent.start({
      sandbox: provider,
      skipHealthCheck: true,
      fetch: createFetch(),
    });

    expect(sdk.inspectorUrl).toBe("https://sandbox.example/ui/?access_token=test-token");

    await sdk.killSandbox();
  });
});

describe("e2b provider", () => {
  it("creates sandboxes with betaCreate, autoPause, and the default timeout", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.betaCreate.mockResolvedValue(sandbox);

    const provider = e2b({
      create: {
        envs: { ANTHROPIC_API_KEY: "test" },
      },
    });

    await expect(provider.create()).resolves.toBe("sbx-123");

    expect(e2bMocks.betaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        allowInternetAccess: true,
        autoPause: true,
        timeoutMs: 3_600_000,
        envs: { ANTHROPIC_API_KEY: "test" },
      }),
    );
  });

  it("allows timeoutMs and autoPause to be overridden", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.betaCreate.mockResolvedValue(sandbox);

    const provider = e2b({
      timeoutMs: 123_456,
      autoPause: false,
    });

    await provider.create();

    expect(e2bMocks.betaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        autoPause: false,
        timeoutMs: 123_456,
      }),
    );
  });

  it("pauses by default in destroy and uses kill for permanent deletion", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.connect.mockResolvedValue(sandbox);
    const provider = e2b();

    await provider.destroy("sbx-123");
    expect(e2bMocks.connect).toHaveBeenLastCalledWith("sbx-123", { timeoutMs: 3_600_000 });
    expect(sandbox.betaPause).toHaveBeenCalledTimes(1);
    expect(sandbox.kill).not.toHaveBeenCalled();

    await provider.kill?.("sbx-123");
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("maps missing reconnect targets to SandboxDestroyedError", async () => {
    e2bMocks.connect.mockRejectedValue(new e2bMocks.MockNotFoundError("gone"));
    const provider = e2b();

    await expect(provider.reconnect?.("missing-sandbox")).rejects.toBeInstanceOf(SandboxDestroyedError);
  });

  it("passes a configured template to betaCreate", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.betaCreate.mockResolvedValue(sandbox);

    const provider = e2b({
      template: "my-template",
      create: { envs: { ANTHROPIC_API_KEY: "test" } },
    });

    await provider.create();

    expect(e2bMocks.betaCreate).toHaveBeenCalledWith(
      "my-template",
      expect.objectContaining({
        allowInternetAccess: true,
        envs: { ANTHROPIC_API_KEY: "test" },
        timeoutMs: 3_600_000,
      }),
    );
  });

  it("accepts legacy create.template values from plain JavaScript", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.betaCreate.mockResolvedValue(sandbox);

    const provider = e2b({
      create: { template: "legacy-template" } as never,
    });

    await provider.create();

    expect(e2bMocks.betaCreate).toHaveBeenCalledWith(
      "legacy-template",
      expect.objectContaining({
        allowInternetAccess: true,
        timeoutMs: 3_600_000,
      }),
    );
  });
});

describe("modal provider", () => {
  it("uses the configured base image when building the sandbox image", async () => {
    const app = { appId: "app-123" };
    const image = createMockModalImage();
    const sandbox = {
      sandboxId: "sbx-modal",
      exec: vi.fn(),
    };

    modalMocks.appsFromName.mockResolvedValue(app);
    modalMocks.imageFromRegistry.mockReturnValue(image);
    modalMocks.sandboxCreate.mockResolvedValue(sandbox);

    const provider = modal({
      image: "python:3.12-slim",
      create: {
        appName: "custom-app",
        secrets: { OPENAI_API_KEY: "test" },
      },
    });

    await expect(provider.create()).resolves.toBe("sbx-modal");

    expect(modalMocks.appsFromName).toHaveBeenCalledWith("custom-app", { createIfMissing: true });
    expect(modalMocks.imageFromRegistry).toHaveBeenCalledWith("python:3.12-slim");
    expect(image.dockerfileCommands).not.toHaveBeenCalled();
    expect(modalMocks.sandboxCreate).toHaveBeenCalledWith(
      app,
      image,
      expect.objectContaining({
        encryptedPorts: [3000],
        memoryMiB: 2048,
      }),
    );
  });
});

describe("computesdk provider", () => {
  it("passes image and template options through to compute.sandbox.create", async () => {
    const sandbox = {
      sandboxId: "sbx-compute",
      runCommand: vi.fn(async () => ({ exitCode: 0, stderr: "" })),
    };
    computeSdkMocks.create.mockResolvedValue(sandbox);

    const provider = computesdk({
      create: {
        envs: { ANTHROPIC_API_KEY: "test" },
        image: "ghcr.io/example/sandbox-agent:latest",
        templateId: "tmpl-123",
      },
    });

    await expect(provider.create()).resolves.toBe("sbx-compute");

    expect(computeSdkMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        envs: { ANTHROPIC_API_KEY: "test" },
        image: "ghcr.io/example/sandbox-agent:latest",
        templateId: "tmpl-123",
      }),
    );
  });
});

describe("agentcomputer provider", () => {
  it("creates managed-worker computers with platform defaults and exposes an auth-ready inspector URL", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_123", status: "pending" }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_123", status: "pending" }))
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_123", status: "starting" }))
      .mockResolvedValueOnce(jsonResponse({ connection: { web_url: "https://box.agentcomputer.example" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_url: "https://box.agentcomputer.example?access_token=browser-token",
          expires_at: "2099-01-01T00:00:00Z",
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const sdk = await SandboxAgent.start({
      sandbox: agentcomputer({
        apiKey: "ac_live_test",
        fetch: fetchMock,
        pollIntervalMs: 0,
      }),
    });

    expect(sdk.sandboxId).toBe("agentcomputer/cmp_123");
    expect(sdk.inspectorUrl).toBe("https://box.agentcomputer.example/ui/?access_token=browser-token");

    const health = await sdk.getHealth();
    expect(health.status).toBe("ok");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.computer.agentcomputer.ai/v1/computers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          runtime_family: "managed-worker",
          use_platform_default: true,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.computer.agentcomputer.ai/v1/computers/cmp_123/connection",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );

    const browserAccessRequest = fetchMock.mock.calls[4];
    expect(browserAccessRequest?.[0]).toBe("https://api.computer.agentcomputer.ai/v1/computers/cmp_123/access/browser");

    const sandboxHealthRequest = fetchMock.mock.calls[5]?.[0];
    expect(sandboxHealthRequest).toBeInstanceOf(Request);
    const sandboxHealthHeaders = new Headers((sandboxHealthRequest as Request).headers);
    expect(sandboxHealthHeaders.get("cookie")).toContain("agentcomputer_access_session=browser-token");

    await sdk.killSandbox();
  });

  it("maps missing computers to SandboxDestroyedError during reconnect", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const provider = agentcomputer({
      apiKey: "ac_live_test",
      fetch: fetchMock,
    });

    await expect(provider.reconnect?.("cmp_missing")).rejects.toBeInstanceOf(SandboxDestroyedError);
  });
});

describe("sprites provider", () => {
  it("creates a sprite, installs sandbox-agent, and configures the managed service", async () => {
    const sprite = {
      name: "sprite-1",
      execFile: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    };
    spritesMocks.createSprite.mockResolvedValue(sprite);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: { status: "stopped" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = sprites({
      token: "sprite-token",
      create: {
        name: "sprite-1",
      },
      env: {
        OPENAI_API_KEY: "test'value",
      },
    });

    await expect(provider.create()).resolves.toBe("sprite-1");

    expect(spritesMocks.createSprite).toHaveBeenCalledWith("sprite-1", undefined);
    expect(sprite.execFile).not.toHaveBeenCalled();

    const putCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/services/sandbox-agent") && init?.method === "PUT");
    expect(putCall).toBeDefined();
    expect(String(putCall?.[0])).toContain("/v1/sprites/sprite-1/services/sandbox-agent");
    expect(putCall?.[1]?.headers).toMatchObject({
      Authorization: "Bearer sprite-token",
      "Content-Type": "application/json",
    });
    const serviceRequest = JSON.parse(String(putCall?.[1]?.body)) as { args: string[] };
    expect(serviceRequest.args[1]).toContain("exec npx -y @sandbox-agent/cli@0.5.0-rc.2 server --no-token --host 0.0.0.0 --port 8080");
    expect(serviceRequest.args[1]).toContain("OPENAI_API_KEY='test'\\''value'");
  });

  it("optionally installs agents through npx when requested", async () => {
    const sprite = {
      name: "sprite-1",
      execFile: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    };
    spritesMocks.createSprite.mockResolvedValue(sprite);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: { status: "stopped" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = sprites({
      token: "sprite-token",
      create: { name: "sprite-1" },
      env: { OPENAI_API_KEY: "test" },
      installAgents: ["claude", "codex"],
    });

    await provider.create();

    expect(sprite.execFile).toHaveBeenCalledWith("bash", ["-lc", "npx -y @sandbox-agent/cli@0.5.0-rc.2 install-agent claude"], {
      env: { OPENAI_API_KEY: "test" },
    });
    expect(sprite.execFile).toHaveBeenCalledWith("bash", ["-lc", "npx -y @sandbox-agent/cli@0.5.0-rc.2 install-agent codex"], {
      env: { OPENAI_API_KEY: "test" },
    });
  });

  it("returns the sprite URL and provider token for authenticated access", async () => {
    spritesMocks.getSprite.mockResolvedValue({
      name: "sprite-1",
      url: "https://sprite-1.sprites.app",
    });

    const provider = sprites({
      token: "sprite-token",
    });

    await expect(provider.getUrl?.("sprite-1")).resolves.toBe("https://sprite-1.sprites.app");
    await expect((provider as SandboxProvider & { getToken: (sandboxId: string) => Promise<string> }).getToken("sprite-1")).resolves.toBe("sprite-token");
  });

  it("maps missing reconnect targets to SandboxDestroyedError", async () => {
    spritesMocks.getSprite.mockRejectedValue(new Error("Sprite not found: missing-sprite"));
    const provider = sprites({
      token: "sprite-token",
    });

    await expect(provider.reconnect?.("missing-sprite")).rejects.toBeInstanceOf(SandboxDestroyedError);
  });

  it("skips starting the service when the desired service is already running", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            cmd: "bash",
            args: ["-lc", "exec npx -y @sandbox-agent/cli@0.5.0-rc.2 server --no-token --host 0.0.0.0 --port 8080"],
            http_port: 8080,
            state: { status: "running" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            cmd: "bash",
            args: ["-lc", "exec npx -y @sandbox-agent/cli@0.5.0-rc.2 server --no-token --host 0.0.0.0 --port 8080"],
            http_port: 8080,
            state: { status: "running" },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = sprites({
      token: "sprite-token",
    });

    await provider.ensureServer?.("sprite-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});
