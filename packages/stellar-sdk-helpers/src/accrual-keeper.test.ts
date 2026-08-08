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

    call(method: string) {
      return { contractId: this.contractId, method };
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
    Contract,
    Keypair: {
      fromSecret: stellarMocks.keypairFromSecret,
    },
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
  simErrorMessage: (error: unknown) => String(error),
  simulateView: stellarMocks.simulateView,
  waitForTransaction: stellarMocks.waitForTransaction,
}));
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

function makeServer(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: vi.fn(async () => ({ accountId: "GKEEPER" })),
    getTransaction: vi.fn(),
    sendTransaction: vi.fn(async () => ({
      hash: "HASH",
      status: "PENDING",
    })),
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
    publicKey: vi.fn(() => "GKEEPER"),
  });
  stellarMocks.isSimulationError.mockImplementation(
    (sim: { kind?: string }) => sim.kind === "error"
  );
  stellarMocks.isSimulationSuccess.mockImplementation(
    (sim: { kind?: string }) => sim.kind === "success"
  );
  stellarMocks.assembleTransaction.mockImplementation((tx: unknown) => ({
    build: () => ({ tx, sign: stellarMocks.signPrepared }),
  }));
  stellarMocks.simulateView.mockReset();
  stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 999 });
});

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

  it("uses the legacy keeper secret fallback and default retry tuning", () => {
    const config = loadBlendAccrualKeeperConfig({
      KEEPER_SECRET_KEY: "LEGACY_SECRET",
    });

    expect(config.secretKey).toBe("LEGACY_SECRET");
    expect(config.maxAttempts).toBe(3);
    expect(config.baseDelayMs).toBe(1000);
    expect(config.rpcTimeoutMs).toBe(12000);
  });

  it("rejects invalid positive integer environment values", () => {
    expect(() =>
      loadBlendAccrualKeeperConfig({
        MERIDIAN_KEEPER_SECRET_KEY: "SECRET",
        MERIDIAN_KEEPER_MAX_ATTEMPTS: "0",
      })
    ).toThrow("MERIDIAN_KEEPER_MAX_ATTEMPTS must be a positive integer");
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
    const sleep = vi.fn();
    const log = logger();
    const result = await discoverLiveAdapters({
      network: NETWORK,
      server: {} as never,
      simulate: simulate as never,
      maxAttempts: 2,
      baseDelayMs: 1,
      logger: log,
      sleep,
      pools: { "meridian-usdc": VAULT },
    });

    expect(simulate).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(log.warn).toHaveBeenCalledWith(
      "[accrual-keeper] transient failure; retrying",
      expect.objectContaining({
        attempt: 1,
        delayMs: 1,
        nextAttempt: 2,
        stage: "discover",
        vaultId: "meridian-usdc",
      })
    );
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

  it("retries transient get_adapter discovery failures and then succeeds", async () => {
    const sleep = vi.fn();
    const simulate = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 temporarily unavailable"))
      .mockResolvedValueOnce("CADAPTERBLEND")
      .mockResolvedValueOnce("blend");

    const result = await discoverLiveAdapters({
      network: NETWORK,
      server: {} as never,
      simulate: simulate as never,
      maxAttempts: 3,
      baseDelayMs: 5,
      sleep,
      pools: { "meridian-usdc": VAULT },
    });

    expect(sleep).toHaveBeenCalledWith(5);
    expect(simulate).toHaveBeenCalledTimes(3);
    expect(result.failures).toEqual([]);
    expect(result.adapters).toEqual([BLEND_ADAPTER]);
  });

  it("records permanent get_adapter discovery failures without retrying", async () => {
    const sleep = vi.fn();
    const simulate = vi.fn(async () => {
      throw new Error("contract function missing");
    });

    const result = await discoverLiveAdapters({
      network: NETWORK,
      server: {} as never,
      simulate: simulate as never,
      maxAttempts: 3,
      baseDelayMs: 5,
      sleep,
      pools: { "meridian-usdc": VAULT },
    });

    expect(simulate).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        vaultContractId: "CVAULT",
        stage: "discover",
        attempts: 1,
        transient: false,
        error: "contract function missing",
      },
    ]);
  });

  it("records get_protocol discovery failures after retrying the whole discovery step", async () => {
    const sleep = vi.fn();
    const simulate = vi.fn(async (_server, contractId, _passphrase, method) => {
      if (contractId === "CVAULT" && method === "get_adapter") {
        return "CADAPTER";
      }
      throw new Error("not_found");
    });

    const result = await discoverLiveAdapters({
      network: NETWORK,
      server: {} as never,
      simulate: simulate as never,
      maxAttempts: 2,
      baseDelayMs: 7,
      sleep,
      pools: { "meridian-usdc": VAULT },
    });

    expect(simulate).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(7);
    expect(result.adapters).toEqual([]);
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        vaultContractId: "CVAULT",
        stage: "discover",
        attempts: 2,
        transient: true,
        error: "not_found",
      },
    ]);
  });

  it("returns no adapters or failures when no Meridian vaults are configured", async () => {
    const simulate = vi.fn();

    const result = await discoverLiveAdapters({
      network: NETWORK,
      server: {} as never,
      simulate: simulate as never,
      pools: { "blend-usdc-fixed": DIRECT_BLEND },
    });

    expect(simulate).not.toHaveBeenCalled();
    expect(result).toEqual({ adapters: [], failures: [] });
  });
});

describe("runBlendAccrualKeeper", () => {
  it("handles no discovered adapters", async () => {
    const submitAccrual = vi.fn();
    const log = logger();

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: log,
      discoverAdapters: async () => ({ adapters: [], failures: [] }),
      submitAccrual,
    });

    expect(submitAccrual).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      discoveredAdapters: 0,
      blendAdapters: 0,
      successes: [],
      skipped: [],
      failures: [],
    });
    expect(log.info).toHaveBeenCalledWith(
      "[accrual-keeper] discovered adapters",
      expect.objectContaining({
        blendAdapters: 0,
        discoveredAdapters: 0,
        discoveryFailures: 0,
        skippedAdapters: 0,
      })
    );
  });

  it("uses live discovery when discoverAdapters is not injected", async () => {
    stellarMocks.simulateView.mockImplementation(
      async (_server, _contractId, _passphrase, method) =>
        method === "get_adapter" ? "CADAPTERBLEND" : "blend"
    );
    const submitAccrual = vi.fn(async () => ({ hash: "HASH", ledger: 123 }));

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      sleep: vi.fn(),
      submitAccrual,
    });

    expect(stellarMocks.getRpcServer).toHaveBeenCalledWith(
      CONFIG.network.rpcUrl,
      CONFIG.rpcTimeoutMs
    );
    expect(stellarMocks.simulateView).toHaveBeenCalledTimes(2);
    expect(submitAccrual).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      discoveredAdapters: 1,
      blendAdapters: 1,
      failures: [],
      successes: [{ adapterId: "CADAPTERBLEND", attempts: 1 }],
    });
  });

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

  it("skips only non-Blend adapters without submitting accrue", async () => {
    const submitAccrual = vi.fn();

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [DEFINDEX_ADAPTER],
        failures: [],
      }),
      submitAccrual,
    });

    expect(submitAccrual).not.toHaveBeenCalled();
    expect(result.blendAdapters).toBe(0);
    expect(result.skipped).toEqual([
      { ...DEFINDEX_ADAPTER, reason: "non-blend" },
    ]);
  });

  it("processes multiple Blend adapters", async () => {
    const secondBlend = {
      ...BLEND_ADAPTER,
      vaultId: "meridian-xlm",
      vaultContractId: "CVAULT3",
      adapterId: "CADAPTERBLEND2",
    };
    const submitAccrual = vi
      .fn()
      .mockResolvedValueOnce({ hash: "HASH1", ledger: 101 })
      .mockResolvedValueOnce({ hash: "HASH2", ledger: 102 });

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER, secondBlend],
        failures: [],
      }),
      submitAccrual,
    });

    expect(submitAccrual).toHaveBeenCalledTimes(2);
    expect(result.successes).toEqual([
      {
        vaultId: "meridian-usdc",
        adapterId: "CADAPTERBLEND",
        hash: "HASH1",
        ledger: 101,
        attempts: 1,
      },
      {
        vaultId: "meridian-xlm",
        adapterId: "CADAPTERBLEND2",
        hash: "HASH2",
        ledger: 102,
        attempts: 1,
      },
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

  it("uses exponential retry delays for transient submission failures", async () => {
    const sleep = vi.fn();
    const submitAccrual = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("rate limit 429"))
      .mockResolvedValueOnce({ hash: "HASH3", ledger: 789 });

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      sleep,
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      submitAccrual,
    });

    expect(submitAccrual).toHaveBeenNthCalledWith(1, BLEND_ADAPTER, 1);
    expect(submitAccrual).toHaveBeenNthCalledWith(2, BLEND_ADAPTER, 2);
    expect(submitAccrual).toHaveBeenNthCalledWith(3, BLEND_ADAPTER, 3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1);
    expect(sleep).toHaveBeenNthCalledWith(2, 2);
    expect(result.successes[0]).toMatchObject({
      hash: "HASH3",
      attempts: 3,
    });
  });

  it("records transient submission failures after max attempts are exhausted", async () => {
    const sleep = vi.fn();
    const submitAccrual = vi.fn(async () => {
      throw new Error("504 timed out");
    });

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      sleep,
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      submitAccrual,
    });

    expect(submitAccrual).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.successes).toEqual([]);
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        vaultContractId: "CVAULT",
        adapterId: "CADAPTERBLEND",
        protocol: "blend",
        stage: "submit",
        attempts: 3,
        transient: true,
        error: "504 timed out",
      },
    ]);
  });

  it("makes failed submissions observable in the run result and logs context", async () => {
    const log = logger();
    const submitAccrual = vi.fn(async () => {
      throw new Error("contract trapped");
    });
    const sleep = vi.fn();
    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: log,
      sleep,
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      submitAccrual,
    });

    expect(submitAccrual).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
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

  it("keeps discovery failures while submitting successful adapters", async () => {
    const discoveryFailure = {
      vaultId: "meridian-eurc",
      vaultContractId: "CVAULT2",
      stage: "discover" as const,
      attempts: 2,
      transient: true,
      error: "rpc timed out",
    };
    const submitAccrual = vi.fn(async () => ({ hash: "HASH", ledger: 123 }));

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [discoveryFailure],
      }),
      submitAccrual,
    });

    expect(result.successes).toHaveLength(1);
    expect(result.failures).toEqual([discoveryFailure]);
  });

  it("continues processing Blend adapters after one submission fails", async () => {
    const secondBlend = {
      ...BLEND_ADAPTER,
      vaultId: "meridian-xlm",
      vaultContractId: "CVAULT3",
      adapterId: "CADAPTERBLEND2",
    };
    const submitAccrual = vi
      .fn()
      .mockRejectedValueOnce(new Error("contract trapped"))
      .mockResolvedValueOnce({ hash: "HASH2", ledger: 202 });

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER, secondBlend],
        failures: [],
      }),
      submitAccrual,
    });

    expect(submitAccrual).toHaveBeenCalledTimes(2);
    expect(result.failures).toMatchObject([
      {
        vaultId: "meridian-usdc",
        adapterId: "CADAPTERBLEND",
        stage: "submit",
        attempts: 1,
        transient: false,
        error: "contract trapped",
      },
    ]);
    expect(result.successes).toMatchObject([
      {
        vaultId: "meridian-xlm",
        adapterId: "CADAPTERBLEND2",
        hash: "HASH2",
        attempts: 1,
      },
    ]);
  });

  it("uses the default console logger and sleep when deps are not injected", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const submitAccrual = vi
      .fn()
      .mockRejectedValueOnce(new Error("try again later"))
      .mockResolvedValueOnce({ hash: "HASH", ledger: 123 });

    const run = runBlendAccrualKeeper(CONFIG, {
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      submitAccrual,
    });

    await vi.advanceTimersByTimeAsync(1);
    const result = await run;

    expect(result.successes[0]).toMatchObject({ attempts: 2 });
    expect(info).toHaveBeenCalledWith(
      "[accrual-keeper] discovered adapters",
      expect.any(Object)
    );
    expect(warn).toHaveBeenCalledWith(
      "[accrual-keeper] transient failure; retrying",
      expect.objectContaining({ delayMs: 1 })
    );
  });

  it("uses the default console error logger for failed submissions", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runBlendAccrualKeeper(CONFIG, {
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      submitAccrual: vi.fn(async () => {
        throw "plain failure";
      }),
    });

    expect(error).toHaveBeenCalledWith(
      "[accrual-keeper] accrue failed",
      expect.objectContaining({
        error: "plain failure",
        stage: "submit",
      })
    );
  });

  it("submits accruals through the default Stellar transaction path", async () => {
    const server = makeServer({
      sendTransaction: vi.fn(async () => ({
        hash: "SUBMITTED_HASH",
        status: "PENDING",
      })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 321 });

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      sleep: vi.fn(),
    });

    expect(server.getAccount).toHaveBeenCalledWith("GKEEPER");
    expect(server.simulateTransaction).toHaveBeenCalledOnce();
    expect(stellarMocks.assembleTransaction).toHaveBeenCalledOnce();
    expect(stellarMocks.signPrepared).toHaveBeenCalledOnce();
    expect(server.sendTransaction).toHaveBeenCalledOnce();
    expect(stellarMocks.waitForTransaction).toHaveBeenCalledWith(
      server,
      "SUBMITTED_HASH"
    );
    expect(result.successes).toEqual([
      {
        vaultId: "meridian-usdc",
        adapterId: "CADAPTERBLEND",
        hash: "SUBMITTED_HASH",
        ledger: 321,
        attempts: 1,
      },
    ]);
  });

  it("records simulation errors from the default transaction path", async () => {
    const server = makeServer({
      simulateTransaction: vi.fn(async () => ({
        error: "budget exceeded",
        kind: "error",
      })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      sleep: vi.fn(),
    });

    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(result.failures).toMatchObject([
      {
        stage: "submit",
        attempts: 1,
        transient: false,
        error: "Simulation failed: budget exceeded",
      },
    ]);
  });

  it("records non-success simulation responses from the default transaction path", async () => {
    const server = makeServer({
      simulateTransaction: vi.fn(async () => ({ kind: "pending" })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      sleep: vi.fn(),
    });

    expect(result.failures).toMatchObject([
      {
        stage: "submit",
        attempts: 1,
        transient: false,
        error: "Simulation did not return a successful result",
      },
    ]);
  });

  it("records rejected submissions with the Stellar result name", async () => {
    const server = makeServer({
      sendTransaction: vi.fn(async () => ({
        errorResult: {
          result: () => ({
            switch: () => ({ name: "tx_bad_auth" }),
          }),
        },
        status: "ERROR",
      })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      sleep: vi.fn(),
    });

    expect(result.failures).toMatchObject([
      {
        stage: "submit",
        attempts: 1,
        transient: false,
        error: "Transaction rejected at submission: tx_bad_auth",
      },
    ]);
  });

  it("falls back to an unknown rejected submission error", async () => {
    const server = makeServer({
      sendTransaction: vi.fn(async () => ({
        errorResult: {
          result: () => {
            throw new Error("unreadable xdr");
          },
        },
        status: "ERROR",
      })),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      sleep: vi.fn(),
    });

    expect(result.failures).toMatchObject([
      {
        stage: "submit",
        attempts: 1,
        transient: false,
        error: "Transaction rejected at submission: unknown error",
      },
    ]);
  });

  it("retries try-again-later responses from the default transaction path", async () => {
    const sleep = vi.fn();
    const server = makeServer({
      sendTransaction: vi
        .fn()
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER" })
        .mockResolvedValueOnce({ hash: "RETRY_HASH", status: "PENDING" }),
    });
    stellarMocks.getRpcServer.mockReturnValue(server);
    stellarMocks.waitForTransaction.mockResolvedValue({ ledger: 654 });

    const result = await runBlendAccrualKeeper(CONFIG, {
      logger: logger(),
      discoverAdapters: async () => ({
        adapters: [BLEND_ADAPTER],
        failures: [],
      }),
      sleep,
    });

    expect(server.sendTransaction).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(result.successes).toMatchObject([
      {
        hash: "RETRY_HASH",
        ledger: 654,
        attempts: 2,
      },
    ]);
  });
});
