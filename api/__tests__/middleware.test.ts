import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  applyCors,
  checkRateLimit,
  isCronAuthorized,
  isCronSecretConfigured,
  resetRateLimitForTesting,
} from "../_lib/middleware.js";

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

// ---------------------------------------------------------------------------------

beforeEach(() => resetRateLimitForTesting());
afterEach(() => vi.useRealTimers());

// applyCors -----------------------------------------------------------------------

describe("applyCors", () => {
  it("sets CORS headers on every request", () => {
    const res = fakeRes();
    applyCors(fakeReq("GET"), res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeDefined();
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("POST");
  });

  it("returns true and ends the response for OPTIONS preflight", () => {
    const res = fakeRes();
    const handled = applyCors(fakeReq("OPTIONS"), res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it("returns false and does not end the response for POST requests", () => {
    const res = fakeRes();
    const handled = applyCors(fakeReq("POST"), res);
    expect(handled).toBe(false);
    expect(res.ended).toBe(false);
  });
});

// checkRateLimit ------------------------------------------------------------------

describe("checkRateLimit", () => {
  it("allows the first 100 requests from the same IP", async () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < 100; i++) {
      const res = fakeRes();
      expect(
        await checkRateLimit(fakeReq("POST", { "x-forwarded-for": ip }), res)
      ).toBe(true);
      expect(res.statusCode).toBe(200);
    }
  });

  it("blocks the 101st request with 429", async () => {
    const ip = "1.2.3.5";
    for (let i = 0; i < 100; i++) {
      await checkRateLimit(
        fakeReq("POST", { "x-forwarded-for": ip }),
        fakeRes()
      );
    }
    const res = fakeRes();
    expect(
      await checkRateLimit(fakeReq("POST", { "x-forwarded-for": ip }), res)
    ).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it("resets the counter after the 60 s window expires", async () => {
    vi.useFakeTimers();
    const ip = "1.2.3.6";
    for (let i = 0; i < 100; i++) {
      await checkRateLimit(
        fakeReq("POST", { "x-forwarded-for": ip }),
        fakeRes()
      );
    }
    // Advance past the 60 s window.
    vi.advanceTimersByTime(61_000);
    const res = fakeRes();
    expect(
      await checkRateLimit(fakeReq("POST", { "x-forwarded-for": ip }), res)
    ).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("tracks two different IPs independently", async () => {
    const ipA = "10.0.0.1";
    const ipB = "10.0.0.2";
    for (let i = 0; i < 100; i++) {
      await checkRateLimit(
        fakeReq("POST", { "x-forwarded-for": ipA }),
        fakeRes()
      );
    }
    // ipA is blocked but ipB should still be allowed.
    const resA = fakeRes();
    expect(
      await checkRateLimit(fakeReq("POST", { "x-forwarded-for": ipA }), resA)
    ).toBe(false);
    const resB = fakeRes();
    expect(
      await checkRateLimit(fakeReq("POST", { "x-forwarded-for": ipB }), resB)
    ).toBe(true);
  });

  it("uses x-vercel-forwarded-for over x-forwarded-for when both are present", async () => {
    const vercelIp = "5.6.7.8";
    const fwdIp = "9.9.9.9";
    for (let i = 0; i < 100; i++) {
      await checkRateLimit(
        fakeReq("POST", {
          "x-vercel-forwarded-for": vercelIp,
          "x-forwarded-for": fwdIp,
        }),
        fakeRes()
      );
    }
    // vercelIp bucket is full — requests with that header should be blocked
    const resBlocked = fakeRes();
    expect(
      await checkRateLimit(
        fakeReq("POST", {
          "x-vercel-forwarded-for": vercelIp,
          "x-forwarded-for": fwdIp,
        }),
        resBlocked
      )
    ).toBe(false);
    expect(resBlocked.statusCode).toBe(429);

    // fwdIp bucket is untouched — requests without x-vercel-forwarded-for should still pass
    const resAllowed = fakeRes();
    expect(
      await checkRateLimit(
        fakeReq("POST", { "x-forwarded-for": fwdIp }),
        resAllowed
      )
    ).toBe(true);
  });
});

describe("isCronSecretConfigured / isCronAuthorized", () => {
  const savedCronSecret = process.env.CRON_SECRET;
  const savedVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (savedCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedCronSecret;
    if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = savedVercelEnv;
  });

  it("is configured when CRON_SECRET is set, regardless of environment", () => {
    process.env.CRON_SECRET = "s3cr3t";
    process.env.VERCEL_ENV = "production";
    expect(isCronSecretConfigured()).toBe(true);
  });

  it("is configured in true local dev even without CRON_SECRET", () => {
    delete process.env.CRON_SECRET;
    delete process.env.VERCEL_ENV;
    expect(isCronSecretConfigured()).toBe(true);
  });

  it("is not configured when CRON_SECRET is missing outside local dev", () => {
    delete process.env.CRON_SECRET;
    process.env.VERCEL_ENV = "preview";
    expect(isCronSecretConfigured()).toBe(false);
  });

  it("authorizes a request with the correct bearer token", () => {
    process.env.CRON_SECRET = "s3cr3t";
    expect(
      isCronAuthorized(fakeReq("GET", { authorization: "Bearer s3cr3t" }))
    ).toBe(true);
  });

  it("rejects a request with the wrong bearer token", () => {
    process.env.CRON_SECRET = "s3cr3t";
    expect(
      isCronAuthorized(fakeReq("GET", { authorization: "Bearer wrong" }))
    ).toBe(false);
  });
});
