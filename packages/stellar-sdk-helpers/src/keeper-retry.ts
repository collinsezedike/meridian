// Shared retry/logging primitives for scheduled keepers (accrual, migration).
// Kept generic: transient-error classification is protocol/keeper-specific
// and is passed in by the caller rather than hardcoded here.

import { sanitizeTxError, withRetry } from "@meridian/shared";

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
//
// A thin, keeper-specific wrapper over the shared withRetry (@meridian/shared):
// the core retry/backoff loop lives in one place, this only adds what's
// keeper-specific on top (structured KeeperLogger logging, the deadline
// check, attempt-count tracking, and wrapping the final failure in a
// KeeperRetryError so retryOutcome() can recover it downstream).
export async function withKeeperRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig,
  logger: KeeperLogger,
  context: Record<string, unknown>,
  sleepFn: (ms: number) => Promise<void>,
  isTransient: (err: unknown) => boolean,
  logPrefix: string
): Promise<{ value: T; attempts: number }> {
  let attempts = 0;
  // Cached only alongside the exact error it was computed for, checked by
  // reference below, so reusing it can never go stale the way a bare
  // boolean flag once did: if the final thrown error is one shouldRetry
  // never saw (e.g. maxAttempts was exhausted, which withRetry doesn't call
  // shouldRetry for), the identity check fails below and isTransient(err) is
  // simply recomputed fresh instead of reusing a classification for a
  // different error.
  let lastClassifiedErr: unknown;
  let lastClassifiedTransient = false;

  // Folds the deadline check into shouldRetry (rather than a separate
  // control point in withRetry) so withRetry itself stays deadline-agnostic;
  // this is the one place that decides "no, don't retry" for a reason other
  // than the error itself, and logs why.
  const shouldRetry = (err: unknown, attempt: number): boolean => {
    lastClassifiedErr = err;
    lastClassifiedTransient = isTransient(err);
    if (!lastClassifiedTransient) return false;
    if (config.deadlineAt !== undefined) {
      const delayMs = config.baseDelayMs * 2 ** attempt;
      if (Date.now() + delayMs >= config.deadlineAt) {
        logger.warn(
          `[${logPrefix}] stopping retries; run deadline approaching`,
          { ...context, attempt: attempt + 1, delayMs }
        );
        return false;
      }
    }
    return true;
  };

  try {
    const value = await withRetry(
      async (attempt) => {
        attempts = attempt + 1;
        return fn(attempts);
      },
      config.maxAttempts,
      config.baseDelayMs,
      shouldRetry,
      {
        sleepFn,
        onRetry: (attempt, delayMs, err) => {
          logger.warn(`[${logPrefix}] transient failure; retrying`, {
            ...context,
            attempt: attempt + 1,
            nextAttempt: attempt + 2,
            delayMs,
            error: errorMessage(err),
          });
        },
      }
    );
    return { value, attempts };
  } catch (err) {
    const transient =
      err === lastClassifiedErr ? lastClassifiedTransient : isTransient(err);
    throw new KeeperRetryError(err, attempts || 1, transient);
  }
}
