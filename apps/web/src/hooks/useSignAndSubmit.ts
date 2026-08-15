import { STELLAR_NETWORKS } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { wallet } from "../lib/wallet";
import { api } from "../lib/api";
import { useTranslation } from "react-i18next";

export function useSignAndSubmit() {
  const { t } = useTranslation();
  const { network, revalidate } = useWalletStore();
  const passphrase =
    STELLAR_NETWORKS[network as keyof typeof STELLAR_NETWORKS]?.passphrase;

  async function signAndSubmit(xdr: string) {
    await revalidate();
    if (!useWalletStore.getState().connected) {
      throw new Error(t("walletConnect.walletDisconnected"));
    }
    const signedXdr = await wallet.sign(xdr, passphrase);
    await api.submitTx({ xdr: signedXdr });
  }

  return { signAndSubmit, passphrase };
}
