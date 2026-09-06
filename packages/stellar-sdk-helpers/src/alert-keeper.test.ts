import { describe, it, expect, vi, afterEach } from "vitest";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import {
  formatAlertMessage,
  runAlertKeeper,
  alertCursorKey,
  type AlertKeeperConfig,
} from "./alert-keeper";
import { createInMemoryKeeperHeartbeatStore } from "./keeper-heartbeat";
import type { RpcAdminAction } from "./admin-history";
import type { StellarNetwork } from "./types";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const VAULT_CONTRACT_ID =
  "CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL";
const NEW_ADMIN = "GC7MCAT5QBXWXOUDN57SFAM3T353J7KMNVDRK4J5ZSILUJVRL7M3OUIN";
const NEW_ADAPTER = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const OLD_ADAPTER = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

function adminEvent(
  action: string,
  value: xdr.ScVal,
  ledger = 100
): rpc.Api.EventResponse {
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-09-01T00:00:00Z",
    id: `${ledger}-0`,
    pagingToken: `${ledger}-0`,
    topic: [xdr.ScVal.scvSymbol("admin"), xdr.ScVal.scvSymbol(action)],
    value,
    inSuccessfulContractCall: true,
    txHash: "HASH",
  } as unknown as rpc.Api.EventResponse;
}

function baseConfig(
  overrides: Partial<AlertKeeperConfig> = {}
): AlertKeeperConfig {
  return {
    network,
    webhookUrl: "https://hooks.example.com/webhook",
    maxAttempts: 1,
    baseDelayMs: 0,
    ...overrides,
    rpcTimeoutMs: overrides.rpcTimeoutMs ?? 5_000,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatAlertMessage", () => {
  const at = (action: RpcAdminAction) =>
    formatAlertMessage("meridian-usdc", action);

  it("formats a paused event", () => {
    expect(
      at({ action: "paused", ledgerSequence: 5, payload: { paused: true } })
    ).toContain("PAUSED");
    expect(
      at({ action: "paused", ledgerSequence: 5, payload: { paused: false } })
    ).toContain("unpaused");
  });

  it("formats a transfer event", () => {
    const msg = at({
      action: "transfer",
      ledgerSequence: 5,
      payload: { newAdmin: NEW_ADMIN },
    });
    expect(msg).toContain("admin transfer nominated");
    expect(msg).toContain(NEW_ADMIN.slice(0, 8));
  });

  it("formats an adapter event", () => {
    const msg = at({
      action: "adapter",
      ledgerSequence: 5,
      payload: { newAdapter: NEW_ADAPTER },
    });
    expect(msg).toContain("adapter switched");
  });

  it("formats a migrate event", () => {
    const msg = at({
      action: "migrate",
      ledgerSequence: 5,
      payload: { oldAdapter: OLD_ADAPTER, newAdapter: NEW_ADAPTER },
    });
    expect(msg).toContain("migrated adapter");
  });
});

describe("runAlertKeeper", () => {
  const target = {
    vaultId: "meridian-usdc",
    vaultContractId: VAULT_CONTRACT_ID,
  };

  it("starts from the current ledger when no cursor is stored, without alerting on history", async () => {
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValueOnce({
      id: "x",
      sequence: 500,
      protocolVersion: "22",
    });
    const getEventsSpy = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({ events: [], latestLedger: 500 } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    const fetchImpl = vi.fn();

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    const [request] = getEventsSpy.mock.calls[0]!;
    expect((request as { startLedger?: number }).startLedger).toBe(500);
    expect(result.alertsSent).toEqual([]);
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(500);
  });

  it("uses the stored cursor and never calls getLatestLedger when one exists", async () => {
    const getLatestLedgerSpy = vi.spyOn(
      rpc.Server.prototype,
      "getLatestLedger"
    );
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [],
      latestLedger: 500,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);

    await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl: vi.fn(),
    });

    expect(getLatestLedgerSpy).not.toHaveBeenCalled();
  });

  it("sends an alert for a qualifying action and advances the cursor past it", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("paused", xdr.ScVal.scvBool(true), 300)],
      latestLedger: 300,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://hooks.example.com/webhook");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.text).toContain("PAUSED");
    expect(body.content).toBe(body.text);

    expect(result.alertsSent).toEqual([
      { vaultId: "meridian-usdc", action: "paused", ledgerSequence: 300 },
    ]);
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(301);
  });

  it("does not alert on an accept_admin event but still advances past it", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [
        adminEvent("accept", Address.fromString(NEW_ADMIN).toScVal(), 300),
      ],
      latestLedger: 300,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi.fn();

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.alertsSent).toEqual([]);
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(301);
  });

  it("stops the cursor at the last successful action when a send fails", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [
        adminEvent("paused", xdr.ScVal.scvBool(true), 300),
        adminEvent("adapter", Address.fromString(NEW_ADAPTER).toScVal(), 310),
      ],
      latestLedger: 310,
    } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl,
    });

    expect(result.alertsSent).toEqual([
      { vaultId: "meridian-usdc", action: "paused", ledgerSequence: 300 },
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      vaultId: "meridian-usdc",
      stage: "send",
    });
    // Cursor stops at 301 (past the succeeded paused event), not 311, so the
    // failed adapter event is retried on the next run.
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(301);
  });

  it("records a discover failure and leaves the cursor untouched", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockRejectedValueOnce(
      new Error("RPC down")
    );

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(alertCursorKey(VAULT_CONTRACT_ID, "testnet"), 200);

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target],
      cursorStore,
      fetchImpl: vi.fn(),
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      vaultId: "meridian-usdc",
      stage: "discover",
    });
    expect(
      await cursorStore.get(alertCursorKey(VAULT_CONTRACT_ID, "testnet"))
    ).toBe(200);
  });

  it("checks every vault independently", async () => {
    const secondTarget = {
      vaultId: "meridian-eurc",
      vaultContractId:
        "CDIFFERENTVAULTCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    };
    vi.spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({
        events: [adminEvent("paused", xdr.ScVal.scvBool(true), 300)],
        latestLedger: 300,
      } as never)
      .mockResolvedValueOnce({ events: [], latestLedger: 300 } as never);

    const cursorStore = createInMemoryKeeperHeartbeatStore();
    await cursorStore.set(
      alertCursorKey(target.vaultContractId, "testnet"),
      200
    );
    await cursorStore.set(
      alertCursorKey(secondTarget.vaultContractId, "testnet"),
      200
    );
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    const result = await runAlertKeeper(baseConfig(), {
      targets: [target, secondTarget],
      cursorStore,
      fetchImpl,
    });

    expect(result.vaultsChecked).toBe(2);
    expect(result.alertsSent).toHaveLength(1);
  });
});
