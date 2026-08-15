// Shared retry/logging primitives for scheduled keepers (accrual, migration).
// Kept generic: transient-error classification is protocol/keeper-specific
// and is passed in by the caller rather than hardcoded here.

import { sanitizeTxError } from "@meridian/shared";

export interface KeeperLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const consoleLogger: KeeperLogger = {
  info(message, context) {
    console.info(message, context ?? {});
  },
  warn(message, context) {
    console.warn(message, context ?? {});
  },
  error(message, context) {
    console.error(message, context ?? {});
  },
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function errorMessage(err: unknown): string {
  if (err instanceof Error)
    return err.message.split("\n")[0]?.trim() || err.message;
  return String(err);
}

// For KeeperFailure.error specifically, not general logging: this value
// flows straight into /api/v1/keepers/{accrue,rebalance}'s JSON response,
// unlike errorMessage() above (used for internal log context, which stays
// verbose since it never leaves the server). Reuses the same RPC-URL/
// contract-address redaction the rest of the API already applies at its
// response boundaries (packages/api-core/src/tx.ts), so keeper failures
// aren't the one response shape in the codebase that skips it.
export function redactedErrorMessage(err: unknown): string {
  return sanitizeTxError(err, "Keeper operation failed");
}

function parseIntEnv(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  minimumLabel: string
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a ${minimumLabel} integer`);
  }
  return parsed;
}

export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  return parseIntEnv(value, fallback, name, 1, "positive");
}

export function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  return parseIntEnv(value, fallback, name, 0, "non-negative");
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  deadlineAt?: number;
}

// Common shape for a failed keeper operation, shared across every scheduled
// keeper (accrual, migration) so callers and API responses have one
// consistent structure to report against.
export interface KeeperFailure {
  vaultId?: string;
  vaultContractId?: string;
  adapterId?: string;
  protocol?: string;
  // "evaluate" is migration-keeper-specific (deciding whether a discovered
  // vault should migrate, distinct from finding it in the first place); the
  // accrual keeper only ever reports "discover" or "submit".
  stage: "discover" | "evaluate" | "submit";
  attempts: number;
  transient: boolean;
  error: string;
}

export class KeeperRetryError extends Error {
  readonly attempts: number;
  readonly transient: boolean;

  constructor(err: unknown, attempts: number, transient: boolean) {
    super(errorMessage(err));
    this.name = "KeeperRetryError";
    this.attempts = attempts;
    this.transient = transient;
  }
}

// A KeeperRetryError already carries the real attempt count and transience
// from the retry loop; anything else means the retry loop was never
// reached (e.g. a synchronous failure before the first attempt), which
// counts as a single attempt classified by the caller's own predicate.
export function retryOutcome(
  err: unknown,
  isTransient: (err: unknown) => boolean
): { attempts: number; transient: boolean } {
  if (err instanceof KeeperRetryError) {
    return { attempts: err.attempts, transient: err.transient };
  }
  return { attempts: 1, transient: isTransient(err) };
}

// Retries `fn` up to config.maxAttempts times with exponential backoff,
// classifying each failure via the caller-supplied `isTransient` predicate.
// A non-transient failure stops retrying immediately. When config.deadlineAt
// is set, a retry that would sleep past the deadline stops instead of
// sleeping into a doomed attempt, so a keeper bounded by a hard execution
// ceiling (e.g. Vercel's maxDuration) can return a clean partial result
// instead of being killed mid-retry.
export async function withKeeperRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig,
  logger: KeeperLogger,
  context: Record<string, unknown>,
  sleepFn: (ms: number) => Promise<void>,
  isTransient: (err: unknown) => boolean,
  logPrefix: string
): Promise<{ value: T; attempts: number }> {
  let lastErr: unknown;
  let attempts = 0;
  let transient = false;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    attempts = attempt;
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      lastErr = err;
      transient = isTransient(err);
      if (!transient || attempt >= config.maxAttempts) break;
      const delayMs = config.baseDelayMs * 2 ** (attempt - 1);
      if (
        config.deadlineAt !== undefined &&
        Date.now() + delayMs >= config.deadlineAt
      ) {
        logger.warn(
          `[${logPrefix}] stopping retries; run deadline approaching`,
          {
            ...context,
            attempt,
            delayMs,
          }
        );
        break;
      }
      logger.warn(`[${logPrefix}] transient failure; retrying`, {
        ...context,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error: errorMessage(err),
      });
      await sleepFn(delayMs);
    }
  }
  throw new KeeperRetryError(lastErr, attempts, transient);
}
