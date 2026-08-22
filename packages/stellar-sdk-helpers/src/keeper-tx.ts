// Shared transaction-submission primitives for scheduled keepers (accrual,
// migration): building, signing, and sending a single contract invocation
// from the keeper's own key, with in-flight tracking so a confirmation
// timeout on retry never causes a duplicate on-chain call.

import {
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { withRaceTimeout } from "@meridian/shared";
import { BASE_FEE } from "./internal";
import {
  describeSendError,
  simErrorMessage,
  simulateView,
  waitForTransaction,
} from "./tx";
import type { StellarNetwork } from "./types";
import { errorMessage } from "./keeper-retry";

// A real rpc.Server satisfies this directly (no cast needed); a narrower
// Pick instead of the hand-written interface this used to be means the
// signatures can never silently drift from the real SDK's.
export type KeeperRpcServer = Pick<
  rpc.Server,
  "getAccount" | "simulateTransaction" | "sendTransaction" | "getTransaction"
>;

// Thrown when a transaction was successfully sent (we have its hash) but
// confirmation couldn't be observed before the configured timeout elapsed.
// Carries the hash so a retry can check whether it actually landed before
// ever submitting a second, duplicate call, distinct from a failure before
// sendTransaction, where nothing was submitted and a fresh attempt is
// always safe.
export class SubmissionInFlightError extends Error {
  constructor(
    readonly sentHash: string,
    cause: unknown
  ) {
    super(errorMessage(cause));
    this.name = "SubmissionInFlightError";
  }
}

// Unlike errorMessage() (first line only, for concise logging/display), this
// keeps the full message for transient-error classification: a status code
// or keyword on a later line (e.g. a wrapped fetch error whose first line is
// generic) would otherwise be invisible to callers classifying an error.
export function rawErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// waitForTransaction (tx.ts) throws two meaningfully different errors:
// "Transaction X failed on-chain" (the network confirmed it, a permanent,
// known outcome) vs. "Timed out waiting for transaction X to confirm" (the
// client gave up, the real outcome is still unknown). Only the second is
// worth treating as transient/retryable-by-rechecking; the first means
// resubmitting would just fail the same way again (or waste a fee finding
// out), and should be reported as a definitive submit failure instead.
export function isDefinitiveOnChainFailure(err: unknown): boolean {
  return rawErrorText(err).includes("failed on-chain");
}

// Thrown when a prior attempt's transaction was confirmed as genuinely
// failed on-chain (not merely unconfirmed/timed out). Always non-transient:
// retrying would resubmit a fresh transaction that has no reason to succeed
// where the first one didn't.
export class SubmissionFailedError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "SubmissionFailedError";
  }
}

// HTTP status codes are matched with word boundaries so a permanent error
// whose message happens to contain those digits elsewhere (e.g. an amount or
// ledger number) isn't misclassified as transient.
const TRANSIENT_STATUS_CODE = /\b(429|500|502|503|504)\b/;

// Shared transient-error classification for keeper submission/discovery
// retries. A confirmed on-chain failure is explicitly never transient,
// regardless of what its message text happens to contain; an in-flight
// submission always is, since its real outcome just isn't known yet.
export function isTransientKeeperError(err: unknown): boolean {
  if (err instanceof SubmissionFailedError) return false;
  if (err instanceof SubmissionInFlightError) return true;
  const message = rawErrorText(err).toLowerCase();
  return (
    message.includes("try again") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("temporarily") ||
    TRANSIENT_STATUS_CODE.test(message)
  );
}

// simulateView returns unknown (a decoded ScVal), which can be null or a
// non-string value depending on how the contract's return type decodes.
// Address/Symbol-returning view methods are documented to decode to a
// string; anything else means the on-chain return type didn't match, and
// using it as a contract ID would otherwise surface as a confusing
// low-level `Contract` constructor error instead of this clear one.
export function expectString(
  value: unknown,
  method: string,
  contractId: string
): string {
  if (typeof value !== "string") {
    throw new Error(
      `${method}() on ${contractId} did not return a string (got ${typeof value})`
    );
  }
  return value;
}

// Thrown by the stale-adapter guard below: the caller's view of which
// adapter a vault is using is out of date, something else already changed
// it. Shared by both keepers: the migration keeper uses it to avoid
// migrating off an adapter the vault no longer has, and the accrual keeper
// to avoid accruing on an adapter the vault has already migrated away from
// (a silently ineffective call, since a detached adapter is still a valid
// contract). Both treat it as a benign, expected race, a skip rather than a
// failure.
//
// Detected downstream by message text, not `instanceof`: withKeeperRetry
// wraps whatever it catches in a KeeperRetryError (keeper-retry.ts), which
// preserves the message but not the original error's type. Same approach
// isDefinitiveOnChainFailure already uses for the equivalent problem.
export const STALE_ADAPTER_MESSAGE = "Vault's adapter changed since discovery";

export class StaleAdapterError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `${STALE_ADAPTER_MESSAGE} (expected ${expected}, now ${actual}); skipping to avoid a stale call`
    );
    this.name = "StaleAdapterError";
  }
}

export function isStaleAdapterError(err: unknown): boolean {
  return errorMessage(err).includes(STALE_ADAPTER_MESSAGE);
}

/**
 * Re-reads the vault's live `get_adapter()` and throws StaleAdapterError if
 * it no longer matches what this run discovered. A cheap, best-effort guard
 * that narrows, but cannot close, the window between deciding to act on an
 * adapter and the transaction landing: it catches the common case of "a
 * prior run already changed this vault's adapter" for one simulate call.
 */
export async function assertAdapterUnchanged(
  server: KeeperRpcServer,
  vaultContractId: string,
  networkPassphrase: string,
  expectedAdapterId: string
): Promise<void> {
  const liveAdapterId = expectString(
    await simulateView(
      server as never,
      vaultContractId,
      networkPassphrase,
      "get_adapter"
    ),
    "get_adapter",
    vaultContractId
  );
  if (liveAdapterId !== expectedAdapterId) {
    throw new StaleAdapterError(expectedAdapterId, liveAdapterId);
  }
}

// Lifecycle hooks around the one moment that matters for cross-invocation
// dedup: `onSubmitted` fires immediately after a transaction is broadcast
// and a hash exists (never before, so a crash mid-build leaves no record
// behind), `onResolved` once that hash's fate is known, success or a
// definitive on-chain failure. Both are invoked defensively: a throwing hook
// must never surface as a submission error, since the retry loop would
// answer that by broadcasting a second transaction, exactly the duplicate
// the hooks exist to prevent. Implementations are expected to log their own
// failures (see keeper-state.ts).
export interface KeeperSubmissionHooks {
  onSubmitted?: (hash: string) => Promise<void>;
  onResolved?: (hash: string) => Promise<void>;
}

async function runHook(
  hook: ((hash: string) => Promise<void>) | undefined,
  hash: string
): Promise<void> {
  if (!hook) return;
  try {
    await hook(hash);
  } catch {
    // Deliberately swallowed, see KeeperSubmissionHooks above.
  }
}

export interface KeeperTxConfig {
  network: StellarNetwork;
  secretKey: string;
  rpcTimeoutMs: number;
  confirmationTimeoutMs: number;
}

// Builds, signs, and submits a single contract invocation from the keeper's
// own key. When `priorHash` is set (an earlier attempt already sent a
// transaction), this checks that transaction's real status first instead of
// building a new one: it never falls through to building a fresh
// transaction on this call, only re-throws to keep tracking the *same* hash,
// until the prior transaction's fate is actually known (confirmed success or
// confirmed on-chain failure). Callers must persist `priorHash` across their
// own retry attempts (see accrual-keeper.ts and migration-keeper.ts), and
// persist it across invocations through `hooks` (see keeper-state.ts).
export async function submitKeeperOperation(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  config: KeeperTxConfig,
  server: KeeperRpcServer,
  priorHash?: string,
  hooks?: KeeperSubmissionHooks
): Promise<{ hash: string; ledger: number }> {
  if (priorHash) {
    try {
      const confirmed = await waitForTransaction(server, priorHash, {
        timeoutMs: config.confirmationTimeoutMs,
      });
      await runHook(hooks?.onResolved, priorHash);
      return { hash: priorHash, ledger: confirmed.ledger };
    } catch (err) {
      if (isDefinitiveOnChainFailure(err)) {
        await runHook(hooks?.onResolved, priorHash);
        throw new SubmissionFailedError(err);
      }
      throw new SubmissionInFlightError(priorHash, err);
    }
  }

  const keypair = Keypair.fromSecret(config.secretKey);
  const source = await withRaceTimeout(
    () => server.getAccount(keypair.publicKey()),
    config.rpcTimeoutMs,
    "Soroban RPC"
  );
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: config.network.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(300)
    .build();

  const sim = await withRaceTimeout(
    () => server.simulateTransaction(tx),
    config.rpcTimeoutMs,
    "Soroban RPC"
  );
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${simErrorMessage(sim.error)}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("Simulation did not return a successful result");
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);

  const sent = await withRaceTimeout(
    () => server.sendTransaction(prepared),
    config.rpcTimeoutMs,
    "Soroban RPC"
  );
  if (sent.status === "ERROR") {
    throw new Error(
      `Transaction rejected at submission: ${describeSendError(sent)}`
    );
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new Error("Transaction could not be submitted yet (try again later)");
  }

  // The transaction is out; from here on a second one would be a duplicate.
  // Recorded before waiting for confirmation, not after, precisely because
  // the wait is what times out.
  await runHook(hooks?.onSubmitted, sent.hash);

  try {
    const confirmed = await waitForTransaction(server, sent.hash, {
      timeoutMs: config.confirmationTimeoutMs,
    });
    await runHook(hooks?.onResolved, sent.hash);
    return { hash: sent.hash, ledger: confirmed.ledger };
  } catch (err) {
    if (isDefinitiveOnChainFailure(err)) {
      await runHook(hooks?.onResolved, sent.hash);
      throw new SubmissionFailedError(err);
    }
    throw new SubmissionInFlightError(sent.hash, err);
  }
}
