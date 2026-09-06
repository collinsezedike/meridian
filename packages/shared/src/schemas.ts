import { z } from "zod";
import { isValidStellarAddress } from "./utils";

const stellarAddress = z
  .string()
  .refine(isValidStellarAddress, { message: "Invalid Stellar public key" });

export const DepositRequestSchema = z.object({
  walletAddress: stellarAddress,
  vaultId: z.string(),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  // Minimum mUSDC shares the caller is willing to receive. The vault contract
  // rejects the deposit with SlippageExceeded if the minted shares fall below
  // this value. Expressed as a decimal string (e.g. "9.95"); converted to
  // stroops before the transaction is built. Defaults to "0" (no slippage
  // protection) when omitted.
  min_shares_out: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/)
    .optional()
    .default("0"),
  // The caller attests the wallet has explicitly acknowledged the deposit
  // risk-disclosure notice (#720), the smart-contract and adapter/protocol
  // risk warning shown before a wallet's first deposit into a vault.
  // Deliberately not satisfiable by already holding a position: `deposited`
  // in usePositions is current share value, not cost basis, so a wallet
  // that only ever received shares via a peer-to-peer transfer (#578) would
  // otherwise never have to acknowledge anything on its own first real
  // deposit. This does not cryptographically prove a human read the
  // notice, a caller can simply set it, but it closes the silent default
  // gap where any client, including one that never showed the notice at
  // all, could build a deposit with no acknowledgment of any kind. See
  // apps/web/src/components/dashboard/VaultPanel.tsx for where the
  // frontend derives this value.
  riskAcknowledged: z.literal(true),
});

export const WithdrawRequestSchema = z.object({
  walletAddress: stellarAddress,
  vaultId: z.string(),
  // Protocol share count to burn: bToken collateral for Blend, dfToken count
  // for DeFindex. Both come from `position.shares` in the frontend.
  shares: z.string().regex(/^\d+(\.\d{1,7})?$/),
  // Minimum USDC the caller is willing to receive. The vault contract rejects
  // the withdrawal with MinAmountOutNotMet if the redeemed amount falls below
  // this value. Expressed as a decimal string (e.g. "9.95"); converted to
  // stroops before the transaction is built. Defaults to "0" (no slippage
  // protection) when omitted.
  min_usdc_out: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/)
    .optional()
    .default("0"),
});

export const TrustlineRequestSchema = z.object({
  walletAddress: stellarAddress,
});

export const SubmitRequestSchema = z.object({
  xdr: z.string().min(1).max(10_000),
});

export type DepositRequest = z.infer<typeof DepositRequestSchema>;
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;
export type TrustlineRequest = z.infer<typeof TrustlineRequestSchema>;
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export function formatZodError(err: z.ZodError): string {
  const fields = err.flatten().fieldErrors as Record<
    string,
    string[] | undefined
  >;
  return (
    Object.entries(fields)
      .filter(([, v]) => v && v.length > 0)
      .map(([k, v]) => `${k}: ${v!.join(", ")}`)
      .join("; ") || "Invalid request"
  );
}
