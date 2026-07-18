import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  STELLAR_NETWORKS,
  APP_NETWORK,
  USDC_ISSUER,
  MUSDC_ISSUER,
} from "@meridian/shared";
import { assertFaucetPayment } from "@meridian/stellar-sdk-helpers";
import { useWalletStore } from "../store/wallet";
import { signTransaction } from "../lib/wallet";
import { api, type ApiPosition } from "../lib/api";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

// Configurable so the faucet can be rotated or disabled without a code
// deploy; falls back to Blend's public testnet faucet.
const BLEND_FAUCET_URL =
  import.meta.env.VITE_BLEND_FAUCET_URL ??
  "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets";

function horizonUrlFor(network: string) {
  return network === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

async function fetchBalances(publicKey: string, network: string) {
  const res = await fetch(`${horizonUrlFor(network)}/accounts/${publicKey}`);
  if (!res.ok) return null;
  return (await res.json()) as {
    balances: {
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }[];
  };
}

async function hasBlendUsdcBalance(
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

// A trustline just needs to exist (balance can be 0) to receive that asset,
// unlike hasBlendUsdcBalance above which also requires a positive balance.
// Checked proactively before depositing so a first-time depositor's missing
// mUSDC (or USDC) trustline is established silently up front, instead of the
// deposit failing on-chain and the user having to notice and click a
// separate "Add Assets" step.
async function hasRequiredTrustlines(
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

export function useVaultActions() {
  const { t } = useTranslation();
  const { publicKey, network, revalidate } = useWalletStore();
  const queryClient = useQueryClient();
  const { push } = useToastStore();
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [isPollingPositions, setIsPollingPositions] = useState(false);

  // Keyed by a per-withdrawal id so concurrent withdrawals each track their
  // own exit condition instead of one overwriting another's poll target.
  const pollTargetsRef = useRef<
    Map<
      string,
      {
        vaultId: string;
        sharesBefore: number;
        startedAt: number;
        failures: number;
      }
    >
  >(new Map());

  // Tracks pending "start polling" timeouts (the 3s activation delay after a
  // withdrawal) so they can be cancelled on unmount instead of calling
  // setIsPollingPositions on an orphaned hook instance.
  const activationTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(
    new Set()
  );

  useEffect(() => {
    const timeouts = activationTimeoutsRef.current;
    return () => {
      for (const id of timeouts) {
        clearTimeout(id);
      }
      timeouts.clear();
    };
  }, []);

  useQuery<ApiPosition[]>({
    queryKey: ["positions", publicKey],
    queryFn: async () => {
      if (!publicKey) throw new Error("No public key");
      const data = await api.getPositions(publicKey);
      return data.positions;
    },
    enabled: isPollingPositions && !!publicKey,
    retry: false,

    refetchInterval: (query) => {
      const targets = pollTargetsRef.current;
      if (targets.size === 0) return false;

      // Before this observer's first fetch resolves, status is "pending"
      // and data is undefined. Skip the tick entirely rather than letting
      // it fall through to the success path below — undefined data would
      // otherwise look like every target's shares already dropped to zero,
      // deleting all targets on the very first tick.
      if (query.state.status === "pending") {
        return 3_000;
      }

      const isError = query.state.status === "error";
      const data = query.state.data;

      for (const [id, target] of targets) {
        if (Date.now() - target.startedAt > 30_000) {
          targets.delete(id);
          continue;
        }

        if (isError) {
          target.failures += 1;
          console.warn("[positions poll] failed, attempt", target.failures);
          if (target.failures === 3) {
            push("info", t("vaultActions.syncDelayed"));
          }
          continue;
        }
        target.failures = 0;

        const live = data?.find((p) => p.vaultId === target.vaultId);
        if (!live) {
          // This target's vault isn't in the latest fetch — wait for the
          // next tick instead of comparing against an unrelated position.
          continue;
        }
        if (live.shares < target.sharesBefore) {
          targets.delete(id);
        }
      }

      if (targets.size === 0) {
        setIsPollingPositions(false);
        return false;
      }

      return 3_000;
    },
  });
  const passphrase =
    STELLAR_NETWORKS[network as keyof typeof STELLAR_NETWORKS]?.passphrase;

  async function signAndSubmit(xdr: string) {
    await revalidate();
    if (!useWalletStore.getState().connected) {
      throw new Error(t("walletConnect.walletDisconnected"));
    }
    const signedXdr = await signTransaction(xdr, passphrase);
    await api.submitTx({ xdr: signedXdr });
  }

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

  // Calls Blend's testnet faucet to fund the wallet with test USDC before the
  // first deposit. Only triggered on testnet when the user has no USDC balance.
  // The faucet is a third-party endpoint outside Meridian's control, so the
  // returned transaction is validated before it is ever shown to Freighter:
  // every operation must credit the caller's own address in a known asset,
  // never debit it or touch anything else.
  async function fundFromBlendFaucet(): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    try {
      push("info", "Funding testnet wallet with Blend test USDC...");
      const res = await fetch(`${BLEND_FAUCET_URL}?userId=${publicKey}`);
      if (!res.ok) throw new Error(`Blend faucet returned ${res.status}`);
      const xdr = await res.text();
      assertFaucetPayment(xdr, passphrase, network, publicKey);
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

      // Hand off to the refetchInterval query above — it re-checks every 3s,
      // stops once this withdrawal's live share count drops below
      // sharesBefore, and gives up after 30s. Tracked in a Map keyed by
      // pollId (not a single ref) so a second concurrent withdrawal doesn't
      // clobber this one's exit condition. Activation is delayed by 3s to
      // match the original poll cadence (first check happens one interval
      // in, not immediately); the timeout id is tracked so it can be
      // cancelled on unmount instead of firing on a dead component.
      const pollId = crypto.randomUUID();
      pollTargetsRef.current.set(pollId, {
        vaultId,
        sharesBefore,
        startedAt: Date.now(),
        failures: 0,
      });
      const activationTimeoutId = setTimeout(() => {
        activationTimeoutsRef.current.delete(activationTimeoutId);
        setIsPollingPositions(true);
      }, 3_000);
      activationTimeoutsRef.current.add(activationTimeoutId);

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
