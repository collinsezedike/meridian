import { describe, it, expect, vi } from "vitest";
import {
  discoverLiveAdapters,
  loadBlendAccrualKeeperConfig,
  runBlendAccrualKeeper,
  type BlendAccrualKeeperConfig,
  type DiscoveredAdapter,
  type KeeperLogger,
} from "./accrual-keeper";
import type { KnownPoolMeta } from "./known-pools";

const NETWORK = {
  network: "testnet" as const,
  rpcUrl: "https://rpc.example",
  passphrase: "Test SDF Network ; September 2015",
};

const CONFIG: BlendAccrualKeeperConfig = {
  network: NETWORK,
  secretKey: "S".repeat(56),
  maxAttempts: 3,
  baseDelayMs: 1,
  rpcTimeoutMs: 100,
};

const VAULT: KnownPoolMeta = {
  id: "meridian-usdc",
  name: "Meridian",
  protocol: "meridian",
  label: "USDC Vault",
  contractId: "CVAULT",
};

const DIRECT_BLEND: KnownPoolMeta = {
  id: "blend-usdc-fixed",
  name: "Blend",
  protocol: "blend",
  label: "Fixed Pool",
  contractId: "CBLENDPOOL",
};

const BLEND_ADAPTER: DiscoveredAdapter = {
  vaultId: "meridian-usdc",
  vaultContractId: "CVAULT",
  adapterId: "CADAPTERBLEND",
  protocol: "blend",
};

const DEFINDEX_ADAPTER: DiscoveredAdapter = {
  vaultId: "meridian-eurc",
  vaultContractId: "CVAULT2",
  adapterId: "CADAPTERDFX",
  protocol: "defindex",
};

function logger(): KeeperLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("loadBlendAccrualKeeperConfig", () => {
  it("requires the signing key from the environment", () => {
    expect(() => loadBlendAccrualKeeperConfig({})).toThrow(
      "MERIDIAN_KEEPER_SECRET_KEY is required"
    );
  });

  it("loads retry tuning from environment variables", () => {
    const config = loadBlendAccrualKeeperConfig({
      MERIDIAN_KEEPER_SECRET_KEY: "SECRET",
      MERIDIAN_KEEPER_MAX_ATTEMPTS: "5",
      MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS: "250",
      MERIDIAN_KEEPER_RPC_TIMEOUT_MS: "9000",
    });

    expect(config.secretKey).toBe("SECRET");
    expect(config.maxAttempts).toBe(5);
    expect(config.baseDelayMs).toBe(250);
    expect(config.rpcTimeoutMs).toBe(9000);
  });
});

describe("discoverLiveAdapters", () => {
  it("discovers adapters from Meridian vaults without using direct Blend pool entries", async () => {
    const simulate = vi.fn(async (_server, contractId, _passphrase, method) => {
      if (contractId === "CVAULT" && method === "get_adapter")
        return "CADAPTER";
      if (contractId === "CADAPTER" && method === "get_protocol")
        return "blend";
      throw new Error(`unexpected call ${contractId}.${String(method)}`);
    });

    const result = await discoverLiveAdapters({
      network: NETWORK,
      server: {} as never,
      simulate: simulate as never,
      pools: {
        "meridian-usdc": VAULT,
        "blend-usdc-fixed": DIRECT_BLEND,
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.adapters).toEqual([
      {
        vaultId: "meridian-usdc",
        vaultContractId: "CVAULT",
        adapterId: "CADAPTER",
        protocol: "blend",
      },
    ]);
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it("records discovery failures instead of dropping them", async () => {
    const simulate = vi.fn(async () => {
      throw new Error("rpc timed out");
    });
    const result = await discoverLiveAdapters({
      network: NETWORK,
      server: {} as never,
      simulate: simulate as never,
      maxAttempts: 2,
      baseDelayMs: 1,
      sleep: vi.fn(),
      pools: { "meridian-usdc": VAULT },
    });

    expect(simulate).toHaveBeenCalledTimes(2);
    expect(result.adapters).toEqual([]);
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        vaultContractId: "CVAULT",
        stage: "discover",
        attempts: 2,
        transient: true,
        error: "rpc timed out",
      },
    ]);
  });
});

describe("runBlendAccrualKeeper", () => {
  it("submits accrue only for Blend-backed adapters", async () => {
    const submitAccrual = vi.fn(async () => ({ hash: "HASH", ledger: 123 }));
    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      sleep: vi.fn(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER, DEFINDEX_ADAPTER],
        failures: [],
      }),
      submitAccrual,
    });

    expect(submitAccrual).toHaveBeenCalledOnce();
    expect(submitAccrual).toHaveBeenCalledWith(BLEND_ADAPTER, 1);
    expect(result.successes).toEqual([
      {
        vaultId: "meridian-usdc",
        adapterId: "CADAPTERBLEND",
        hash: "HASH",
        ledger: 123,
        attempts: 1,
      },
    ]);
    expect(result.skipped).toEqual([
      { ...DEFINDEX_ADAPTER, reason: "non-blend" },
    ]);
  });

  it("retries transient submission failures and reports the successful attempt", async () => {
    const submitAccrual = vi
      .fn()
      .mockRejectedValueOnce(new Error("try again later"))
      .mockResolvedValueOnce({ hash: "HASH2", ledger: 456 });
    const log = logger();

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: log,
      sleep: vi.fn(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      submitAccrual,
    });

    expect(submitAccrual).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(result.failures).toEqual([]);
    expect(result.successes[0]).toMatchObject({ hash: "HASH2", attempts: 2 });
  });

  it("makes failed submissions observable in the run result and logs context", async () => {
    const log = logger();
    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: log,
      sleep: vi.fn(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      submitAccrual: vi.fn(async () => {
        throw new Error("contract trapped");
      }),
    });

    expect(result.successes).toEqual([]);
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        adapterId: "CADAPTERBLEND",
        protocol: "blend",
        stage: "submit",
        attempts: 1,
        transient: false,
        error: "contract trapped",
      },
    ]);
    expect(log.error).toHaveBeenCalledWith(
      "[accrual-keeper] accrue failed",
      expect.objectContaining({
        vaultId: "meridian-usdc",
        adapterId: "CADAPTERBLEND",
      })
    );
  });
});
