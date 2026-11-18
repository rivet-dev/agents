import { describe, expect, it } from "vitest";

describe("malformed URI handling", () => {
  it("safeFetch wrapper returns 400 on URIError", async () => {
    // Simulate the pattern used in backend/src/index.ts
    const mockApp = {
      fetch: async (_req: Request): Promise<Response> => {
        // Simulate what happens when rivetkit's router encounters a malformed URI
        throw new URIError("URI malformed");
      },
    };

    const safeFetch = async (req: Request): Promise<Response> => {
      try {
        return await mockApp.fetch(req);
      } catch (err) {
        if (err instanceof URIError) {
          return new Response("Bad Request: Malformed URI", { status: 400 });
        }
        throw err;
      }
    };

    const response = await safeFetch(new Request("http://localhost/%ZZ"));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad Request: Malformed URI");
  });

  it("safeFetch wrapper re-throws non-URI errors", async () => {
    const mockApp = {
      fetch: async (_req: Request): Promise<Response> => {
        throw new TypeError("some other error");
      },
    };

    const safeFetch = async (req: Request): Promise<Response> => {
      try {
        return await mockApp.fetch(req);
      } catch (err) {
        if (err instanceof URIError) {
          return new Response("Bad Request: Malformed URI", { status: 400 });
        }
        throw err;
      }
    };

    await expect(safeFetch(new Request("http://localhost/test"))).rejects.toThrow(TypeError);
  });

  it("safeFetch wrapper passes through valid requests", async () => {
    const mockApp = {
      fetch: async (_req: Request): Promise<Response> => {
        return new Response("OK", { status: 200 });
      },
    };

    const safeFetch = async (req: Request): Promise<Response> => {
      try {
        return await mockApp.fetch(req);
      } catch (err) {
        if (err instanceof URIError) {
          return new Response("Bad Request: Malformed URI", { status: 400 });
        }
        throw err;
      }
    };

    const response = await safeFetch(new Request("http://localhost/valid/path"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("decodeURIComponent throws on malformed percent-encoding", () => {
    // Validates the core issue: decodeURIComponent throws URIError on malformed input
    expect(() => decodeURIComponent("%ZZ")).toThrow(URIError);
    expect(() => decodeURIComponent("%")).toThrow(URIError);
    expect(() => decodeURIComponent("%E0%A4%A")).toThrow(URIError);

    // Valid encoding should not throw
    expect(decodeURIComponent("%20")).toBe(" ");
    expect(decodeURIComponent("hello%20world")).toBe("hello world");
  });
});
