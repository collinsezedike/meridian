import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGIN;

const LIMIT = 100;
const WINDOW = "60 s";
const WINDOW_MS = 60_000;

// Vercel's Upstash integration provisions credentials under either store-prefixed or standard names
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ??
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ??
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

export const UPSTASH_CONFIGURED =
  Boolean(UPSTASH_URL) && Boolean(UPSTASH_TOKEN);

/**
 * Checks if production distributed Redis rate-limiting credentials are configured.
 */
export function isDistributedRateLimitingConfigured(): boolean {
  return UPSTASH_CONFIGURED;
}

const ratelimit = UPSTASH_CONFIGURED
  ? new Ratelimit({
      redis: new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! }),
      limiter: Ratelimit.slidingWindow(LIMIT, WINDOW),
    })
  : null;

const counts = new Map<string, { n: number; resetAt: number }>();

/** Clears all in-memory rate-limit buckets. Exposed for tests only. */
export function resetRateLimitForTesting(): void {
  counts.clear();
}

/**
 * Set CORS headers and handle preflight. Returns true when the request was a
 * preflight OPTIONS and has been fully handled — the caller should return
 * immediately in that case.
 */
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

function clientIp(req: VercelRequest): string {
  const vercelIp = req.headers["x-vercel-forwarded-for"];
  if (typeof vercelIp === "string" && vercelIp)
    return vercelIp.split(",")[0]?.trim() ?? vercelIp;

  const fwd = req.headers["x-forwarded-for"];
  return (
    (typeof fwd === "string" ? (fwd.split(",")[0]?.trim() ?? fwd) : null) ??
    req.socket?.remoteAddress ??
    "unknown"
  );
}

/**
 * Enforces strict distributed rate limiting for fund-moving or keeper endpoints.
 * Returns false and sends a 503 HTTP response if production Redis is missing.
 */
export function enforceStrictRateLimit(res: VercelResponse): boolean {
  const isProduction = process.env.VERCEL_ENV === "production";

  if (isProduction && !isDistributedRateLimitingConfigured()) {
    res.status(503).json({
      error:
        "Service Unavailable: Distributed rate limiting is required in production for this route.",
      code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
    });
    return false;
  }

  return true;
}

export interface RateLimitOptions {
  strict?: boolean;
}

/**
 * Check rate limit for the incoming request.
 * - If strict: true (fund-moving/keeper endpoints), returns 503 if Upstash is unconfigured in production.
 * - For non-strict routes (read-only), falls back to the in-memory rate limiter.
 * Writes a 429 or 503 response and returns false when blocked.
 */
export async function checkRateLimit(
  req: VercelRequest,
  res: VercelResponse,
  options: RateLimitOptions = {}
): Promise<boolean> {
  const { strict = false } = options;

  if (strict && !enforceStrictRateLimit(res)) {
    return false;
  }

  const ip = clientIp(req);

  if (ratelimit) {
    const { success } = await ratelimit.limit(ip);
    if (!success) {
      res
        .status(429)
        .json({ error: "Too many requests. Try again in a minute." });
      return false;
    }
    return true;
  }

  // In-memory fallback
  const now = Date.now();
  const entry = counts.get(ip);
  if (!entry || now > entry.resetAt) {
    counts.set(ip, { n: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.n >= LIMIT) {
    res
      .status(429)
      .json({ error: "Too many requests. Try again in a minute." });
    return false;
  }
  entry.n++;
  return true;
}

function authorizationHeader(req: VercelRequest): string | undefined {
  const raw = req.headers.authorization;
  return Array.isArray(raw) ? raw[0] : raw;
}

// Constant-time comparison: these endpoints authorize real signed
// transactions, so the bearer token check shouldn't leak timing information
// a network attacker could use to guess CRON_SECRET character-by-character.
// Both inputs are hashed to a fixed 32-byte digest first, so there's no
// length-based short-circuit before timingSafeEqual, a naive length check up
// front would itself leak the secret's length via timing before the
// constant-time comparison ever ran.
function safeCompare(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

// The one place "is CRON_SECRET effectively required right now" is
// defined. Both a handler's own pre-check (returning a distinct 503 for
// "not configured" before ever looking at the request) and
// isCronAuthorized's internal permissive-local-dev fallback need this same
// condition; deriving it independently in more than one place risks the
// two silently diverging.
export function isCronSecretConfigured(): boolean {
  return (
    Boolean(process.env.CRON_SECRET) || process.env.VERCEL_ENV === undefined
  );
}

/**
 * Authorizes a Vercel Cron-invoked endpoint via the shared CRON_SECRET
 * bearer token. Permissive only for true local dev (no VERCEL_ENV at all);
 * preview deployments have their own public URL and, unlike simple
 * rate-limit relaxation elsewhere, these endpoints trigger real signed
 * transactions off a funded keeper account, so an unauthenticated preview
 * caller could drain its balance (or, for the migration keeper, move a real
 * vault position) by spamming the endpoint. Preview and production both
 * require CRON_SECRET.
 */
export function isCronAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return isCronSecretConfigured();
  return safeCompare(authorizationHeader(req) ?? "", `Bearer ${secret}`);
}
