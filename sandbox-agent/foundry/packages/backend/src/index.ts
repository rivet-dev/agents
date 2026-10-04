import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { initActorRuntimeContext } from "./actors/context.js";
import { registry } from "./actors/index.js";
import { organizationKey } from "./actors/keys.js";
import { loadConfig } from "./config/backend.js";
import { createBackends, createNotificationService } from "./notifications/index.js";
import { createDefaultDriver } from "./driver.js";
import { createClient } from "rivetkit/client";
import { initBetterAuthService } from "./services/better-auth.js";
import { createDefaultAppShellServices } from "./services/app-shell-runtime.js";
import { APP_SHELL_ORGANIZATION_ID } from "./actors/organization/constants.js";
import { logger } from "./logging.js";

export interface BackendStartOptions {
  host?: string;
  port?: number;
}

interface AppOrganizationLogContext {
  action?: string;
  cfConnectingIp?: string;
  cfRay?: string;
  forwardedFor?: string;
  forwardedHost?: string;
  forwardedProto?: string;
  method?: string;
  path?: string;
  requestId?: string;
  referer?: string;
  secFetchDest?: string;
  secFetchMode?: string;
  secFetchSite?: string;
  secFetchUser?: string;
  sessionId?: string;
  userAgent?: string;
  xRealIp?: string;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function isRivetRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/v1/rivet" || pathname.startsWith("/v1/rivet/");
}

export async function startBackend(options: BackendStartOptions = {}): Promise<void> {
  // Prevent the sandbox-agent SDK's unhandled SQLite constraint errors from
  // crashing the entire process. The SDK has a bug where duplicate event
  // inserts (sandbox_agent_events UNIQUE constraint) throw from an internal
  // async path with no catch. Log and continue.
  process.on("uncaughtException", (error) => {
    logger.error({ error: error?.message ?? String(error), stack: error?.stack }, "uncaughtException (kept alive)");
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error({ error: msg, stack }, "unhandledRejection (kept alive)");
  });

  // sandbox-agent agent plugins vary on which env var they read for OpenAI/Codex auth.
  // Normalize to keep local dev + docker-compose simple.
  if (!process.env.CODEX_API_KEY && process.env.OPENAI_API_KEY) {
    process.env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
  }

  const config = loadConfig();
  config.backend.host = options.host ?? config.backend.host;
  config.backend.port = options.port ?? config.backend.port;

  // Allow docker-compose/dev environments to supply provider config via env vars
  // instead of writing into the container's config.toml.
  const envFirst = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const raw = process.env[key];
      if (raw && raw.trim().length > 0) return raw.trim();
    }
    return undefined;
  };

  config.sandboxProviders.e2b.apiKey = envFirst("E2B_API_KEY") ?? config.sandboxProviders.e2b.apiKey;
  config.sandboxProviders.e2b.template = envFirst("HF_E2B_TEMPLATE", "E2B_TEMPLATE") ?? config.sandboxProviders.e2b.template;

  const driver = createDefaultDriver();
  const backends = await createBackends(config.notify);
  const notifications = createNotificationService(backends);
  const appShellServices = createDefaultAppShellServices();
  initActorRuntimeContext(config, notifications, driver, appShellServices);

  const actorClient = createClient({
    endpoint: `http://127.0.0.1:${config.backend.port}/v1/rivet`,
  }) as any;
  const betterAuth = initBetterAuthService(actorClient, {
    apiUrl: appShellServices.apiUrl,
    appUrl: appShellServices.appUrl,
  });

  const requestHeaderContext = (c: any): AppOrganizationLogContext => ({
    cfConnectingIp: c.req.header("cf-connecting-ip") ?? undefined,
    cfRay: c.req.header("cf-ray") ?? undefined,
    forwardedFor: c.req.header("x-forwarded-for") ?? undefined,
    forwardedHost: c.req.header("x-forwarded-host") ?? undefined,
    forwardedProto: c.req.header("x-forwarded-proto") ?? undefined,
    referer: c.req.header("referer") ?? undefined,
    secFetchDest: c.req.header("sec-fetch-dest") ?? undefined,
    secFetchMode: c.req.header("sec-fetch-mode") ?? undefined,
    secFetchSite: c.req.header("sec-fetch-site") ?? undefined,
    secFetchUser: c.req.header("sec-fetch-user") ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
    xRealIp: c.req.header("x-real-ip") ?? undefined,
  });

  // Serve custom Foundry HTTP APIs alongside the RivetKit registry.
  const app = new Hono<{ Variables: { requestId: string } }>();
  const allowHeaders = [
    "Content-Type",
    "Authorization",
    "x-rivet-token",
    "x-rivet-encoding",
    "x-rivet-query",
    "x-rivet-conn-params",
    "x-rivet-actor",
    "x-rivet-target",
    "x-rivet-namespace",
    "x-rivet-endpoint",
    "x-rivet-total-slots",
    "x-rivet-runner-name",
    "x-rivet-namespace-name",
  ];
  const exposeHeaders = ["Content-Type", "x-rivet-ray-id"];
  const allowedOrigins = new Set([stripTrailingSlash(appShellServices.appUrl), stripTrailingSlash(appShellServices.apiUrl)]);
  const corsConfig = {
    origin: (origin: string) => (allowedOrigins.has(origin) ? origin : null) as string | undefined | null,
    credentials: true,
    allowHeaders,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders,
  };
  app.use("/v1/*", cors(corsConfig));
  app.use("/v1", cors(corsConfig));

  // On-demand memory snapshot endpoint for diagnosing spikes (dev only).
  // Usage: curl http://127.0.0.1:7741/debug/memory
  // Trigger GC first: curl http://127.0.0.1:7741/debug/memory?gc=1
  // Write JSC heap snapshot: curl http://127.0.0.1:7741/debug/memory?heap=1
  //   (writes /tmp/foundry-heap-<timestamp>.json, inspect with chrome://tracing)
  app.get("/debug/memory", async (c) => {
    if (process.env.NODE_ENV !== "development") {
      return c.json({ error: "debug endpoints disabled in production" }, 403);
    }
    const wantGc = c.req.query("gc") === "1";
    if (wantGc && typeof Bun !== "undefined") {
      // Bun.gc(true) triggers a synchronous full GC sweep in JavaScriptCore.
      Bun.gc(true);
    }
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
    const externalMb = Math.round(mem.external / 1024 / 1024);
    const nonHeapMb = rssMb - heapUsedMb - externalMb;
    // Bun.heapStats() gives JSC-specific breakdown: object counts, typed array
    // bytes, extra memory (native allocations tracked by JSC). Useful for
    // distinguishing JS object bloat from native/WASM memory.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BunAny = Bun as any;
    const heapStats = typeof BunAny.heapStats === "function" ? BunAny.heapStats() : null;
    const snapshot = {
      rssMb,
      heapUsedMb,
      heapTotalMb,
      externalMb,
      nonHeapMb,
      gcTriggered: wantGc,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      ...(heapStats ? { bunHeapStats: heapStats } : {}),
    };
    // Optionally write a full JSC heap snapshot for offline analysis.
    let heapSnapshotPath: string | null = null;
    const wantHeap = c.req.query("heap") === "1";
    if (wantHeap && typeof Bun !== "undefined") {
      heapSnapshotPath = `/tmp/foundry-heap-${Date.now()}.json`;
      // Bun.generateHeapSnapshot("v8") returns a V8-compatible JSON string.
      const heapJson = Bun.generateHeapSnapshot("v8");
      await Bun.write(heapSnapshotPath, heapJson);
    }
    logger.info(snapshot, "memory_usage_debug");
    return c.json({ ...snapshot, ...(heapSnapshotPath ? { heapSnapshotPath } : {}) });
  });

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id")?.trim() || randomUUID();
    const start = performance.now();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);

    try {
      await next();
    } catch (error) {
      logger.error(
        {
          ...requestHeaderContext(c),
          requestId,
          method: c.req.method,
          path: c.req.path,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "http_request_failed",
      );
      throw error;
    }

    logger.info(
      {
        ...requestHeaderContext(c),
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      },
      "http_request",
    );
  });

  // Cache the app organization actor handle for the lifetime of this backend process.
  // The "app" organization is a singleton coordinator for auth indexes, org state, and
  // billing. Caching avoids repeated getOrCreate round-trips on every HTTP request.
  let cachedAppOrganization: any | null = null;

  const appOrganization = async (context: AppOrganizationLogContext = {}) => {
    if (cachedAppOrganization) return cachedAppOrganization;

    const start = performance.now();
    try {
      const handle = await actorClient.organization.getOrCreate(organizationKey(APP_SHELL_ORGANIZATION_ID), {
        createWithInput: APP_SHELL_ORGANIZATION_ID,
      });
      cachedAppOrganization = handle;
      logger.info(
        {
          ...context,
          cache: "miss",
          durationMs: Math.round((performance.now() - start) * 100) / 100,
        },
        "app_organization_resolve",
      );
      return handle;
    } catch (error) {
      logger.error(
        {
          ...context,
          cache: "miss",
          durationMs: Math.round((performance.now() - start) * 100) / 100,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "app_organization_resolve_failed",
      );
      throw error;
    }
  };

  const requestLogContext = (c: any, sessionId?: string): AppOrganizationLogContext => ({
    ...requestHeaderContext(c),
    method: c.req.method,
    path: c.req.path,
    requestId: c.get("requestId"),
    sessionId,
  });

  const resolveSessionId = async (c: any): Promise<string | null> => {
    const session = await betterAuth.resolveSession(c.req.raw.headers);
    return session?.session?.id ?? null;
  };

  // Deduplicate OAuth callback requests. The production proxy chain
  // (Cloudflare -> Fastly -> Railway) retries callback requests when they take
  // >10s. The first request deletes the verification record on success, so the
  // retry fails with "verification not found" -> ?error=please_restart_the_process.
  // This map tracks in-flight callbacks by state param so retries wait for and
  // reuse the first request's response.
  const inflightCallbacks = new Map<string, Promise<Response>>();

  app.all("/v1/auth/*", async (c) => {
    const authPath = c.req.path;
    const authMethod = c.req.method;
    const isCallback = authPath.includes("/callback/");

    // Deduplicate callback requests by OAuth state parameter
    if (isCallback) {
      const url = new URL(c.req.url);
      const state = url.searchParams.get("state");
      if (state) {
        const existing = inflightCallbacks.get(state);
        if (existing) {
          logger.info({ path: authPath, state: state.slice(0, 8) + "..." }, "auth_callback_dedup");
          const original = await existing;
          return original.clone();
        }

        const promise = (async () => {
          logger.info({ path: authPath, method: authMethod, state: state.slice(0, 8) + "..." }, "auth_callback_start");
          const start = performance.now();
          const response = await betterAuth.auth.handler(c.req.raw);
          const durationMs = Math.round((performance.now() - start) * 100) / 100;
          const location = response.headers.get("location");
          logger.info({ path: authPath, status: response.status, durationMs, location: location ?? undefined }, "auth_callback_complete");
          if (location && location.includes("error=")) {
            logger.error({ path: authPath, status: response.status, durationMs, location }, "auth_callback_error_redirect");
          }
          return response;
        })();

        inflightCallbacks.set(state, promise);
        try {
          const response = await promise;
          return response.clone();
        } finally {
          // Keep entry briefly so late retries still hit the cache
          setTimeout(() => inflightCallbacks.delete(state), 30_000);
        }
      }
    }

    return await betterAuth.auth.handler(c.req.raw);
  });

  app.post("/v1/app/sign-out", async (c) => {
    const sessionId = await resolveSessionId(c);
    if (sessionId) {
      const signOutResponse = await betterAuth.signOut(c.req.raw.headers);
      const setCookie = signOutResponse.headers.get("set-cookie");
      if (setCookie) {
        c.header("set-cookie", setCookie);
      }
    }
    return c.json({
      auth: { status: "signed_out", currentUserId: null },
      activeOrganizationId: null,
      onboarding: {
        starterRepo: {
          repoFullName: "rivet-dev/sandbox-agent",
          repoUrl: "https://github.com/rivet-dev/sandbox-agent",
          status: "pending",
          starredAt: null,
          skippedAt: null,
        },
      },
      users: [],
      organizations: [],
    });
  });

  app.get("/v1/billing/checkout/complete", async (c) => {
    const organizationId = c.req.query("organizationId");
    const checkoutSessionId = c.req.query("session_id");
    if (!organizationId || !checkoutSessionId) {
      return c.text("Missing Stripe checkout completion parameters", 400);
    }
    const sessionId = await resolveSessionId(c);
    if (!sessionId) {
      return c.text("Unauthorized", 401);
    }
    const result = await (await appOrganization(requestLogContext(c, sessionId))).finalizeAppCheckoutSession({
      organizationId,
      sessionId,
      checkoutSessionId,
    });
    return Response.redirect(result.redirectTo, 302);
  });

  const handleStripeWebhook = async (c: any) => {
    const payload = await c.req.text();
    await (await appOrganization(requestLogContext(c))).handleAppStripeWebhook({
      payload,
      signatureHeader: c.req.header("stripe-signature") ?? null,
    });
    return c.json({ ok: true });
  };

  app.post("/v1/webhooks/stripe", handleStripeWebhook);

  app.post("/v1/webhooks/github", async (c) => {
    const payload = await c.req.text();
    await (await appOrganization(requestLogContext(c))).handleAppGithubWebhook({
      payload,
      signatureHeader: c.req.header("x-hub-signature-256") ?? null,
      eventHeader: c.req.header("x-github-event") ?? null,
    });
    return c.json({ ok: true });
  });

  const server = Bun.serve({
    fetch: (request) => {
      if (isRivetRequest(request)) {
        return registry.handler(request);
      }
      return app.fetch(request);
    },
    hostname: config.backend.host,
    port: config.backend.port,
    // Bun defaults to 10s idle timeout. Actor RPCs go through the gateway
    // tunnel (not direct HTTP), and the SSE stream has a 1s ping interval
    // (RUNNER_SSE_PING_INTERVAL in rivetkit), so the idle timeout likely
    // never fires in practice. Set high as a safety net regardless.
    idleTimeout: 255,
  });

  logger.info(
    {
      host: config.backend.host,
      port: config.backend.port,
    },
    "backend_started",
  );

  // Periodic memory usage reporting for diagnosing memory spikes (dev only).
  // Logs JS heap, RSS, and external (native/WASM) separately so we can tell
  // whether spikes come from JS objects, Bun/JSC internals, or native addons
  // like SQLite/WASM.
  if (process.env.NODE_ENV === "development") {
    let prevRss = 0;
    setInterval(() => {
      const mem = process.memoryUsage();
      const rssMb = Math.round(mem.rss / 1024 / 1024);
      const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
      const externalMb = Math.round(mem.external / 1024 / 1024);
      // Non-heap RSS: memory not accounted for by JS heap or external buffers.
      // Large values here point to native allocations (WASM, mmap, child process
      // bookkeeping, Bun's internal arena, etc.).
      const nonHeapMb = rssMb - heapUsedMb - externalMb;
      const deltaRss = rssMb - prevRss;
      prevRss = rssMb;
      logger.info(
        {
          rssMb,
          heapUsedMb,
          heapTotalMb,
          externalMb,
          nonHeapMb,
          deltaRssMb: deltaRss,
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          externalBytes: mem.external,
        },
        "memory_usage",
      );
    }, 60_000);
  }

  process.on("SIGINT", async () => {
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    server.stop();
    process.exit(0);
  });

  // Keep process alive.
  await new Promise<void>(() => undefined);
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function parseEnvPort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return port;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "start";
  if (cmd !== "start") {
    throw new Error(`Unsupported backend command: ${cmd}`);
  }

  const host = parseArg("--host") ?? process.env.HOST ?? process.env.HF_BACKEND_HOST;
  const port = parseArg("--port") ?? process.env.PORT ?? process.env.HF_BACKEND_PORT;
  await startBackend({
    host,
    port: parseEnvPort(port),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    logger.fatal(
      {
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      },
      "backend_start_failed",
    );
    process.exit(1);
  });
}
