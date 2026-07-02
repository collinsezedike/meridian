import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { STELLAR_NETWORKS, APP_NETWORK, USDC_ISSUER } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { signTransaction } from "../lib/wallet";
import { api, type ApiPosition } from "../lib/api";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

const BLEND_FAUCET_URL =
  "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets";

function isMissingTrustline(msg: string) {
  return msg.toLowerCase().includes("trustline");
}

async function hasBlendUsdcBalance(
  publicKey: string,
  network: string
): Promise<boolean> {
  const horizonUrl =
    network === "mainnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org";
  const issuer = USDC_ISSUER[network];
  if (!issuer) return true;
  try {
    const res = await fetch(`${horizonUrl}/accounts/${publicKey}`);
    if (!res.ok) return true;
    const account = (await res.json()) as {
      balances: {
        asset_type: string;
        asset_code?: string;
        asset_issuer?: string;
        balance: string;
      }[];
    };
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

export function useVaultActions() {
  const { t } = useTranslation();
  const { publicKey, network } = useWalletStore();
  const queryClient = useQueryClient();
  const { push } = useToastStore();
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [needsTrustline, setNeedsTrustline] = useState(false);

  const passphrase =
    STELLAR_NETWORKS[network as keyof typeof STELLAR_NETWORKS]?.passphrase;

  async function signAndSubmit(xdr: string) {
    const signedXdr = await signTransaction(xdr, passphrase);
    await api.submitTx({ xdr: signedXdr });
  }

  async function addTrustline(): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    try {
      const { xdr } = await api.addTrustline(publicKey);
      await signAndSubmit(xdr);
      setNeedsTrustline(false);
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

  // Calls Blend's testnet faucet to fund the wallet with test USDC before the
  // first deposit. Only triggered on testnet when the user has no USDC balance.
  async function fundFromBlendFaucet(): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    try {
      push("info", "Funding testnet wallet with Blend test USDC...");
      const res = await fetch(`${BLEND_FAUCET_URL}?userId=${publicKey}`);
      if (!res.ok) throw new Error(`Blend faucet returned ${res.status}`);
      const xdr = await res.text();
      await signAndSubmit(xdr);
      push("success", "Testnet wallet funded");
      return true;
    } catch (err) {
      push(
        "error",
        err instanceof Error ? err.message : "Failed to fund testnet wallet"
      );
      return false;
    }
  }

  async function deposit(
    amount: string,
    vaultId: string,
    asset: string
  ): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setIsDepositing(true);
    try {
      // On testnet, automatically fund the wallet from Blend's faucet when the
      // user has no USDC balance. Covers both missing trustline and zero balance.
      if (APP_NETWORK.network === "testnet") {
        const hasFunds = await hasBlendUsdcBalance(publicKey, network);
        if (!hasFunds) {
          const ok = await fundFromBlendFaucet();
          if (!ok) return false;
        }
      }

      const { xdr } = await api.buildDeposit({
        walletAddress: publicKey,
        vaultId,
        amount,
      });
      await signAndSubmit(xdr);
      setNeedsTrustline(false);
      queryClient.invalidateQueries({ queryKey: ["positions", publicKey] });
      push("success", `${t("vaultActions.deposited")} ${amount} ${asset}`);
      return true;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : t("vaultActions.depositFailed");
      if (isMissingTrustline(msg)) {
        setNeedsTrustline(true);
      }
      push("error", msg);
      return false;
    } finally {
      setIsDepositing(false);
    }
  }

  async function withdraw(
    shares: string,
    vaultId: string,
    asset: string
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
      });

      await signAndSubmit(xdr);

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

      // Poll every 3 s until the RPC reflects the new ledger state, then write
      // the real data into the cache. Give up after 30 s.
      const key = publicKey;
      const startedAt = Date.now();
      const syncWhenReady = async (): Promise<void> => {
        if (Date.now() - startedAt > 30_000) return;
        try {
          const data = await api.getPositions(key);
          const live =
            data.positions.find((p) => p.vaultId === vaultId) ??
            data.positions[0];
          if ((live?.shares ?? 0) < sharesBefore) {
            queryClient.setQueryData(["positions", key], data.positions);
            return;
          }
        } catch {
          // network error — retry next tick
        }
        setTimeout(() => void syncWhenReady(), 3_000);
      };
      setTimeout(() => void syncWhenReady(), 3_000);
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
    addTrustline,
    needsTrustline,
    isDepositing,
    isWithdrawing,
    clearNeedsTrustline: () => setNeedsTrustline(false),
  };
}
