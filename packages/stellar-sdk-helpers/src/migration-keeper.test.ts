import { beforeEach, describe, expect, it, vi } from "vitest";

const stellarMocks = vi.hoisted(() => ({
  assembleTransaction: vi.fn(),
  getRpcServer: vi.fn(),
  isSimulationError: vi.fn(),
  isSimulationSuccess: vi.fn(),
  keypairFromSecret: vi.fn(),
  signPrepared: vi.fn(),
  simulateView: vi.fn(),
  waitForTransaction: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", () => {
  class Contract {
    constructor(readonly contractId: string) {}

    call(method: string, ...args: unknown[]) {
      return { contractId: this.contractId, method, args };
    }
  }

  class TransactionBuilder {
    private readonly operations: unknown[] = [];
    private timeout = 0;

    constructor(
      private readonly source: unknown,
      private readonly options: unknown
    ) {}

    addOperation(operation: unknown) {
      this.operations.push(operation);
      return this;
    }

    setTimeout(timeout: number) {
      this.timeout = timeout;
      return this;
    }

    build() {
      return {
        operations: this.operations,
        options: this.options,
        sign: stellarMocks.signPrepared,
        source: this.source,
        timeout: this.timeout,
      };
    }
  }

  return {
    Account: class Account {},
    Address: {
      fromString: (address: string) => ({
        toScVal: () => ({ scAddress: address }),
      }),
    },
    Contract,
    Keypair: {
      fromSecret: stellarMocks.keypairFromSecret,
    },
    nativeToScVal: (value: unknown, opts: unknown) => ({ value, opts }),
    Transaction: class Transaction {},
    TransactionBuilder,
    rpc: {
      Api: {
        isSimulationError: stellarMocks.isSimulationError,
        isSimulationSuccess: stellarMocks.isSimulationSuccess,
      },
      assembleTransaction: stellarMocks.assembleTransaction,
    },
  };
});

vi.mock("./internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./internal")>();
  return {
    ...actual,
    getRpcServer: stellarMocks.getRpcServer,
  };
});

vi.mock("./tx", () => ({
  describeSendError: (res: {
    errorResult?: { result(): { switch(): { name: string } } };
  }) => {
    try {
      return res.errorResult?.result().switch().name ?? "unknown error";
    } catch {
      return "unknown error";
    }
  },
  simErrorMessage: (error: unknown) => String(error),
  simulateView: stellarMocks.simulateView,
  waitForTransaction: stellarMocks.waitForTransaction,
}));

import {
  discoverMigrationVaults,
  loadMigrationKeeperConfig,
  runMigrationKeeper,
  type DiscoveredVault,
  type MigrationKeeperConfig,
} from "./migration-keeper";
import type { KeeperLogger } from "./keeper-retry";
import type { KnownPoolMeta } from "./known-pools";

const NETWORK = {
  network: "testnet" as const,
  rpcUrl: "https://rpc.example",
  passphrase: "Test SDF Network ; September 2015",
};

const CONFIG: MigrationKeeperConfig = {
  network: NETWORK,
  secretKey: "S".repeat(56),
  maxAttempts: 3,
  baseDelayMs: 1,
  rpcTimeoutMs: 100,
  minImprovementBps: 50,
  maxSlippageBps: 100,
  candidateAdapters: { defindex: "CDEFINDEXADAPTER" },
};

const VAULT: KnownPoolMeta = {
  id: "meridian-usdc",
  name: "Meridian",
  protocol: "meridian",
  label: "USDC Vault",
  contractId: "CVAULT",
};

const DISCOVERED_VAULT: DiscoveredVault = {
  vaultId: "meridian-usdc",
  vaultContractId: "CVAULT",
  currentAdapterId: "CBLENDADAPTER",
  currentProtocol: "blend",
  currentPoolId: "CBLENDPOOL",
};

function logger(): KeeperLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeServer(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: vi.fn(async () => ({ accountId: "GADMIN" })),
    getTransaction: vi.fn(),
    sendTransaction: vi.fn(async () => ({ hash: "HASH", status: "PENDING" })),
    simulateTransaction: vi.fn(async () => ({ kind: "success" })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  stellarMocks.getRpcServer.mockReturnValue(makeServer());
  stellarMocks.keypairFromSecret.mockReturnValue({
    publicKey: vi.fn(() => "GADMIN"),
  });
  stellarMocks.isSimulationError.mockReturnValue(false);
  stellarMocks.isSimulationSuccess.mockReturnValue(true);
  stellarMocks.assembleTransaction.mockReturnValue({
    build: () => ({ sign: stellarMocks.signPrepared }),
  });
});

describe("loadMigrationKeeperConfig", () => {
  it("throws when MERIDIAN_MIGRATION_KEEPER_SECRET_KEY is missing", () => {
    expect(() => loadMigrationKeeperConfig({})).toThrow(
      "MERIDIAN_MIGRATION_KEEPER_SECRET_KEY is required"
    );
  });

  it("rejects an unlimited (10_000 bps) max slippage as never allowed in automated operation", () => {
    expect(() =>
      loadMigrationKeeperConfig({
        MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "S".repeat(56),
        MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS: "10000",
      })
    ).toThrow(/never allowed in automated operation/);
  });

  it("accepts the max allowed slippage just below the unlimited value", () => {
    const config = loadMigrationKeeperConfig({
      MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "S".repeat(56),
      MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS: "9999",
    });
    expect(config.maxSlippageBps).toBe(9999);
  });

  it("defaults to a tight 100 bps slippage and 50 bps improvement threshold", () => {
    const config = loadMigrationKeeperConfig({
      MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "S".repeat(56),
    });
    expect(config.maxSlippageBps).toBe(100);
    expect(config.minImprovementBps).toBe(50);
  });

  it("reads an explicit MERIDIAN_ADAPTER_<PROTOCOL>_ID override", () => {
    const config = loadMigrationKeeperConfig({
      MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "S".repeat(56),
      MERIDIAN_ADAPTER_DEFINDEX_ID: "COVERRIDE",
    });
    expect(config.candidateAdapters.defindex).toBe("COVERRIDE");
  });

  it("leaves candidateAdapters empty with no env vars set", () => {
    const config = loadMigrationKeeperConfig({
      MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "S".repeat(56),
    });
    expect(config.candidateAdapters).toEqual({});
  });

  it("picks up a protocol never referenced in source, purely from its env var name", () => {
    // The whole point of the adapter pattern is that the vault (and
    // migrate_adapter) never need to know which protocol an adapter wraps;
    // this proves the keeper's own config layer honors that too, a new
    // protocol needs no code change here, only an env var.
    const config = loadMigrationKeeperConfig({
      MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "S".repeat(56),
      MERIDIAN_ADAPTER_SOROSWAP_ID: "CSOROSWAPADAPTER",
    });
    expect(config.candidateAdapters).toEqual({ soroswap: "CSOROSWAPADAPTER" });
  });

  it("ignores env vars that don't match the MERIDIAN_ADAPTER_<PROTOCOL>_ID pattern", () => {
    const config = loadMigrationKeeperConfig({
      MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "S".repeat(56),
      MERIDIAN_KEEPER_SECRET_KEY: "S".repeat(56),
      MERIDIAN_ADAPTER_ID: "CNOTMATCHED",
    });
    expect(config.candidateAdapters).toEqual({});
  });
});

describe("discoverMigrationVaults", () => {
  it("resolves the vault's current adapter, protocol, and pool", async () => {
    stellarMocks.simulateView
      .mockResolvedValueOnce("CBLENDADAPTER")
      .mockResolvedValueOnce("blend")
      .mockResolvedValueOnce("CBLENDPOOL");

    const result = await discoverMigrationVaults({
      network: NETWORK,
      pools: { "meridian-usdc": VAULT },
      logger: logger(),
      sleep: vi.fn(),
    });

    expect(result.failures).toEqual([]);
    expect(result.vaults).toEqual([DISCOVERED_VAULT]);
  });

  it("retries a transient discovery failure and succeeds", async () => {
    stellarMocks.simulateView
      .mockRejectedValueOnce(new Error("try again later"))
      .mockResolvedValueOnce("CBLENDADAPTER")
      .mockResolvedValueOnce("blend")
      .mockResolvedValueOnce("CBLENDPOOL");

    const result = await discoverMigrationVaults({
      network: NETWORK,
      pools: { "meridian-usdc": VAULT },
      logger: logger(),
      sleep: vi.fn(),
    });

    expect(result.vaults).toEqual([DISCOVERED_VAULT]);
  });

  it("does not retry a permanent discovery error", async () => {
    stellarMocks.simulateView.mockRejectedValue(
      new Error("contract not found")
    );

    const result = await discoverMigrationVaults({
      network: NETWORK,
      pools: { "meridian-usdc": VAULT },
      logger: logger(),
      sleep: vi.fn(),
    });

    expect(result.vaults).toEqual([]);
    expect(result.failures).toMatchObject([{ attempts: 1, transient: false }]);
  });
});

describe("runMigrationKeeper", () => {
  it("never migrates with the default rate source: no rate source is verified for either protocol yet", async () => {
    const submitMigration = vi.fn();

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      submitMigration,
    });

    expect(submitMigration).not.toHaveBeenCalled();
    expect(result.migrations).toEqual([]);
    expect(result.skipped).toEqual([
      { vaultId: "meridian-usdc", reason: "current rate unavailable" },
    ]);
  });

  it("migrates when a candidate clears the minimum improvement threshold", async () => {
    const submitMigration = vi.fn(async () => ({
      hash: "MIGRATE_HASH",
      ledger: 999,
    }));
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 600
    );

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
      submitMigration,
    });

    expect(submitMigration).toHaveBeenCalledWith(
      DISCOVERED_VAULT,
      "CDEFINDEXADAPTER",
      1
    );
    expect(result.migrations).toEqual([
      {
        vaultId: "meridian-usdc",
        fromAdapterId: "CBLENDADAPTER",
        fromProtocol: "blend",
        toAdapterId: "CDEFINDEXADAPTER",
        toProtocol: "defindex",
        improvementBps: 100,
        hash: "MIGRATE_HASH",
        ledger: 999,
        attempts: 1,
      },
    ]);
  });

  it("does not migrate when the candidate's improvement is below the configured threshold", async () => {
    const submitMigration = vi.fn();
    // 20 bps improvement, below CONFIG.minImprovementBps (50).
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 520
    );

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
      submitMigration,
    });

    expect(submitMigration).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      {
        vaultId: "meridian-usdc",
        reason: "no candidate clears the improvement threshold",
      },
    ]);
  });

  it("reports a definitive on-chain revert (e.g. slippage exceeded) as a non-transient failure without retrying", async () => {
    const sleep = vi.fn();
    const submitMigration = vi.fn(async () => {
      throw new Error("Transaction HASH123 failed on-chain");
    });
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 600
    );

    const result = await runMigrationKeeper(CONFIG, {
      logger: logger(),
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
      submitMigration,
      sleep,
    });

    expect(submitMigration).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(result.migrations).toEqual([]);
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        adapterId: "CDEFINDEXADAPTER",
        protocol: "defindex",
        stage: "submit",
        attempts: 1,
        transient: false,
      },
    ]);
  });

  it("retries a transient submission failure and eventually succeeds", async () => {
    const sleep = vi.fn();
    const submitMigration = vi
      .fn()
      .mockRejectedValueOnce(new Error("try again later"))
      .mockResolvedValueOnce({ hash: "RETRY_HASH", ledger: 42 });
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 600
    );

    const result = await runMigrationKeeper(CONFIG, {
      logger: logger(),
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
      submitMigration,
      sleep,
    });

    expect(submitMigration).toHaveBeenCalledTimes(2);
    expect(result.migrations).toMatchObject([
      { hash: "RETRY_HASH", ledger: 42, attempts: 2 },
    ]);
  });

  it("skips a candidate that is the same adapter already active", async () => {
    const submitMigration = vi.fn();
    const sameAdapterConfig: MigrationKeeperConfig = {
      ...CONFIG,
      candidateAdapters: { blend: DISCOVERED_VAULT.currentAdapterId },
    };
    const rateSource = vi.fn(async () => 500);

    const result = await runMigrationKeeper(sameAdapterConfig, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      submitMigration,
    });

    expect(submitMigration).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      {
        vaultId: "meridian-usdc",
        reason: "no candidate clears the improvement threshold",
      },
    ]);
  });

  it("skips an already-started vault once the run deadline has passed", async () => {
    const submitMigration = vi.fn();
    const rateSource = vi.fn(async () => 600);

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      submitMigration,
      deadlineAt: Date.now() - 1,
    });

    expect(submitMigration).not.toHaveBeenCalled();
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        stage: "submit",
        attempts: 0,
        transient: true,
      },
    ]);
  });

  it("builds the migrate_adapter transaction through the default Stellar submission path", async () => {
    const server = makeServer({
      sendTransaction: vi.fn(async () => ({
        hash: "SUBMITTED_HASH",
        status: "PENDING",
      })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 321 });
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 700
    );

    const result = await runMigrationKeeper(CONFIG, {
      logger: logger(),
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
      sleep: vi.fn(),
    });

    expect(server.getAccount).toHaveBeenCalledWith("GADMIN");
    expect(server.sendTransaction).toHaveBeenCalledOnce();
    expect(result.migrations).toEqual([
      {
        vaultId: "meridian-usdc",
        fromAdapterId: "CBLENDADAPTER",
        fromProtocol: "blend",
        toAdapterId: "CDEFINDEXADAPTER",
        toProtocol: "defindex",
        improvementBps: 200,
        hash: "SUBMITTED_HASH",
        ledger: 321,
        attempts: 1,
      },
    ]);
  });

  it("retries a transient failure while evaluating a candidate's rate, then succeeds", async () => {
    const sleep = vi.fn();
    const submitMigration = vi.fn(async () => ({
      hash: "MIGRATE_HASH",
      ledger: 999,
    }));
    const resolveCandidatePool = vi
      .fn()
      .mockRejectedValueOnce(new Error("try again later"))
      .mockResolvedValueOnce("CDEFINDEXPOOL");
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 600
    );

    const result = await runMigrationKeeper(CONFIG, {
      logger: logger(),
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool,
      submitMigration,
      sleep,
    });

    expect(resolveCandidatePool).toHaveBeenCalledTimes(2);
    expect(result.migrations).toMatchObject([
      { toAdapterId: "CDEFINDEXADAPTER", hash: "MIGRATE_HASH" },
    ]);
  });

  it("attributes a candidate-evaluation failure to the failing candidate, not the vault's current adapter", async () => {
    const resolveCandidatePool = vi
      .fn()
      .mockRejectedValue(new Error("contract not found"));
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 600
    );

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool,
      sleep: vi.fn(),
    });

    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        adapterId: "CDEFINDEXADAPTER",
        protocol: "defindex",
        stage: "discover",
        transient: false,
      },
    ]);
  });

  it("passes an arbitrary current protocol straight through to the rate source, no hardcoded allowlist", async () => {
    // There's no fixed set of "recognized" protocols: the vault's currentProtocol
    // is whatever the adapter's own get_protocol() reports, and it flows
    // through to rateSource unmodified. A protocol the rate source doesn't
    // know about is handled the same way any other unknown rate is: skipped
    // via "current rate unavailable", not a special protocol-name check.
    const submitMigration = vi.fn();
    const rateSource = vi.fn(
      async ({ protocol }: { protocol: string }) =>
        ({ blend: 500, defindex: 700 })[protocol] ?? null
    );
    const soroswapVault = {
      ...DISCOVERED_VAULT,
      currentAdapterId: "CSOROSWAPADAPTER",
      currentProtocol: "soroswap",
    };

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [soroswapVault],
        failures: [],
      }),
      rateSource,
      submitMigration,
    });

    expect(rateSource).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "soroswap" })
    );
    expect(submitMigration).not.toHaveBeenCalled();
    expect(result.skipped).toMatchObject([
      { vaultId: "meridian-usdc", reason: "current rate unavailable" },
    ]);
  });
});
