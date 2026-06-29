import {
  isConnected,
  requestAccess,
  signTransaction as freighterSign,
} from "@stellar/freighter-api";

export async function isFreighterInstalled(): Promise<boolean> {
  const result = await isConnected();
  return result.isConnected;
}

export async function connectFreighter(): Promise<string> {
  const result = await requestAccess();
  if (result.error) throw new Error(result.error.message);
  return result.address;
}

export async function signTransaction(
  xdr: string,
  networkPassphrase: string
): Promise<string> {
  const result = await freighterSign(xdr, { networkPassphrase });
  if (result.error) throw new Error(result.error.message);
  if (!result.signedTxXdr) throw new Error("Signing cancelled");
  return result.signedTxXdr;
}
