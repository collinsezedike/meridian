// Matches patterns that reveal internal deployment details: RPC URLs and
// Stellar contract (C-address) identifiers embedded in SDK error messages.
const INTERNAL_DETAIL = /https?:\/\/|C[A-Z2-7]{50,}/;

/**
 * Extracts a safe, first-line summary from an unknown catch value.
 * Strips multi-line SDK diagnostics, RPC URLs, and contract addresses.
 * Returns `fallback` when no clean message can be derived.
 */
export function sanitizeTxError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const first = err.message.split("\n")[0]?.trim();
  if (!first || INTERNAL_DETAIL.test(first)) return fallback;
  return first;
}

export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/** Returns true when `key` is a well-formed Stellar G-address (base32, 56 chars). */
export function isValidStellarAddress(key: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(key);
}

/**
 * Races `fn` against a timeout. Clears the timer if `fn` resolves first so no
 * handle lingers in the event loop after a successful call.
 */
export function withRaceTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    fn().then(
      (val) => {
        clearTimeout(handle);
        resolve(val);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      }
    );
  });
}

export interface RetryOptions {
  // Called right before sleeping ahead of a retry, purely for observability
  // (e.g. keeper logging). Has no control over whether the retry happens,
  // that's shouldRetry's job.
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  // Injectable for tests that want to skip real timers; defaults to a real
  // setTimeout-based delay.
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Retries `fn` up to `maxAttempts` times with exponential backoff starting at
 * `baseDelayMs`. Throws the last error when all attempts are exhausted.
 *
 * Pass `shouldRetry` to exclude certain errors from the retry loop — for
 * example, to avoid retrying a deadline-exceeded error while the previous
 * in-flight request is still running. `fn` and `shouldRetry` both receive the
 * zero-indexed attempt number; callers that don't need it can ignore the
 * parameter.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 200,
  shouldRetry: (err: unknown, attempt: number) => boolean = () => true,
  options: RetryOptions = {}
): Promise<T> {
  const sleep =
    options.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1 && shouldRetry(err, attempt)) {
        const delayMs = baseDelayMs * 2 ** attempt;
        options.onRetry?.(attempt, delayMs, err);
        await sleep(delayMs);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}
/**
 * Converts a stroops value to a decimal string.
 * 1 USDC = 10,000,000 stroops.
 */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const remainder = abs % 10_000_000n;
  const sign = negative ? "-" : "";
  if (remainder === 0n) return `${sign}${whole}`;
  const decimal = remainder.toString().padStart(7, "0").replace(/0+$/, "");
  return `${sign}${whole}.${decimal}`;
}
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats a number as a USD currency string.
 * e.g. 1234.5 -> "$1,234.50"
 */
export function formatUsdAmount(amount: number): string {
  if (!Number.isFinite(amount))
    throw new RangeError(`formatUsdAmount: invalid amount: ${amount}`);
  return USD_FORMATTER.format(amount);
}

/**
 * Parses a USD-formatted string back to a number.
 * Returns null for invalid or malformed input.

 */
export function parseUsdAmount(value: string): number | null {
  const stripped = value.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const match = stripped.match(/^-?[0-9]+(?:\.[0-9]+)?$/);
  if (!match) return null;
  return parseFloat(match[0]);
}
