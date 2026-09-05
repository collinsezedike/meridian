import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { fetchBalances, horizonUrlFor } from "../../lib/horizonAccount";

const PUBLIC_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("horizonUrlFor", () => {
  it('returns the Horizon mainnet URL for "mainnet"', () => {
    expect(horizonUrlFor("mainnet")).toBe("https://horizon.stellar.org");
  });

  it("returns the Horizon testnet URL for any other value", () => {
    expect(horizonUrlFor("testnet")).toBe(
      "https://horizon-testnet.stellar.org"
    );
    expect(horizonUrlFor("futurenet")).toBe(
      "https://horizon-testnet.stellar.org"
    );
  });
});

describe("fetchBalances", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves to null when the Horizon response isn't ok", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    await expect(fetchBalances(PUBLIC_KEY, "testnet")).resolves.toBeNull();
  });

  it("resolves to the parsed balances on a successful response", async () => {
    const balances = [{ asset_type: "native", balance: "100.0000000" }];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ balances }),
    } as Response);

    await expect(fetchBalances(PUBLIC_KEY, "mainnet")).resolves.toEqual({
      balances,
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://horizon.stellar.org/accounts/${PUBLIC_KEY}`
    );
  });
});
