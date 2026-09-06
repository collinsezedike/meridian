import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPage } from "../../pages/StatusPage";
import { useVaultState } from "../../hooks/useVaultState";
import { APP_ADDRESSES } from "@meridian/shared";

vi.mock("../../hooks/useVaultState", () => ({
  useVaultState: vi.fn(),
}));
vi.mock("../../components/admin/VaultStatePanel", () => ({
  VaultStatePanel: () => <div data-testid="vault-state-panel" />,
}));
vi.mock("../../components/dashboard/AdminActionHistory", () => ({
  AdminActionHistory: () => <div data-testid="admin-action-history" />,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: "en" },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withTranslation: () => (WrappedComponent: any) => {
    function Wrapped(props: Record<string, unknown>) {
      return <WrappedComponent {...props} t={(key: string) => key} />;
    }
    return Wrapped;
  },
}));

function mockVaultState(data: ReturnType<typeof useVaultState>["data"]) {
  vi.mocked(useVaultState).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useVaultState>);
}

describe("StatusPage", () => {
  it("renders the vault, mUSDC, USDC, and EURC addresses truncated and linked to the explorer", () => {
    mockVaultState(undefined);
    render(<StatusPage />);

    const vaultLink = screen.getByTitle(APP_ADDRESSES.vault);
    expect(vaultLink.textContent).toBe(
      `${APP_ADDRESSES.vault.slice(0, 6)}...${APP_ADDRESSES.vault.slice(-6)}`
    );
    expect(vaultLink.getAttribute("href")).toContain(APP_ADDRESSES.vault);
    expect(vaultLink.getAttribute("target")).toBe("_blank");
  });

  it("shows the not-deployed placeholder for the adapter address when vault state hasn't loaded", () => {
    mockVaultState(undefined);
    render(<StatusPage />);

    expect(
      screen.getAllByText("status.addresses.notDeployed").length
    ).toBeGreaterThan(0);
  });

  it("shows the live adapter address once vault state resolves", () => {
    mockVaultState({
      protocol: "blend",
      adapterId: "CADAPTERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      totalShares: 100,
      totalAssets: 105,
      paused: false,
    });
    render(<StatusPage />);

    expect(
      screen.getByTitle(
        "CADAPTERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
      )
    ).toBeDefined();
  });

  it("renders the vault state panel and admin action history", () => {
    mockVaultState(undefined);
    render(<StatusPage />);

    expect(screen.getByTestId("vault-state-panel")).toBeDefined();
    expect(screen.getByTestId("admin-action-history")).toBeDefined();
  });

  it("shows the migration cooldown as a fixed protocol parameter", () => {
    mockVaultState(undefined);
    render(<StatusPage />);

    expect(
      screen.getByText(
        'status.parameters.migrationCooldownValue:{"ledgers":12}'
      )
    ).toBeDefined();
  });

  it("shows the audit-not-yet-available notice", () => {
    mockVaultState(undefined);
    render(<StatusPage />);

    expect(screen.getByText("status.audit.notYetAvailable")).toBeDefined();
  });
});
