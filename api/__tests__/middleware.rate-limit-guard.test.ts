import { describe, it, expect, vi, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// This file intentionally has no static import of middleware.js: the module
// throws at load time when VERCEL_ENV=production and the Upstash credentials
// are absent, so importing it statically would crash the whole file (and every
// pre-existing test in it) if the ambient environment ever has those vars set.
// All imports below are dynamic, inside the test body, where the env vars are
// controlled explicitly.

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
    end() {
      r.ended = true;
      return this;
    },
    setHeader(k: string, v: string) {
      r.headers[k] = v;
    },
  }) as unknown as FakeRes & VercelResponse;
}

// production rate-limit guard -------------------------------------------------

describe("production rate-limit guard", () => {
  const savedEnv = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  afterEach(() => {
    Object.entries(savedEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  it("throws at module load in production when Upstash env vars are missing", async () => {
    vi.resetModules();
    process.env.VERCEL_ENV = "production";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    await expect(import("../_lib/middleware.js")).rejects.toThrow(
      /UPSTASH_REDIS_REST_URL/
    );
  });

  it("loads in production when Upstash env vars are set", async () => {
    vi.resetModules();
    process.env.VERCEL_ENV = "production";
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    await expect(import("../_lib/middleware.js")).resolves.toBeDefined();
  });

  it("keeps the in-memory fallback for local dev (VERCEL_ENV unset)", async () => {
    vi.resetModules();
    delete process.env.VERCEL_ENV;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await import("../_lib/middleware.js");
    const res = fakeRes();
    await expect(
      mod.checkRateLimit(
        fakeReq("POST", { "x-forwarded-for": "10.1.1.1" }),
        res
      )
    ).resolves.toBe(true);
  });

  it("keeps the in-memory fallback on preview deploys (VERCEL_ENV=preview)", async () => {
    vi.resetModules();
    process.env.VERCEL_ENV = "preview";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await import("../_lib/middleware.js");
    const res = fakeRes();
    await expect(
      mod.checkRateLimit(
        fakeReq("POST", { "x-forwarded-for": "10.1.1.2" }),
        res
      )
    ).resolves.toBe(true);
  });
});
