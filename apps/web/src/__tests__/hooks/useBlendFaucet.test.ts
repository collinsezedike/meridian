import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  useBlendFaucet,
  hasBlendUsdcBalance,
} from "../../hooks/useBlendFaucet";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const BLEND_TESTNET_USDC_ISSUER =
  "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

vi.mock("../../lib/wallet", () => ({
  wallet: {
    sign: vi.fn(async () => "SIGNED_XDR"),
    isAuthorized: vi.fn(async () => true),
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    submitTx: vi.fn(async () => ({ hash: "TX_HASH" })),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { api } from "../../lib/api";
import { wallet } from "../../lib/wallet";

function usdcBalanceHorizonResponse(balance: string) {
  return new Response(
    JSON.stringify({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: BLEND_TESTNET_USDC_ISSUER,
          balance,
        },
      ],
    }),
    { status: 200 }
  );
}

function faucetTextResponse(op: ReturnType<typeof Operation.payment>) {
  const account = new Account(KEY, "0");
  const xdr = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
  return new Response(xdr, { status: 200 });
}

beforeEach(() => {
  useWalletStore.setState({
    publicKey: KEY,
    connected: true,
    network: "testnet",
  });
  useToastStore.setState({ toasts: [] });
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => usdcBalanceHorizonResponse("100.0000000"))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useBlendFaucet", () => {
  it("reports a positive USDC balance as funded", async () => {
    const result = await hasBlendUsdcBalance(KEY, "testnet");
    expect(result).toBe(true);
  });

  it("reports a zero USDC balance as not funded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => usdcBalanceHorizonResponse("0.0000000"))
    );
    const result = await hasBlendUsdcBalance(KEY, "testnet");
    expect(result).toBe(false);
  });

  it("signs a faucet transaction that credits the caller's own address", async () => {
    const legitimate = faucetTextResponse(
      Operation.payment({
        destination: KEY,
        asset: new Asset("USDC", BLEND_TESTNET_USDC_ISSUER),
        amount: "1000",
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => legitimate)
    );
    const { result } = renderHook(() => useBlendFaucet());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.fundFromBlendFaucet(KEY, "testnet");
    });

    expect(ok).toBe(true);
    expect(wallet.sign).toHaveBeenCalledTimes(1);
    expect(api.submitTx).toHaveBeenCalledWith({ xdr: "SIGNED_XDR" });
  });

  it("rejects a faucet transaction that pays out to someone else", async () => {
    const attacker = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
    const malicious = faucetTextResponse(
      Operation.payment({
        destination: attacker,
        asset: new Asset("USDC", BLEND_TESTNET_USDC_ISSUER),
        amount: "1000",
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => malicious)
    );
    const { result } = renderHook(() => useBlendFaucet());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.fundFromBlendFaucet(KEY, "testnet");
    });

    expect(ok).toBe(false);
    expect(wallet.sign).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({ kind: "error" })
    );
  });
});
