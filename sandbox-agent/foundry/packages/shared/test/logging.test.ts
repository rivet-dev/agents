import { afterEach, describe, expect, it, vi } from "vitest";
import { createFoundryLogger } from "../src/logging.js";

describe("createFoundryLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits logfmt output when requested", () => {
    const writes: string[] = [];
    const write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(write as typeof process.stdout.write);

    const logger = createFoundryLogger({
      service: "foundry-backend",
      format: "logfmt",
    }).child({
      requestId: "req-123",
    });

    logger.info({ count: 2, nested: { ok: true } }, "backend started");

    expect(write).toHaveBeenCalledTimes(1);
    expect(writes[0]).toMatch(/^time=\S+ level=info service=foundry-backend requestId=req-123 count=2 nested="\{\\"ok\\":true\}" msg="backend started"\n$/);
  });
});
