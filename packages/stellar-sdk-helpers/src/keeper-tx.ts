// Shared transaction-submission primitives for scheduled keepers (accrual,
// migration): building, signing, and sending a single contract invocation
// from the keeper's own key, with in-flight tracking so a confirmation
// timeout on retry never causes a duplicate on-chain call.

import {
  Account,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { withRaceTimeout } from "@meridian/shared";
import { BASE_FEE } from "./internal";
import { describeSendError, simErrorMessage, waitForTransaction } from "./tx";
import type { StellarNetwork } from "./types";
import { errorMessage } from "./keeper-retry";

export interface KeeperRpcServer {
  getAccount(publicKey: string): Promise<Account>;
  simulateTransaction(
    tx: Transaction
  ): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

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
// own retry attempts (see accrual-keeper.ts and migration-keeper.ts).
export async function submitKeeperOperation(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  config: KeeperTxConfig,
  server: KeeperRpcServer,
  priorHash?: string
): Promise<{ hash: string; ledger: number }> {
  if (priorHash) {
    try {
      const confirmed = await waitForTransaction(server, priorHash, {
        timeoutMs: config.confirmationTimeoutMs,
      });
      return { hash: priorHash, ledger: confirmed.ledger };
    } catch (err) {
      if (isDefinitiveOnChainFailure(err)) {
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

  try {
    const confirmed = await waitForTransaction(server, sent.hash, {
      timeoutMs: config.confirmationTimeoutMs,
    });
    return { hash: sent.hash, ledger: confirmed.ledger };
  } catch (err) {
    if (isDefinitiveOnChainFailure(err)) {
      throw new SubmissionFailedError(err);
    }
    throw new SubmissionInFlightError(sent.hash, err);
  }
}
