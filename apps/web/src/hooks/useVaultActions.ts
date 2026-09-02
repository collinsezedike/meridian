import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { APP_NETWORK } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { api, type ApiPosition } from "../lib/api";
import { useToastStore } from "../store/toast";
import { useSignAndSubmit } from "./useSignAndSubmit";
import { useTrustlines } from "./useTrustlines";
import { useBlendFaucet } from "./useBlendFaucet";
import { usePositionPolling } from "./usePositionPolling";
import { useTranslation } from "react-i18next";

export function useVaultActions() {
  const { t } = useTranslation();
  const { publicKey, network } = useWalletStore();
  const queryClient = useQueryClient();
  const { push } = useToastStore();
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);

  const { signAndSubmit, passphrase } = useSignAndSubmit();
  const { hasRequiredTrustlines, addTrustline } = useTrustlines();
  const { hasBlendUsdcBalance, fundFromBlendFaucet } = useBlendFaucet();
  const { startPolling } = usePositionPolling();

  async function deposit(
    amount: string,
    vaultId: string,
    asset: string,
    minSharesOut?: string
  ): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setIsDepositing(true);
    try {
      // Establish any missing trustline(s) first, silently, before the user
      // has any reason to expect more than one signature — same one-click,
      // two-signature shape as the faucet funding step below.
      const hasTrustlines = await hasRequiredTrustlines(publicKey, network);
      if (!hasTrustlines) {
        const ok = await addTrustline();
        if (!ok) return false;
      }

      // On testnet, automatically fund the wallet from Blend's faucet when the
      // user has no USDC balance.
      if (APP_NETWORK.network === "testnet") {
        const hasFunds = await hasBlendUsdcBalance(publicKey, network);
        if (!hasFunds) {
          const ok = await fundFromBlendFaucet(publicKey, network);
          if (!ok) return false;
        }
      }

      const { xdr } = await api.buildDeposit({
        walletAddress: publicKey,
        vaultId,
        amount,
        min_shares_out: minSharesOut,
      });
      await signAndSubmit(xdr);
      queryClient.invalidateQueries({ queryKey: ["positions", publicKey] });
      // Without this, the vault panel's TVL/APY keep serving their cached
      // value for up to staleTime (5 min) after a deposit actually lands.
      queryClient.invalidateQueries({ queryKey: ["vaults"] });
      push("success", `${t("vaultActions.deposited")} ${amount} ${asset}`);
      return true;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : t("vaultActions.depositFailed");
      push("error", msg);
      return false;
    } finally {
      setIsDepositing(false);
    }
  }

  async function withdraw(
    shares: string,
    vaultId: string,
    asset: string,
    minUsdcOut?: string
  ): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setIsWithdrawing(true);
    try {
      // Snapshot the current positions before any async work so the optimistic
      // update and poll have a consistent baseline.
      const positionsBefore = queryClient.getQueryData<ApiPosition[]>([
        "positions",
        publicKey,
      ]);
      const matchedBefore =
        positionsBefore?.find((p) => p.vaultId === vaultId) ??
        positionsBefore?.[0];
      const sharesBefore = matchedBefore?.shares ?? Infinity;
      const withdrawnShares = parseFloat(shares);

      const { xdr } = await api.buildWithdraw({
        walletAddress: publicKey,
        vaultId,
        shares,
        min_usdc_out: minUsdcOut,
      });

      await signAndSubmit(xdr);

      // Without this, the vault panel's TVL/APY keep serving their cached
      // value for up to staleTime (5 min) after a withdrawal actually lands.
      queryClient.invalidateQueries({ queryKey: ["vaults"] });

      // Optimistic update: partial withdrawal scales the position down in-place
      // so the position card stays visible with an approximate remaining balance.
      // Full withdrawal (or no prior data) clears the cache entirely.
      if (matchedBefore && withdrawnShares < sharesBefore) {
        const remainingRatio = (sharesBefore - withdrawnShares) / sharesBefore;
        queryClient.setQueryData(
          ["positions", publicKey],
          (positionsBefore ?? []).map((p) =>
            p === matchedBefore
              ? {
                  ...p,
                  shares: sharesBefore - withdrawnShares,
                  deposited: p.deposited * remainingRatio,
                }
              : p
          )
        );
      } else {
        queryClient.setQueryData(["positions", publicKey], []);
      }

      // Hand off to position polling - it re-checks every 3s, stops once
      // this withdrawal's live share count drops below sharesBefore, and
      // gives up after 30s.
      startPolling(vaultId, sharesBefore);

      push("success", `${t("vaultActions.withdrew")} ${shares} ${asset}`);
      return true;
    } catch (err) {
      push(
        "error",
        err instanceof Error ? err.message : t("vaultActions.withdrawalFailed")
      );
      return false;
    } finally {
      setIsWithdrawing(false);
    }
  }

  return {
    deposit,
    withdraw,
    isDepositing,
    isWithdrawing,
  };
}
