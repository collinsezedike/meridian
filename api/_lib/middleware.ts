import type { VercelRequest, VercelResponse } from "@vercel/node";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGIN;

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

const LIMIT = 100;
const WINDOW = "60 s";
const WINDOW_MS = 60_000;

// Distributed sliding-window limiter via Upstash Redis when env vars are
// present. Falls back to in-memory per-process counting for local dev — the
// fallback is not shared across workers and should not be used in production.
const ratelimit =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(LIMIT, WINDOW),
      })
    : null;

const counts = new Map<string, { n: number; resetAt: number }>();

/** Clears all in-memory rate-limit buckets. Exposed for tests only. */
export function resetRateLimitForTesting(): void {
  counts.clear();
}

function clientIp(req: VercelRequest): string {
  // x-vercel-forwarded-for is set by the Vercel edge and cannot be spoofed
  // by the client, unlike x-forwarded-for which is client-controlled.
  const vercelIp = req.headers["x-vercel-forwarded-for"];
  if (typeof vercelIp === "string" && vercelIp)
    return vercelIp.split(",")[0]?.trim() ?? vercelIp;

  // Fallback for local dev (Fastify / pnpm dev) where Vercel headers are absent.
  const fwd = req.headers["x-forwarded-for"];
  return (
    (typeof fwd === "string" ? (fwd.split(",")[0]?.trim() ?? fwd) : null) ??
    req.socket?.remoteAddress ??
    "unknown"
  );
}

/**
 * Check the per-IP rate limit. Returns true when the request is allowed.
 * Writes a 429 response and returns false when the limit is exceeded — the
 * caller should return immediately.
 */
export async function checkRateLimit(
  req: VercelRequest,
  res: VercelResponse
): Promise<boolean> {
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
