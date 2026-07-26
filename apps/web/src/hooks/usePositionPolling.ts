import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "../store/wallet";
import { api, type ApiPosition } from "../lib/api";
import { useToastStore } from "../store/toast";
import { useTranslation } from "react-i18next";

export function usePositionPolling() {
  const { t } = useTranslation();
  const { publicKey } = useWalletStore();
  const { push } = useToastStore();
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
      // it fall through to the success path below - undefined data would
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
          // This target's vault isn't in the latest fetch - wait for the
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

  // Hand off to the refetchInterval query above - it re-checks every 3s,
  // stops once this withdrawal's live share count drops below
  // sharesBefore, and gives up after 30s. Tracked in a Map keyed by
  // pollId (not a single ref) so a second concurrent withdrawal doesn't
  // clobber this one's exit condition. Activation is delayed by 3s to
  // match the original poll cadence (first check happens one interval
  // in, not immediately); the timeout id is tracked so it can be
  // cancelled on unmount instead of firing on a dead component.
  function startPolling(vaultId: string, sharesBefore: number) {
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
  }

  return { startPolling };
}
