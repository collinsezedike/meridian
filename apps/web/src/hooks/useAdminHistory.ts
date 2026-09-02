import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface AdminAction {
  id: string;
  type: string;
  timestamp: string;
  transactionHash: string;
  sourceAccount: string;
  summary: string;
  details: Record<string, unknown>;
}

export function useAdminHistory(vaultId: string | null) {
  return useQuery({
    queryKey: ["adminHistory", vaultId],
    queryFn: () => api.getAdminHistory(vaultId!),
    enabled: Boolean(vaultId),
    staleTime: 30_000,
    retry: 1,
  });
}
