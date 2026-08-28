import { describe, it, expect, vi, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Minimal fake request / response ------------------------------------------------

function fakeReq(
  method: string,
  headers: Record<string, string> = {}
): VercelRequest {
  return { method, headers } as unknown as VercelRequest;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  ended: boolean;
}

function fakeRes(): FakeRes & VercelResponse {
  const r: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
  };
  return Object.assign(r, {
    status(code: number) {
      r.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      r.body = payload;
      return this;
    },
    setHeader(key: string, value: string) {
      r.headers[key.toLowerCase()] = value;
      return this;
    },
    end() {
      r.ended = true;
      return this;
    },
  }) as FakeRes & VercelResponse;
}

// --------------------------------------------------------------------------------

describe("Rate limit production fail-closed scoping (#621)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("does not throw at module load when VERCEL_ENV=production and Upstash is unconfigured", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
    delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

    await expect(import("../_lib/middleware.js")).resolves.toBeDefined();
  }, 15000);

  it("allows non-strict read-only routes to fall back to in-memory limiter in production without Upstash", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
    delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

    const mod = await import("../_lib/middleware.js");
    const req = fakeReq("GET", { "x-vercel-forwarded-for": "1.2.3.4" });
    const res = fakeRes();

    const allowed = await mod.checkRateLimit(req, res, { strict: false });
    expect(allowed).toBe(true);
    expect(res.statusCode).toBe(200);
  }, 15000);

  it("fails with HTTP 503 for strict critical routes in production when Upstash is unconfigured", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
    delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

    const mod = await import("../_lib/middleware.js");
    const req = fakeReq("POST", { "x-vercel-forwarded-for": "1.2.3.4" });
    const res = fakeRes();

    const allowed = await mod.checkRateLimit(req, res, { strict: true });
    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
      })
    );
  }, 15000);

  it("allows strict routes when distributed rate limiting is configured", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.UPSTASH_REDIS_REST_URL = "https://mock-redis.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";

    const mod = await import("../_lib/middleware.js");
    expect(mod.isDistributedRateLimitingConfigured()).toBe(true);
  }, 15000);
});
