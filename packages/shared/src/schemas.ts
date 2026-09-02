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
