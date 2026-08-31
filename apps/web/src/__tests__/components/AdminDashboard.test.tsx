import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdminDashboard } from "../../pages/AdminDashboard";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { useIsAdminWallet } from "../../hooks/useIsAdminWallet";

const handleConnect = vi.fn();

vi.mock("../../hooks/useWalletConnect", () => ({
  useWalletConnect: vi.fn(),
}));
vi.mock("../../hooks/useIsAdminWallet", () => ({
  useIsAdminWallet: vi.fn(),
}));
vi.mock("../../components/admin/KeeperHealthPanel", () => ({
  KeeperHealthPanel: () => <div data-testid="keeper-health-panel" />,
}));
vi.mock("../../components/admin/VaultStatePanel", () => ({
  VaultStatePanel: () => <div data-testid="vault-state-panel" />,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.setState({ publicKey: null, connected: false });
  vi.mocked(useWalletConnect).mockReturnValue({
    handleConnect,
    status: "idle",
    attemptedWalletId: "freighter",
  } as ReturnType<typeof useWalletConnect>);
});

describe("AdminDashboard", () => {
  it("prompts to connect a wallet when disconnected", () => {
    vi.mocked(useIsAdminWallet).mockReturnValue(false);
    render(<AdminDashboard />);

    expect(screen.getByText("admin.connectPrompt")).toBeDefined();
    expect(screen.queryByTestId("keeper-health-panel")).toBeNull();

    fireEvent.click(screen.getByText("admin.connectPrompt"));
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it("shows a not-authorized message for a connected non-admin wallet", () => {
    useWalletStore.setState({
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      connected: true,
    });
    vi.mocked(useIsAdminWallet).mockReturnValue(false);
    render(<AdminDashboard />);

    expect(screen.getByText("admin.notAuthorized")).toBeDefined();
    expect(screen.queryByTestId("keeper-health-panel")).toBeNull();
  });

  it("shows both panels for a connected admin wallet", () => {
    useWalletStore.setState({
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      connected: true,
    });
    vi.mocked(useIsAdminWallet).mockReturnValue(true);
    render(<AdminDashboard />);

    expect(screen.getByTestId("keeper-health-panel")).toBeDefined();
    expect(screen.getByTestId("vault-state-panel")).toBeDefined();
    expect(screen.queryByText("admin.notAuthorized")).toBeNull();
  });
});
