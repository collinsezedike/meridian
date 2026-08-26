import { describe, it, expect } from "vitest";
import { computePosition } from "./positions";

const VAULT = "CVAULT";

describe("computePosition", () => {
  it("returns no position when the address holds zero shares", () => {
    expect(
      computePosition(VAULT, {
        shares: 0n,
        totalShares: 0n,
        totalAssets: 0n,
        principal: 0n,
        entryTime: 0n,
      })
    ).toEqual([]);
  });

  it("reports zero earned for a fresh deposit with no yield", () => {
    const [p] = computePosition(VAULT, {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 100_0000000n,
      principal: 100_0000000n,
      entryTime: 1_700_000_000n,
    });
    expect(p.vaultId).toBe(VAULT);
    expect(p.shares).toBe(100);
    expect(p.deposited).toBe(100);
    expect(p.earned).toBe(0);
    expect(p.entryTime).toBe(1_700_000_000);
  });

  it("derives earned as current share value minus principal", () => {
    // The sole depositor's 100 shares own the whole 110 USDC pool; basis was
    // 100 USDC, so earned is 10.
    const [p] = computePosition(VAULT, {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 110_0000000n,
      principal: 100_0000000n,
      entryTime: 0n,
    });
    expect(p.deposited).toBe(110);
    expect(p.earned).toBe(10);
  });

  it("falls back to zero earned when principal is unknown (pre-upgrade contract)", () => {
    const [p] = computePosition(VAULT, {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 110_0000000n,
      principal: null,
      entryTime: 0n,
    });
    expect(p.deposited).toBe(110);
    expect(p.earned).toBe(0);
  });

  it("never reports negative earned if the share value dips below basis", () => {
    const [p] = computePosition(VAULT, {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 90_0000000n,
      principal: 100_0000000n,
      entryTime: 0n,
    });
    expect(p.earned).toBe(0);
  });
});

describe("computePosition with no recorded cost basis", () => {
  it("reports no yield for a position that arrived by mUSDC transfer", () => {
    // The vault has no basis recorded for a holder whose shares were
    // transferred to them (#504): mUSDC is a Stellar Asset Contract, so the
    // vault never sees the transfer. Treating that missing basis as a basis
    // of zero would show the new holder their entire balance as profit.
    const [position] = computePosition("meridian-usdc", {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 120_0000000n,
      principal: 0n,
      entryTime: 0n,
    });

    expect(position?.deposited).toBe(120);
    expect(position?.earned).toBe(0);
  });

  it("still reports yield for a depositor whose basis is recorded", () => {
    const [position] = computePosition("meridian-usdc", {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 120_0000000n,
      principal: 100_0000000n,
      entryTime: 1n,
    });

    expect(position?.earned).toBe(20);
  });
});
