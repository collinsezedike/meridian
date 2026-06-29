import { z } from "zod";
import { isValidStellarAddress } from "./utils";

const stellarAddress = z
  .string()
  .refine(isValidStellarAddress, { message: "Invalid Stellar public key" });

export const DepositRequestSchema = z.object({
  walletAddress: stellarAddress,
  vaultId: z.string(),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
});

export const WithdrawRequestSchema = z.object({
  walletAddress: stellarAddress,
  vaultId: z.string(),
  // Protocol share count to burn: bToken collateral for Blend, dfToken count
  // for DeFindex. Both come from `position.shares` in the frontend.
  shares: z.string().regex(/^\d+(\.\d{1,7})?$/),
});

export const TrustlineRequestSchema = z.object({
  walletAddress: stellarAddress,
});

export const SubmitRequestSchema = z.object({
  xdr: z.string().min(1),
});

export type DepositRequest = z.infer<typeof DepositRequestSchema>;
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;
export type TrustlineRequest = z.infer<typeof TrustlineRequestSchema>;
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export function formatZodError(err: z.ZodError): string {
  const fields = err.flatten().fieldErrors as Record<string, string[] | undefined>;
  return Object.entries(fields).filter(([, v]) => v && v.length > 0).map(([k, v]) => `${k}: ${v!.join(", ")}`).join("; ") || "Invalid request";
}
