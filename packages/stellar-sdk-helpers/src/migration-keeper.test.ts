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

// The real default rate source (rate-sources.ts) is covered by its own
// dedicated test file (rate-sources.test.ts): it talks to Blend/DeFindex
// over the network and needs its own fixtures and mocks. Here it's mocked
// out entirely so this file can stay focused on keeper mechanics
// (discovery, retry, submission) without dragging that in, while still
// proving runMigrationKeeper actually wires it up when no rateSource dep is
// injected (see "wires the real default rate source" below).
const rateSourcesMocks = vi.hoisted(() => ({
  createDefaultRateSource: vi.fn(),
}));

vi.mock("./rate-sources", () => ({
  createDefaultRateSource: rateSourcesMocks.createDefaultRateSource,
}));

import {
  discoverMigrationVaults,
  loadMigrationKeeperConfig,
  runMigrationKeeper,
  type DiscoveredVault,
  type MigrationKeeperConfig,
} from "./migration-keeper";
import type { KeeperLogger } from "./keeper-retry";
import {
  createInMemoryKeeperStateStore,
  submissionStateKey,
  type KeeperStateStore,
  type SubmissionRecord,
} from "./keeper-state";
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
  submissionTtlMs: 360_000,
  candidateAdapters: { defindex: "CDEFINDEXADAPTER" },
};

const VAULT: KnownPoolMeta = {
  id: "meridian-usdc",
  name: "Meridian",
  protocol: "meridian",
  label: "USDC Vault",
  contractId: "CVAULT",
};

const EURC_VAULT: KnownPoolMeta = {
  id: "meridian-eurc",
  name: "Meridian",
  protocol: "meridian",
  label: "EURC Vault",
  contractId: "CEURCVAULT",
  assetId: "CEURCASSET",
};

const DISCOVERED_VAULT: DiscoveredVault = {
  vaultId: "meridian-usdc",
  vaultContractId: "CVAULT",
  currentAdapterId: "CBLENDADAPTER",
  currentProtocol: "blend",
  currentPoolId: "CBLENDPOOL",
};

// Hash of the signed transaction, known before submission.
const SIGNED_HASH = "deadbeef";

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

// Configures the shared simulateView mock for the real (non-injected)
// submission path: get_adapter (the pre-submit "vault hasn't moved since
// discovery" guard) resolves to `liveAdapterId`, and get_migration_snapshot
// resolves to an already-active, matching, cooldown-elapsed snapshot for
// `candidateAdapterId` so the test exercises the real migrate_adapter call
// instead of the begin_migration deferral path.
function mockLiveAdapterAndActiveSnapshot(
  liveAdapterId: string,
  candidateAdapterId: string
) {
  stellarMocks.simulateView.mockImplementation(
    async (_server, _contractId, _passphrase, method) => {
      if (method === "get_migration_snapshot") {
        return {
          adapter: candidateAdapterId,
          total_assets: 0n,
          ledger_seq: 0,
        };
      }
      return liveAdapterId;
    }
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  // Every test other than the one specifically about default wiring passes
  // its own `rateSource` dep, which takes precedence over this; this default
  // just keeps those unrelated tests from ever hitting the real
  // createDefaultRateSource mock (undefined) if they forget to.
  rateSourcesMocks.createDefaultRateSource.mockReturnValue(async () => null);
  stellarMocks.getRpcServer.mockReturnValue(makeServer());
  stellarMocks.keypairFromSecret.mockReturnValue({
    publicKey: vi.fn(() => "GADMIN"),
  });
  stellarMocks.isSimulationError.mockReturnValue(false);
  stellarMocks.isSimulationSuccess.mockReturnValue(true);
  stellarMocks.assembleTransaction.mockReturnValue({
    build: () => ({
      sign: stellarMocks.signPrepared,
      // The keeper records the signed transaction's own hash before it is
      // ever sent, so the built transaction has to expose one.
      hash: () => Buffer.from(SIGNED_HASH, "hex"),
    }),
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

  it("rejects two case-differing env var names that collide on the same protocol", () => {
    // Without this check, MERIDIAN_ADAPTER_BLEND_ID and
    // MERIDIAN_ADAPTER_Blend_ID would both lowercase to "blend", and
    // whichever Object.entries() happens to visit last would silently
    // overwrite the other with no error or log line.
    expect(() =>
      loadMigrationKeeperConfig({
        MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "S".repeat(56),
        MERIDIAN_ADAPTER_BLEND_ID: "CBLENDADAPTER_A",
        MERIDIAN_ADAPTER_Blend_ID: "CBLENDADAPTER_B",
      })
    ).toThrow(/both resolve to the same migration candidate protocol/);
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

  it("resolves the vault's assetId from its KNOWN_POOLS entry (#539)", async () => {
    stellarMocks.simulateView
      .mockResolvedValueOnce("CBLENDADAPTER")
      .mockResolvedValueOnce("blend")
      .mockResolvedValueOnce("CBLENDPOOL");

    const result = await discoverMigrationVaults({
      network: NETWORK,
      pools: { "meridian-eurc": EURC_VAULT },
      logger: logger(),
      sleep: vi.fn(),
    });

    expect(result.failures).toEqual([]);
    expect(result.vaults).toEqual([
      {
        vaultId: "meridian-eurc",
        vaultContractId: "CEURCVAULT",
        currentAdapterId: "CBLENDADAPTER",
        currentProtocol: "blend",
        currentPoolId: "CBLENDPOOL",
        assetId: "CEURCASSET",
      },
    ]);
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

  it("retries only the failed call, not already-succeeded get_adapter/get_protocol", async () => {
    // Fail get_pool once, then succeed, without exhausting maxAttempts.
    let poolCalls = 0;
    stellarMocks.simulateView.mockImplementation(
      async (_server, _contractId, _passphrase, method) => {
        if (method === "get_adapter") return "CBLENDADAPTER";
        if (method === "get_protocol") return "blend";
        if (method === "get_pool") {
          poolCalls++;
          if (poolCalls < 2) throw new Error("try again later");
          return "CBLENDPOOL";
        }
        throw new Error(`unexpected method: ${method}`);
      }
    );

    const result = await discoverMigrationVaults({
      network: NETWORK,
      pools: { "meridian-usdc": VAULT },
      logger: logger(),
      sleep: vi.fn(),
    });

    expect(result.vaults).toEqual([DISCOVERED_VAULT]);
    const callsByMethod = (method: string) =>
      stellarMocks.simulateView.mock.calls.filter(([, , , m]) => m === method)
        .length;
    expect(callsByMethod("get_adapter")).toBe(1);
    expect(callsByMethod("get_protocol")).toBe(1);
    expect(callsByMethod("get_pool")).toBe(2);
  });

  it("waits for a slower in-flight get_protocol before retrying, instead of issuing a duplicate", async () => {
    // Regression test: get_pool used to reject via Promise.all before a
    // still-pending get_protocol call had settled, leaving that call
    // running in the background. If the next retry attempt started before
    // it resolved, it would see currentProtocol still undefined and issue
    // its own second get_protocol call. Promise.allSettled fixes this by
    // always waiting for both to settle before the attempt completes.
    let poolCalls = 0;
    stellarMocks.simulateView.mockImplementation(
      async (_server, _contractId, _passphrase, method) => {
        if (method === "get_adapter") return "CBLENDADAPTER";
        if (method === "get_protocol") {
          // Slower than get_pool's immediate rejection below, so it's still
          // in flight when get_pool settles.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return "blend";
        }
        if (method === "get_pool") {
          poolCalls++;
          if (poolCalls < 2) throw new Error("try again later");
          return "CBLENDPOOL";
        }
        throw new Error(`unexpected method: ${method}`);
      }
    );

    const result = await discoverMigrationVaults({
      network: NETWORK,
      pools: { "meridian-usdc": VAULT },
      logger: logger(),
      maxAttempts: 3,
      baseDelayMs: 1,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    expect(result.vaults).toEqual([DISCOVERED_VAULT]);
    const callsByMethod = (method: string) =>
      stellarMocks.simulateView.mock.calls.filter(([, , , m]) => m === method)
        .length;
    expect(callsByMethod("get_adapter")).toBe(1);
    expect(callsByMethod("get_protocol")).toBe(1);
    expect(callsByMethod("get_pool")).toBe(2);
  });

  it("surfaces a permanent failure over a transient one when both get_protocol and get_pool reject", async () => {
    // Regression test: throwing whichever of the two rejections was checked
    // first would let a permanent get_pool failure hide behind a transient
    // get_protocol failure, wasting the full retry budget on a target that
    // was never going to succeed.
    stellarMocks.simulateView.mockImplementation(
      async (_server, _contractId, _passphrase, method) => {
        if (method === "get_adapter") return "CBLENDADAPTER";
        if (method === "get_protocol") throw new Error("try again later");
        if (method === "get_pool") throw new Error("contract not found");
        throw new Error(`unexpected method: ${method}`);
      }
    );

    const result = await discoverMigrationVaults({
      network: NETWORK,
      pools: { "meridian-usdc": VAULT },
      logger: logger(),
      maxAttempts: 3,
      baseDelayMs: 1,
      sleep: vi.fn(),
    });

    expect(result.vaults).toEqual([]);
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        attempts: 1,
        transient: false,
        error: "contract not found",
      },
    ]);
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
  it("wires the real default rate source (rate-sources.ts) when no rateSource dep is injected", async () => {
    // #511: runMigrationKeeper used to fall back to a stub that always
    // returned null, so it could never migrate anything in practice no
    // matter how the rest of the mechanism was configured. It must now
    // build the real Blend/DeFindex rate source (createDefaultRateSource,
    // see rate-sources.ts and its own dedicated tests) from the run's
    // network config whenever the caller doesn't supply one explicitly.
    const submitMigration = vi.fn();
    const stubRateSource = vi.fn(async () => null);
    rateSourcesMocks.createDefaultRateSource.mockReturnValue(stubRateSource);

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      submitMigration,
    });

    expect(rateSourcesMocks.createDefaultRateSource).toHaveBeenCalledWith(
      CONFIG.network
    );
    expect(stubRateSource).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "blend" })
    );
    expect(submitMigration).not.toHaveBeenCalled();
    expect(result.migrations).toEqual([]);
    expect(result.skipped).toEqual([
      { vaultId: "meridian-usdc", reason: "current rate unavailable" },
    ]);
  });

  it("threads the vault's assetId into every rate query so a non-USDC vault prices the right reserve (#539)", async () => {
    const submitMigration = vi.fn(async () => ({
      hash: "EURC_MIGRATE_HASH",
      ledger: 123,
    }));
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 700
    );
    const eurcVault: DiscoveredVault = {
      ...DISCOVERED_VAULT,
      assetId: "CEURCASSET",
    };

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [eurcVault],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
      submitMigration,
    });

    // Both the current vault's rate and each candidate's rate are evaluated
    // against the vault's own reserve asset, never a hardcoded USDC address
    // (see rate-sources.ts for how createBlendRateSource consumes it).
    expect(rateSource).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "blend", assetId: "CEURCASSET" })
    );
    expect(rateSource).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "defindex", assetId: "CEURCASSET" })
    );
    expect(result.migrations).toMatchObject([
      { toProtocol: "defindex", improvementBps: 200 },
    ]);
  });

  it("keeps the USDC-vault query shape unchanged when the vault has no assetId (#539)", async () => {
    // #539 acceptance criterion: no change to RateQuery's existing USDC-vault
    // behavior. A vault whose KNOWN_POOLS entry has no assetId must not start
    // carrying an assetId field, so the Blend rate source keeps falling back
    // to its USDC default exactly as before.
    const submitMigration = vi.fn();
    const rateSource = vi.fn(async () => null);

    await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      submitMigration,
    });

    expect(rateSource).toHaveBeenCalled();
    for (const call of rateSource.mock.calls) {
      expect(call[0]).not.toHaveProperty("assetId");
    }
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

    // The fourth argument is this run's submission-lease hooks: an injected
    // submitter is expected to forward them to keep cross-invocation dedup.
    expect(submitMigration).toHaveBeenCalledWith(
      DISCOVERED_VAULT,
      "CDEFINDEXADAPTER",
      1,
      expect.objectContaining({
        onSigned: expect.any(Function),
        onResolved: expect.any(Function),
      })
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

  it("treats a NaN rate as unavailable instead of letting it win the comparison", async () => {
    // A buggy RateSourceFn (e.g. a division by zero, see #511) could resolve
    // NaN instead of throwing or returning null. NaN defeats every < and >
    // comparison, so without an explicit finiteness check this would have
    // silently become the winning candidate and bypassed minImprovementBps.
    const submitMigration = vi.fn();
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : NaN
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
        reason: "no candidate rate was available to compare",
      },
    ]);
  });

  it("treats a non-finite current rate as unavailable rather than comparing against it", async () => {
    const submitMigration = vi.fn();
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? Infinity : 700
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
      { vaultId: "meridian-usdc", reason: "current rate unavailable" },
    ]);
  });

  it("reports a distinct skip reason when no candidate rate was available, not a failed threshold check", async () => {
    // A rate source implemented for one protocol but not another (e.g.
    // #511's phased rollout) never actually compares anything; reporting it
    // as "no candidate clears the improvement threshold" would mislead
    // anyone reading skipped[] into thinking a comparison happened.
    const submitMigration = vi.fn();
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : null
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
        reason: "no candidate rate was available to compare",
      },
    ]);
  });

  it("reports a valid below-threshold comparison as a skip, even when a different candidate failed to evaluate", async () => {
    // Regression test: a candidate that failed to evaluate must never turn
    // a genuinely-reached "no migration needed" decision (from a different,
    // successfully-compared candidate) into a hard failure.
    const submitMigration = vi.fn();
    const twoCandidateConfig: MigrationKeeperConfig = {
      ...CONFIG,
      candidateAdapters: {
        blend: "CBLENDADAPTER_V2",
        defindex: "CDEFINDEXADAPTER",
      },
    };
    const resolveCandidatePool = vi.fn(async (adapterId: string) => {
      if (adapterId === "CDEFINDEXADAPTER") {
        throw new Error("contract not found");
      }
      return "CBLENDPOOL_V2";
    });
    // blend candidate: 20 bps improvement, below CONFIG.minImprovementBps (50).
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 520 : 500
    );

    const result = await runMigrationKeeper(twoCandidateConfig, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool,
      submitMigration,
      sleep: vi.fn(),
    });

    expect(submitMigration).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
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
    // No candidates survive the same-adapter filter, so no rate comparison
    // ever runs, and rateSource is never even called for the current rate.
    expect(rateSource).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      {
        vaultId: "meridian-usdc",
        reason: "every configured candidate is the vault's current adapter",
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
    // The pre-submit "vault hasn't moved since discovery" guard reads
    // get_adapter() fresh; keep it matching DISCOVERED_VAULT's adapter.
    mockLiveAdapterAndActiveSnapshot(
      DISCOVERED_VAULT.currentAdapterId,
      "CDEFINDEXADAPTER"
    );
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

  it("checks a prior submission's real status before resubmitting, avoiding a duplicate migrate_adapter call", async () => {
    // Same regression as the accrue keeper's equivalent test, but higher
    // stakes here: a duplicate migrate_adapter call costs real slippage
    // twice, not just a wasted fee (see migration-keeper.md).
    const server = makeServer({
      sendTransaction: vi.fn(async () => ({
        hash: "SUBMITTED_HASH",
        status: "PENDING",
      })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction
      .mockRejectedValueOnce(new Error("Soroban RPC timed out after 100ms"))
      .mockResolvedValueOnce({ ledger: 321 });
    mockLiveAdapterAndActiveSnapshot(
      DISCOVERED_VAULT.currentAdapterId,
      "CDEFINDEXADAPTER"
    );
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

    expect(server.sendTransaction).toHaveBeenCalledOnce();
    expect(stellarMocks.waitForTransaction).toHaveBeenCalledTimes(2);
    expect(stellarMocks.waitForTransaction).toHaveBeenNthCalledWith(
      2,
      server,
      "SUBMITTED_HASH",
      { timeoutMs: 20000 }
    );
    expect(result.migrations).toMatchObject([
      { hash: "SUBMITTED_HASH", ledger: 321, attempts: 2 },
    ]);
  });

  it("never drops a successful candidate because a different candidate failed to evaluate", async () => {
    // Regression test: findBestCandidate evaluates candidates concurrently.
    // An earlier version threw on the first rejected candidate found by
    // array order, discarding any other candidate that had already
    // succeeded and cleared the improvement threshold.
    const submitMigration = vi.fn(async () => ({
      hash: "GOOD_HASH",
      ledger: 42,
    }));
    const mixedConfig: MigrationKeeperConfig = {
      ...CONFIG,
      candidateAdapters: {
        blend: "CBLENDADAPTER_V2",
        defindex: "CDEFINDEXADAPTER",
      },
    };
    const resolveCandidatePool = vi.fn(async (adapterId: string) => {
      if (adapterId === "CBLENDADAPTER_V2") {
        throw new Error("try again later");
      }
      return "CDEFINDEXPOOL";
    });
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 700
    );

    const result = await runMigrationKeeper(mixedConfig, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool,
      submitMigration,
      sleep: vi.fn(),
    });

    expect(submitMigration).toHaveBeenCalledOnce();
    expect(result.migrations).toMatchObject([
      { toAdapterId: "CDEFINDEXADAPTER", hash: "GOOD_HASH" },
    ]);
    expect(result.failures).toEqual([]);
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
        stage: "evaluate",
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

  it("considers a candidate with the same protocol name as a different adapter address (e.g. a redeployed BlendAdapter)", async () => {
    // Only the adapter address, not the protocol name, excludes a candidate:
    // migrate_adapter itself only forbids migrating to the exact same
    // adapter address (SameAdapter), not a different adapter of the same
    // protocol, matching a real redeploy-blend-adapter.sh workflow.
    const submitMigration = vi.fn(async () => ({
      hash: "REDEPLOY_HASH",
      ledger: 555,
    }));
    const redeployConfig: MigrationKeeperConfig = {
      ...CONFIG,
      candidateAdapters: { blend: "CBLENDADAPTER_V2" },
    };
    const rateSource = vi.fn(async ({ adapterId }: { adapterId: string }) =>
      adapterId === "CBLENDADAPTER_V2" ? 900 : 500
    );

    const result = await runMigrationKeeper(redeployConfig, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CBLENDPOOL_V2",
      submitMigration,
    });

    expect(submitMigration).toHaveBeenCalledOnce();
    expect(result.migrations).toMatchObject([
      { toAdapterId: "CBLENDADAPTER_V2", toProtocol: "blend" },
    ]);
  });

  it("evaluates candidates concurrently rather than blocking on each other", async () => {
    const releaseBlend = { resolve: () => {} };
    const blendGate = new Promise<void>((resolve) => {
      releaseBlend.resolve = resolve;
    });
    const resolveCandidatePool = vi.fn(async (adapterId: string) => {
      if (adapterId === "CBLENDADAPTER_V2") {
        await blendGate;
      }
      return `POOL_FOR_${adapterId}`;
    });
    const rateSource = vi.fn(async () => 900);
    const multiCandidateConfig: MigrationKeeperConfig = {
      ...CONFIG,
      candidateAdapters: {
        blend: "CBLENDADAPTER_V2",
        defindex: "CDEFINDEXADAPTER",
      },
    };

    const run = runMigrationKeeper(multiCandidateConfig, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool,
      submitMigration: vi.fn(async () => ({ hash: "H", ledger: 1 })),
    });

    // The defindex candidate's pool resolves immediately; if candidates were
    // evaluated sequentially in declaration order, blend (gated open) would
    // block defindex from ever being attempted before the run settles.
    await vi.waitFor(() =>
      expect(resolveCandidatePool).toHaveBeenCalledWith("CDEFINDEXADAPTER")
    );
    releaseBlend.resolve();
    await run;

    expect(resolveCandidatePool).toHaveBeenCalledWith("CBLENDADAPTER_V2");
  });

  it("skips submission when the vault's adapter changed since discovery, instead of migrating on stale data", async () => {
    // A different invocation (or an admin) already migrated this vault
    // since this run's discovery read; submitting anyway would build a
    // migrate_adapter call using stale assumptions about the vault's
    // current adapter.
    mockLiveAdapterAndActiveSnapshot("CSOMEOTHERADAPTER", "CDEFINDEXADAPTER");
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

    // This is the benign, expected race the guard exists to catch, not an
    // operational failure: it belongs in skipped, not failures, so it
    // doesn't page anyone every time it fires.
    expect(result.migrations).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toMatchObject([
      {
        vaultId: "meridian-usdc",
        reason: expect.stringContaining("adapter changed since discovery"),
      },
    ]);
  });

  it("keeps the stale-adapter skip reason informative even with real-length contract addresses", async () => {
    // Regression test: sanitizeTxError redacts any message containing a
    // 50+ char C-address to a generic fallback. A real Stellar address is
    // 56 chars, well past that threshold; the short fixture addresses used
    // elsewhere in this file (e.g. "CSOMEOTHERADAPTER") are too short to
    // trigger that redaction, which would otherwise mask this exact
    // scenario. This proves the skip reason survives with real addresses.
    const realAddress = `C${"A".repeat(55)}`;
    mockLiveAdapterAndActiveSnapshot(realAddress, "CDEFINDEXADAPTER");
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

    expect(result.skipped).toMatchObject([
      {
        vaultId: "meridian-usdc",
        reason: expect.stringContaining("adapter changed since discovery"),
      },
    ]);
  });

  it("submits begin_migration and defers migrate_adapter when no snapshot exists yet", async () => {
    const server = makeServer();
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 321 });
    // get_migration_snapshot traps (no active migration); get_adapter
    // resolves normally for the staleness guard, which is never reached.
    stellarMocks.simulateView.mockImplementation(
      async (_server, _contractId, _passphrase, method) => {
        if (method === "get_migration_snapshot") {
          throw new Error("MigrationNotInitialized");
        }
        return DISCOVERED_VAULT.currentAdapterId;
      }
    );
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

    expect(server.sendTransaction).toHaveBeenCalledOnce();
    expect(result.migrations).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toMatchObject([
      {
        vaultId: "meridian-usdc",
        reason: expect.stringContaining("begin_migration submitted"),
      },
    ]);
  });

  it("reports a transient failure reading the migration snapshot instead of assuming none exists", async () => {
    // A timeout/rate-limit reading get_migration_snapshot must not be
    // treated the same as a genuine MigrationNotInitialized trap: doing so
    // would fire begin_migration and reset a possibly already
    // cooldown-elapsed snapshot's ledger_seq, delaying a ready migration by
    // a full MIN_LEDGER_GAP for no reason.
    const server = makeServer();
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.simulateView.mockImplementation(
      async (_server, _contractId, _passphrase, method) => {
        if (method === "get_migration_snapshot") {
          throw new Error("Soroban RPC timed out after 100ms");
        }
        return DISCOVERED_VAULT.currentAdapterId;
      }
    );
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

    // No begin_migration (or anything else) was sent this run.
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(result.migrations).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        transient: true,
        error: expect.stringContaining("could not read the migration snapshot"),
      },
    ]);
  });

  it("submits begin_migration and defers migrate_adapter when the existing snapshot is for a different adapter", async () => {
    const server = makeServer();
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 321 });
    mockLiveAdapterAndActiveSnapshot(
      DISCOVERED_VAULT.currentAdapterId,
      "CSOMEOTHERCANDIDATE"
    );
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

    expect(server.sendTransaction).toHaveBeenCalledOnce();
    expect(result.migrations).toEqual([]);
    expect(result.skipped).toMatchObject([
      {
        vaultId: "meridian-usdc",
        reason: expect.stringContaining("begin_migration submitted"),
      },
    ]);
  });

  it("releases the submission lease after begin_migration so a later run isn't blocked", async () => {
    const server = makeServer();
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 321 });
    stellarMocks.simulateView.mockImplementation(
      async (_server, _contractId, _passphrase, method) => {
        if (method === "get_migration_snapshot") {
          throw new Error("MigrationNotInitialized");
        }
        return DISCOVERED_VAULT.currentAdapterId;
      }
    );
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 700
    );
    const stateStore = createInMemoryKeeperStateStore();
    const key = submissionStateKey(
      "migration",
      "testnet",
      DISCOVERED_VAULT.vaultId
    );

    await runMigrationKeeper(CONFIG, {
      logger: logger(),
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
      sleep: vi.fn(),
      stateStore,
    });

    expect(await stateStore.get(key)).toBeNull();
  });

  it("skips evaluation entirely when no candidate adapters are configured", async () => {
    const rateSource = vi.fn();
    const noCandidatesConfig: MigrationKeeperConfig = {
      ...CONFIG,
      candidateAdapters: {},
    };

    const result = await runMigrationKeeper(noCandidatesConfig, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
    });

    expect(rateSource).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      {
        vaultId: "meridian-usdc",
        reason: "no candidate adapters configured",
      },
    ]);
  });

  it("skips submission when the deadline is reached during evaluation, not just before it started", async () => {
    // The deadline check at the top of the loop only catches a budget
    // that's already gone before this vault starts; evaluation itself can
    // eat the rest of it. Submitting anyway would fire an irreversible,
    // slippage-costing transaction right as the platform is about to kill
    // the invocation.
    const submitMigration = vi.fn();
    const deadlineAt = Date.now() + 15;
    const rateSource = vi.fn(async ({ protocol }: { protocol: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return protocol === "blend" ? 500 : 700;
    });

    const result = await runMigrationKeeper(CONFIG, {
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
      submitMigration,
      deadlineAt,
    });

    expect(submitMigration).not.toHaveBeenCalled();
    // Reports the migration that was actually being skipped (best, the
    // defindex candidate), not the vault's current (blend) adapter.
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        adapterId: "CDEFINDEXADAPTER",
        protocol: "defindex",
        stage: "submit",
        transient: true,
      },
    ]);
  });
});

describe("runMigrationKeeper cross-invocation dedup", () => {
  const KEY = submissionStateKey("migration", "testnet", "meridian-usdc");

  async function store(seed?: SubmissionRecord) {
    const inner = createInMemoryKeeperStateStore();
    if (seed) await inner.claim(KEY, seed, 600_000);
    return inner;
  }

  const rateSource = () =>
    vi.fn(async ({ protocol }: { protocol: string }) =>
      protocol === "blend" ? 500 : 700
    );

  function run(stateStore: KeeperStateStore, rates = rateSource()) {
    return runMigrationKeeper(CONFIG, {
      logger: logger(),
      sleep: vi.fn(),
      stateStore,
      discoverVaults: async () => ({
        vaults: [DISCOVERED_VAULT],
        failures: [],
      }),
      rateSource: rates,
      resolveCandidatePool: async () => "CDEFINDEXPOOL",
    });
  }

  it("does not send a second migrate_adapter while a prior one is still unconfirmed", async () => {
    // The whole point of #515: unlike accrue(), a duplicate here costs real
    // slippage a second time, not a flat fee.
    const server = makeServer({
      getTransaction: vi.fn(async () => ({ status: "NOT_FOUND" })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.simulateView.mockResolvedValue(
      DISCOVERED_VAULT.currentAdapterId
    );
    const rates = rateSource();

    const result = await run(
      await store({ hash: "INFLIGHT_HASH", updatedAtMs: Date.now() - 1_000 }),
      rates
    );

    expect(server.sendTransaction).not.toHaveBeenCalled();
    // Blocked before evaluation, so the rate lookups (and the deadline
    // budget they spend) are never paid for a vault that cannot migrate.
    expect(rates).not.toHaveBeenCalled();
    expect(result.migrations).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toMatchObject([
      {
        vaultId: "meridian-usdc",
        reason: expect.stringContaining("still unconfirmed"),
      },
    ]);
  });

  it("skips a vault another run has claimed but not yet signed for", async () => {
    // A plain "no record" read is not a claim: two concurrent invocations
    // could otherwise both pass the check and both broadcast.
    const server = makeServer();
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.simulateView.mockResolvedValue(
      DISCOVERED_VAULT.currentAdapterId
    );

    const result = await run(
      await store({ hash: null, updatedAtMs: Date.now() })
    );

    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(result.skipped).toMatchObject([
      { reason: expect.stringContaining("already preparing") },
    ]);
  });

  it("resolves a prior submission that landed and evaluates again", async () => {
    const server = makeServer({
      getTransaction: vi.fn(async () => ({ status: "SUCCESS", ledger: 5 })),
      sendTransaction: vi.fn(async () => ({
        hash: "SUBMITTED_HASH",
        status: "PENDING",
      })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 321 });
    mockLiveAdapterAndActiveSnapshot(
      DISCOVERED_VAULT.currentAdapterId,
      "CDEFINDEXADAPTER"
    );
    const stateStore = await store({
      hash: "LANDED_HASH",
      updatedAtMs: Date.now() - 1_000,
    });

    const result = await run(stateStore);

    expect(result.migrations).toMatchObject([{ hash: "SUBMITTED_HASH" }]);
    expect(await stateStore.get(KEY)).toBeNull();
  });

  it("clears a record whose transaction is past its validity window instead of blocking on it", async () => {
    const server = makeServer({
      getTransaction: vi.fn(async () => ({ status: "NOT_FOUND" })),
      sendTransaction: vi.fn(async () => ({
        hash: "SUBMITTED_HASH",
        status: "PENDING",
      })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 321 });
    mockLiveAdapterAndActiveSnapshot(
      DISCOVERED_VAULT.currentAdapterId,
      "CDEFINDEXADAPTER"
    );

    const result = await run(
      await store({
        hash: "DEAD_HASH",
        updatedAtMs: Date.now() - CONFIG.submissionTtlMs - 1,
      })
    );

    expect(result.migrations).toMatchObject([{ hash: "SUBMITTED_HASH" }]);
  });

  it("records the signed hash before the transaction is sent, so a killed run still blocks the next one", async () => {
    let recordedAtSend: string | null | undefined;
    const stateStore = await store();
    const server = makeServer({
      getTransaction: vi.fn(async () => ({ status: "NOT_FOUND" })),
      sendTransaction: vi.fn(async () => {
        recordedAtSend = (await stateStore.get(KEY))?.record.hash;
        return { hash: "SUBMITTED_HASH", status: "PENDING" };
      }),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);
    mockLiveAdapterAndActiveSnapshot(
      DISCOVERED_VAULT.currentAdapterId,
      "CDEFINDEXADAPTER"
    );
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 321 });

    await run(stateStore);

    expect(recordedAtSend).toBe(SIGNED_HASH);
    expect(await stateStore.get(KEY)).toBeNull();
  });

  it("skips the vault when the prior submission's status cannot be checked", async () => {
    // A store or RPC outage must not be read as "nothing was submitted":
    // that is precisely the assumption that produces a double migration.
    const server = makeServer({
      getTransaction: vi.fn(async () => {
        throw new Error("rpc unavailable");
      }),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);

    const result = await run(
      await store({ hash: "UNKNOWN_HASH", updatedAtMs: Date.now() })
    );

    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    expect(result.skipped).toMatchObject([
      { reason: expect.stringContaining("could not be verified") },
    ]);
  });

  it("releases the claim when the migration is abandoned before anything is signed", async () => {
    // The stale-adapter guard aborts before the transaction is built.
    // Leaving the claim behind would lock the vault out of migrating for
    // the claim's whole window over a transaction that never existed.
    mockLiveAdapterAndActiveSnapshot("CSOMEOTHERADAPTER", "CDEFINDEXADAPTER");
    const stateStore = await store();
    stellarMocks.getRpcServer.mockReturnValue(makeServer());

    const result = await run(stateStore);

    expect(result.skipped).toMatchObject([
      { reason: expect.stringContaining("adapter changed since discovery") },
    ]);
    expect(await stateStore.get(KEY)).toBeNull();
  });
});
