import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AdminLogin } from "../../pages/AdminLogin";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { fetchVaultAdmin } from "@meridian/stellar-sdk-helpers";

const handleConnect = vi.fn();
const ADMIN = "GCKFBEIYTKP6RCZNVPH73XL7XFJVSFAKQR4E4XQD4PGGPCCQTVMWXW6D";
const OTHER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

vi.mock("../../hooks/useWalletConnect", () => ({
  useWalletConnect: vi.fn(),
}));
vi.mock("@meridian/stellar-sdk-helpers", () => ({
  fetchVaultAdmin: vi.fn(),
}));
vi.mock("../../pages/AdminDashboard", () => ({
  AdminDashboard: () => <div data-testid="admin-dashboard" />,
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

describe("AdminLogin", () => {
  it("shows the connect prompt when no wallet is connected", () => {
    render(<AdminLogin />);

    const button = screen.getByText("Connect Wallet");
    expect(button).toBeDefined();

    fireEvent.click(button);
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it("shows the blocked screen with only the connected address for a non-admin wallet", async () => {
    vi.mocked(fetchVaultAdmin).mockResolvedValue(ADMIN);
    useWalletStore.setState({ publicKey: OTHER, connected: true });

    render(<AdminLogin />);

    await waitFor(() => {
      expect(screen.getByText(`Not authorized: ${OTHER}`)).toBeDefined();
    });
    expect(screen.queryByText(ADMIN)).toBeNull();
  });

  it("shows the dashboard shell when the connected wallet matches get_admin", async () => {
    vi.mocked(fetchVaultAdmin).mockResolvedValue(ADMIN);
    useWalletStore.setState({ publicKey: ADMIN, connected: true });

    render(<AdminLogin />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-dashboard")).toBeDefined();
    });
  });

  it("treats a failed admin lookup as blocked", async () => {
    vi.mocked(fetchVaultAdmin).mockRejectedValue(new Error("rpc down"));
    useWalletStore.setState({ publicKey: OTHER, connected: true });

    render(<AdminLogin />);

    await waitFor(() => {
      expect(screen.getByText(`Not authorized: ${OTHER}`)).toBeDefined();
    });
  });
});
