import { USDC_ISSUER, MUSDC_ISSUER } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { api } from "../lib/api";
import { fetchBalances } from "../lib/horizonAccount";
import { useSignAndSubmit } from "./useSignAndSubmit";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

// A trustline just needs to exist (balance can be 0) to receive that asset,
// unlike hasBlendUsdcBalance which also requires a positive balance.
// Checked proactively before depositing so a first-time depositor's missing
// mUSDC (or USDC) trustline is established silently up front, instead of the
// deposit failing on-chain and the user having to notice and click a
// separate "Add Assets" step.
export async function hasRequiredTrustlines(
  publicKey: string,
  network: string
): Promise<boolean> {
  const usdcIssuer = USDC_ISSUER[network];
  const musdcIssuer = MUSDC_ISSUER[network];
  try {
    const account = await fetchBalances(publicKey, network);
    if (!account) return true;
    const hasTrustline = (code: string, issuer: string) =>
      account.balances.some(
        (b) => b.asset_code === code && b.asset_issuer === issuer
      );
    const hasUsdc = !usdcIssuer || hasTrustline("USDC", usdcIssuer);
    const hasMusdc = !musdcIssuer || hasTrustline("MUSDC", musdcIssuer);
    return hasUsdc && hasMusdc;
  } catch {
    return true;
  }
}

export function useTrustlines() {
  const { t } = useTranslation();
  const { publicKey } = useWalletStore();
  const { push } = useToastStore();
  const { signAndSubmit, passphrase } = useSignAndSubmit();

  async function addTrustline(): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    try {
      const { xdr } = await api.addTrustline(publicKey);
      await signAndSubmit(xdr);
      push("success", t("vaultActions.assetsAdded"));
      return true;
    } catch (err) {
      push(
        "error",
        err instanceof Error ? err.message : t("vaultActions.failedAssets")
      );
      return false;
    }
  }

  return { hasRequiredTrustlines, addTrustline };
}
