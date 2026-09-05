import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VaultStatePanel } from "../../components/admin/VaultStatePanel";
import { useVaultState } from "../../hooks/useVaultState";

const refetch = vi.fn();

vi.mock("../../hooks/useVaultState", () => ({
  useVaultState: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

function mock(overrides: Partial<ReturnType<typeof useVaultState>>) {
  vi.mocked(useVaultState).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch,
    ...overrides,
  } as ReturnType<typeof useVaultState>);
}

beforeEach(() => vi.clearAllMocks());

describe("VaultStatePanel", () => {
  it("shows an error state with a retry button when the fetch fails", () => {
    mock({ isError: true });
    render(<VaultStatePanel />);

    expect(screen.getByText("admin.vaultState.loadError")).toBeDefined();
    fireEvent.click(screen.getByText("common.retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the resolved protocol label, shares, assets, and an Active badge", () => {
    mock({
      data: {
        protocol: "blend",
        adapterId: "CADAPTER",
        totalShares: 1234.5,
        totalAssets: 1300.25,
        paused: false,
      },
    });
    render(<VaultStatePanel />);

    expect(screen.getByText("Blend Capital")).toBeDefined();
    expect(screen.getByText("1,234.50")).toBeDefined();
    expect(screen.getByText("1,300.25")).toBeDefined();
    const badge = screen.getByTestId("vault-state-badge");
    expect(badge.textContent).toBe("admin.vaultState.active");
    expect(badge.className).toContain("text-emerald-400");
  });

  it("shows a Paused badge when the vault is paused", () => {
    mock({
      data: {
        protocol: "defindex",
        adapterId: "CADAPTER",
        totalShares: 0,
        totalAssets: 0,
        paused: true,
      },
    });
    render(<VaultStatePanel />);

    const badge = screen.getByTestId("vault-state-badge");
    expect(badge.textContent).toBe("admin.vaultState.paused");
    expect(badge.className).toContain("text-amber-400");
  });

  it("falls back to the raw protocol id when it has no known label", () => {
    mock({
      data: {
        protocol: "unknown-protocol",
        adapterId: "CADAPTER",
        totalShares: 0,
        totalAssets: 0,
        paused: false,
      },
    });
    render(<VaultStatePanel />);

    expect(screen.getByText("unknown-protocol")).toBeDefined();
  });
});
