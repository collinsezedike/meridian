import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

const STALE_TIME_MS = 30_000;

export function useVaultState() {
  return useQuery({
    queryKey: ["vault-state"],
    queryFn: () => api.getVaultState(),
    staleTime: STALE_TIME_MS,
    retry: 1,
  });
}
