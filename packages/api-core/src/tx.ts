import {
  APP_NETWORK,
  DepositRequestSchema,
  WithdrawRequestSchema,
  TrustlineRequestSchema,
  SubmitRequestSchema,
  formatZodError,
  sanitizeTxError,
} from "@meridian/shared";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

export async function handleDepositRequest(
  body: unknown
): Promise<RouteResult> {
  const parsed = DepositRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const { walletAddress, vaultId, amount, min_shares_out } = parsed.data;
    const result = await buildDepositTx(
      vaultId,
      walletAddress,
      amount,
      APP_NETWORK,
      min_shares_out
    );
    return { status: 200, body: result };
  } catch (err) {
    return {
      status: 500,
      body: {
        error: sanitizeTxError(err, "Failed to build deposit transaction"),
      },
      error: err,
    };
  }
}

export async function handleWithdrawRequest(
  body: unknown
): Promise<RouteResult> {
  const parsed = WithdrawRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const { walletAddress, vaultId, shares, min_usdc_out } = parsed.data;
    const result = await buildWithdrawTx(
      vaultId,
      walletAddress,
      shares,
      APP_NETWORK,
      min_usdc_out
    );
    return { status: 200, body: result };
  } catch (err) {
    return {
      status: 500,
      body: {
        error: sanitizeTxError(err, "Failed to build withdraw transaction"),
      },
      error: err,
    };
  }
}

export async function handleAddTrustlineRequest(
  body: unknown
): Promise<RouteResult> {
  const parsed = TrustlineRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const result = await buildAddTrustlineTx(
      parsed.data.walletAddress,
      APP_NETWORK
    );
    return { status: 200, body: result };
  } catch (err) {
    return {
      status: 500,
      body: {
        error: sanitizeTxError(err, "Failed to build trustline transaction"),
      },
      error: err,
    };
  }
}

export async function handleSubmitRequest(body: unknown): Promise<RouteResult> {
  const parsed = SubmitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const result = await submitTx(parsed.data.xdr, APP_NETWORK);
    return { status: 200, body: result };
  } catch (err) {
    return {
      status: 500,
      body: { error: sanitizeTxError(err, "Failed to submit transaction") },
      error: err,
    };
  }
}
