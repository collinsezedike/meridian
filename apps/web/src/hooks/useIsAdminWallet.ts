import { useWalletStore } from "../store/wallet";

// Placeholder auth gate for the admin dashboard (#615), pending #614's real
// one. Client-side and address-based only: VITE_ vars are inlined into the
// public build (see environment-variables.md), so this keeps the dashboard
// out of a casual visitor's way without pretending to be real access
// control — the read endpoints it gates (keeper health, vault state) are
// already public data, same as /api/v1/vaults, so nothing sensitive is
// actually protected by this check.
const ADMIN_ADDRESSES: string[] = (
  (import.meta.env.VITE_ADMIN_ADDRESSES as string | undefined) ?? ""
)
  .split(",")
  .map((addr: string) => addr.trim())
  .filter(Boolean);

export function useIsAdminWallet(): boolean {
  const { publicKey } = useWalletStore();
  if (!publicKey) return false;
  return ADMIN_ADDRESSES.includes(publicKey);
}
