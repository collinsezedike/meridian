import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

// Short stale time: unlike vault APY/TVL this is an operational health
// signal, so the admin dashboard should notice a keeper going stale
// reasonably quickly rather than showing a 5-minute-old "healthy" badge.
const STALE_TIME_MS = 30_000;

export function useKeeperHealth() {
  return useQuery({
    queryKey: ["keeper-health"],
    queryFn: () => api.getKeeperHealth(),
    staleTime: STALE_TIME_MS,
    retry: 1,
  });
}
