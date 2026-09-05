import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  decodeScVal,
  summarizeAction,
  getAdminActionHistory,
  getRpcAdminHistory,
} from "./admin-history";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const VAULT_ID = "CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL";
const VAULT_ADDRESS_B64 =
  "AAAAEgAAAAFcT6XxcJlFQ41NnqEsIYGOuZq8vvntjOrg/qv5VrmySQ==";
const OTHER_CONTRACT_B64 =
  "AAAAEgAAAAHXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQ==";
const SET_PAUSED_SYM_B64 = "AAAADwAAAApzZXRfcGF1c2VkAAA=";
const DEPOSIT_SYM_B64 = "AAAADwAAAAdkZXBvc2l0AA==";
const CALLER_ADDRESS_B64 =
  "AAAAEgAAAAAAAAAAQj59BfLsr7/sGSshWj8b6WrtuNjnAlSr40E+AgfeVrI=";
const BOOL_TRUE_B64 = "AAAAAAAAAAE=";

function operationsPage(
  records: Array<{
    id: string;
    transaction_hash: string;
    created_at: string;
    source_account: string;
    parameters?: Array<{ type: string; value: string }>;
  }>,
  nextHref?: string
) {
  return {
    ok: true,
    json: async () => ({
      _embedded: { records },
      _links: nextHref ? { next: { href: nextHref } } : {},
    }),
  };
}

describe("decodeScVal", () => {
  it("decodes a contract address from base64", () => {
    const result = decodeScVal(
      "AAAAEgAAAAEJIX5C6S3X6ftDOw+T3MtGCdZN6Xv2zEfpPmTF42f8og=="
    );
    expect(result).not.toBeNull();
    expect(result?.switchName).toBe("scvAddress");
    expect(result?.value).toBe(
      "CAESC7SC5EW5P2P3IM5Q7E64ZNDATVSN5F57NTCH5E7GJRPDM76KF7QM"
    );
  });

  it("decodes a symbol from base64", () => {
    const result = decodeScVal("AAAADwAAAARwdXNo");
    expect(result).not.toBeNull();
    expect(result?.switchName).toBe("scvSymbol");
    expect(result?.value).toBe("push");
  });

  it("decodes a u64 from base64", () => {
    const result = decodeScVal("AAAABQAAAAAB4386");
    expect(result).not.toBeNull();
    expect(result?.switchName).toBe("scvU64");
    expect(result?.value).toBe("31686458");
  });

  it("returns null for invalid base64", () => {
    expect(decodeScVal("not-valid-base64!!!")).toBeNull();
  });
});

describe("summarizeAction", () => {
  it("summarizes set_paused with true", () => {
    expect(
      summarizeAction("set_paused", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "set_paused" },
        { type: "Bool", value: true },
      ])
    ).toBe("Vault deposits paused");
  });

  it("summarizes set_paused with false", () => {
    expect(
      summarizeAction("set_paused", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "set_paused" },
        { type: "Bool", value: false },
      ])
    ).toBe("Vault deposits unpaused");
  });

  it("summarizes set_admin with an address", () => {
    expect(
      summarizeAction("set_admin", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "set_admin" },
        {
          type: "Address",
          value: "GNEWADMIN234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDE",
        },
      ])
    ).toBe("New admin set to GNEWADMI...BCDE");
  });

  it("falls back to a generic message when set_admin's address param is missing", () => {
    expect(
      summarizeAction("set_admin", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "set_admin" },
      ])
    ).toBe("Admin address changed");
  });

  it("falls back to a generic message when set_paused's bool param is missing", () => {
    expect(
      summarizeAction("set_paused", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "set_paused" },
      ])
    ).toBe("Pause state toggled");
  });

  it("summarizes set_adapter with an address", () => {
    expect(
      summarizeAction("set_adapter", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "set_adapter" },
        {
          type: "Address",
          value: "CNEWADAPTER34567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCD",
        },
      ])
    ).toBe("Adapter switched to CNEWADAP...ABCD");
  });

  it("falls back to a generic message when set_adapter's address param is missing", () => {
    expect(
      summarizeAction("set_adapter", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "set_adapter" },
      ])
    ).toBe("Adapter updated");
  });

  it("summarizes migrate_adapter", () => {
    expect(
      summarizeAction("migrate_adapter", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "migrate_adapter" },
        {
          type: "Address",
          value: "CNEWADAPTER34567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCD",
        },
      ])
    ).toBe("Migrated adapter to CNEWADAP...ABCD");
  });

  it("falls back to a generic message when migrate_adapter's address param is missing", () => {
    expect(
      summarizeAction("migrate_adapter", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "migrate_adapter" },
      ])
    ).toBe("Adapter migrated");
  });

  it("summarizes begin_migration with the target adapter address", () => {
    expect(
      summarizeAction("begin_migration", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "begin_migration" },
        {
          type: "Address",
          value: "CNEWADAPTER34567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCD",
        },
      ])
    ).toBe("Migration cooldown started for CNEWADAP...ABCD");
  });

  it("falls back to a generic message when begin_migration's address param is missing", () => {
    expect(
      summarizeAction("begin_migration", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "begin_migration" },
      ])
    ).toBe("Migration cooldown started");
  });

  it("summarizes transfer_admin with a nominee address", () => {
    expect(
      summarizeAction("transfer_admin", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "transfer_admin" },
        {
          type: "Address",
          value: "GNOMINEE234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEF",
        },
      ])
    ).toBe("Admin transfer nominated GNOMINEE...CDEF");
  });

  it("falls back to a generic message when transfer_admin's nominee param is missing", () => {
    expect(
      summarizeAction("transfer_admin", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "transfer_admin" },
      ])
    ).toBe("Admin transfer initiated");
  });

  it("summarizes accept_admin without extra params", () => {
    expect(
      summarizeAction("accept_admin", [
        { type: "Address", value: "C..." },
        { type: "Sym", value: "accept_admin" },
      ])
    ).toBe("Admin transfer accepted");
  });
});

describe("getAdminActionHistory", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns actions matching the vault contract and an admin function", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      operationsPage([
        {
          id: "op1",
          transaction_hash: "HASH1",
          created_at: "2026-08-27T20:00:00Z",
          source_account: "GADMIN",
          parameters: [
            { type: "Address", value: VAULT_ADDRESS_B64 },
            { type: "Sym", value: SET_PAUSED_SYM_B64 },
            { type: "Bool", value: BOOL_TRUE_B64 },
          ],
        },
      ]) as never
    );

    const actions = await getAdminActionHistory(network, VAULT_ID);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: "op1",
      type: "set_paused",
      transactionHash: "HASH1",
      sourceAccount: "GADMIN",
      summary: "Vault deposits paused",
    });
  });

  it("skips operations against a different contract", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      operationsPage([
        {
          id: "op1",
          transaction_hash: "HASH1",
          created_at: "2026-08-27T20:00:00Z",
          source_account: "GADMIN",
          parameters: [
            { type: "Address", value: OTHER_CONTRACT_B64 },
            { type: "Sym", value: SET_PAUSED_SYM_B64 },
          ],
        },
      ]) as never
    );

    const actions = await getAdminActionHistory(network, VAULT_ID);
    expect(actions).toEqual([]);
  });

  it("skips operations calling a non-admin function on the vault", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      operationsPage([
        {
          id: "op1",
          transaction_hash: "HASH1",
          created_at: "2026-08-27T20:00:00Z",
          source_account: "GUSER",
          parameters: [
            { type: "Address", value: VAULT_ADDRESS_B64 },
            { type: "Sym", value: DEPOSIT_SYM_B64 },
            { type: "Address", value: CALLER_ADDRESS_B64 },
          ],
        },
      ]) as never
    );

    const actions = await getAdminActionHistory(network, VAULT_ID);
    expect(actions).toEqual([]);
  });

  it("skips operations with fewer than two parameters", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      operationsPage([
        {
          id: "op1",
          transaction_hash: "HASH1",
          created_at: "2026-08-27T20:00:00Z",
          source_account: "GADMIN",
          parameters: [{ type: "Address", value: VAULT_ADDRESS_B64 }],
        },
      ]) as never
    );

    const actions = await getAdminActionHistory(network, VAULT_ID);
    expect(actions).toEqual([]);
  });

  it("follows the next cursor across pages until exhausted", async () => {
    const page1 = operationsPage(
      [
        {
          id: "op1",
          transaction_hash: "HASH1",
          created_at: "2026-08-27T20:00:00Z",
          source_account: "GADMIN",
          parameters: [
            { type: "Address", value: VAULT_ADDRESS_B64 },
            { type: "Sym", value: SET_PAUSED_SYM_B64 },
          ],
        },
      ],
      "https://horizon-testnet.stellar.org/operations?cursor=PAGE2"
    );
    const page2 = operationsPage([
      {
        id: "op2",
        transaction_hash: "HASH2",
        created_at: "2026-08-27T20:05:00Z",
        source_account: "GADMIN",
        parameters: [
          { type: "Address", value: VAULT_ADDRESS_B64 },
          { type: "Sym", value: SET_PAUSED_SYM_B64 },
        ],
      },
    ]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(page1 as never)
      .mockResolvedValueOnce(page2 as never);

    const actions = await getAdminActionHistory(network, VAULT_ID);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(actions.map((a) => a.id)).toEqual(["op1", "op2"]);
  });

  it("stops paging once the requested limit is reached", async () => {
    const page1 = operationsPage(
      [
        {
          id: "op1",
          transaction_hash: "HASH1",
          created_at: "2026-08-27T20:00:00Z",
          source_account: "GADMIN",
          parameters: [
            { type: "Address", value: VAULT_ADDRESS_B64 },
            { type: "Sym", value: SET_PAUSED_SYM_B64 },
          ],
        },
      ],
      "https://horizon-testnet.stellar.org/operations?cursor=PAGE2"
    );
    vi.mocked(fetch).mockResolvedValueOnce(page1 as never);

    const actions = await getAdminActionHistory(network, VAULT_ID, {
      limit: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(actions).toHaveLength(1);
  });

  it("throws when the Horizon request fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as never);

    await expect(getAdminActionHistory(network, VAULT_ID)).rejects.toThrow(
      /Horizon operations request failed: 503/
    );
  });
});

describe("getRpcAdminHistory", () => {
  const NEW_ADMIN = "GC7MCAT5QBXWXOUDN57SFAM3T353J7KMNVDRK4J5ZSILUJVRL7M3OUIN";
  const OLD_ADAPTER =
    "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
  const NEW_ADAPTER =
    "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";

  function adminEvent(
    action: string,
    value: xdr.ScVal,
    ledgerClosedAt = "2026-08-27T20:00:00Z"
  ): rpc.Api.EventResponse {
    return {
      type: "contract",
      ledger: 100,
      ledgerClosedAt,
      id: "0000000100000000-0000000001",
      pagingToken: "0000000100000000-0000000001",
      topic: [xdr.ScVal.scvSymbol("admin"), xdr.ScVal.scvSymbol(action)],
      value,
      inSuccessfulContractCall: true,
      txHash: "HASH",
    } as unknown as rpc.Api.EventResponse;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a paused event", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("paused", xdr.ScVal.scvBool(true))],
      latestLedger: 100,
      cursor: "next-cursor",
    } as never);

    const { actions, nextCursor } = await getRpcAdminHistory(
      network.rpcUrl,
      VAULT_ID
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: "paused",
      ledgerSequence: 100,
      payload: { paused: true },
    });
    expect(actions[0]!.timestamp).toEqual(new Date("2026-08-27T20:00:00Z"));
    expect(nextCursor).toBe("next-cursor");
  });

  it("parses a transfer event", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("transfer", Address.fromString(NEW_ADMIN).toScVal())],
      latestLedger: 100,
    } as never);

    const { actions } = await getRpcAdminHistory(network.rpcUrl, VAULT_ID);

    expect(actions[0]).toMatchObject({
      action: "transfer",
      payload: { newAdmin: NEW_ADMIN },
    });
  });

  it("parses an accept event", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("accept", Address.fromString(NEW_ADMIN).toScVal())],
      latestLedger: 100,
    } as never);

    const { actions } = await getRpcAdminHistory(network.rpcUrl, VAULT_ID);

    expect(actions[0]).toMatchObject({
      action: "accept",
      payload: { newAdmin: NEW_ADMIN },
    });
  });

  it("parses an adapter event", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [
        adminEvent("adapter", Address.fromString(NEW_ADAPTER).toScVal()),
      ],
      latestLedger: 100,
    } as never);

    const { actions } = await getRpcAdminHistory(network.rpcUrl, VAULT_ID);

    expect(actions[0]).toMatchObject({
      action: "adapter",
      payload: { newAdapter: NEW_ADAPTER },
    });
  });

  it("parses a migrate event with old and new adapter addresses", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [
        adminEvent(
          "migrate",
          xdr.ScVal.scvVec([
            Address.fromString(OLD_ADAPTER).toScVal(),
            Address.fromString(NEW_ADAPTER).toScVal(),
          ])
        ),
      ],
      latestLedger: 100,
    } as never);

    const { actions } = await getRpcAdminHistory(network.rpcUrl, VAULT_ID);

    expect(actions[0]).toMatchObject({
      action: "migrate",
      payload: { oldAdapter: OLD_ADAPTER, newAdapter: NEW_ADAPTER },
    });
  });

  it("skips events with an unrecognised action symbol", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("unknown_action", xdr.ScVal.scvBool(true))],
      latestLedger: 100,
    } as never);

    const { actions } = await getRpcAdminHistory(network.rpcUrl, VAULT_ID);

    expect(actions).toHaveLength(0);
  });

  it("skips a migrate event with fewer than two vec items", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [
        adminEvent("migrate", xdr.ScVal.scvVec([xdr.ScVal.scvBool(true)])),
      ],
      latestLedger: 100,
    } as never);

    const { actions } = await getRpcAdminHistory(network.rpcUrl, VAULT_ID);

    expect(actions).toHaveLength(0);
  });

  it("skips a paused event whose value is not a bool", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("paused", xdr.ScVal.scvSymbol("not-a-bool"))],
      latestLedger: 100,
    } as never);

    const { actions } = await getRpcAdminHistory(network.rpcUrl, VAULT_ID);

    expect(actions).toHaveLength(0);
  });

  it("omits timestamp when ledgerClosedAt is not provided", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce({
      events: [adminEvent("paused", xdr.ScVal.scvBool(true), "")],
      latestLedger: 100,
    } as never);

    const { actions } = await getRpcAdminHistory(network.rpcUrl, VAULT_ID);

    expect(actions[0]!.timestamp).toBeUndefined();
  });

  it("uses a cursor request instead of startLedger when a cursor is supplied", async () => {
    const spy = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({ events: [], latestLedger: 100 } as never);

    await getRpcAdminHistory(network.rpcUrl, VAULT_ID, {
      cursor: "some-cursor",
    });

    const callArgs = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.cursor).toBe("some-cursor");
    expect(callArgs).not.toHaveProperty("startLedger");
  });
});
