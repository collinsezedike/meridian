import { assertFaucetPayment } from "@meridian/stellar-sdk-helpers";
import { USDC_ISSUER } from "@meridian/shared";
import { fetchBalances } from "../lib/horizonAccount";
import { useSignAndSubmit } from "./useSignAndSubmit";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

// Configurable so the faucet can be rotated or disabled without a code
// deploy; falls back to Blend's public testnet faucet.
const BLEND_FAUCET_URL =
  import.meta.env.VITE_BLEND_FAUCET_URL ??
  "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets";

export async function hasBlendUsdcBalance(
  publicKey: string,
  network: string
): Promise<boolean> {
  const issuer = USDC_ISSUER[network];
  if (!issuer) return true;
  try {
    const account = await fetchBalances(publicKey, network);
    if (!account) return true;
    return account.balances.some(
      (b) =>
        b.asset_code === "USDC" &&
        b.asset_issuer === issuer &&
        parseFloat(b.balance) > 0
    );
  } catch {
    return true;
  }
}

export function useBlendFaucet() {
  const { t } = useTranslation();
  const { push } = useToastStore();
  const { signAndSubmit, passphrase } = useSignAndSubmit();

  // Calls Blend's testnet faucet to fund the wallet with test USDC before the
  // first deposit. Only triggered on testnet when the user has no USDC balance.
  // The faucet is a third-party endpoint outside Meridian's control, so the
  // returned transaction is validated before it is ever shown to Freighter:
  // every operation must credit the caller's own address in a known asset,
  // never debit it or touch anything else.
  async function fundFromBlendFaucet(
    publicKey: string,
    network: string
  ): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    try {
      push("info", t("vaultActions.fundingWallet"));
      const res = await fetch(`${BLEND_FAUCET_URL}?userId=${publicKey}`);
      if (!res.ok) throw new Error(`Blend faucet returned ${res.status}`);
      const xdr = await res.text();
      assertFaucetPayment(xdr, passphrase, network, publicKey);
      await signAndSubmit(xdr);
      push("success", t("vaultActions.walletFunded"));
      return true;
    } catch (err) {
      push(
        "error",
        err instanceof Error ? err.message : t("vaultActions.faucetFailed")
      );
      return false;
    }
  }

  return { hasBlendUsdcBalance, fundFromBlendFaucet };
}
