import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VaultPanel } from "../../components/dashboard/VaultPanel";
import { useWalletStore } from "../../store/wallet";
import { useVaults } from "../../hooks/useVaults";
import { usePositions } from "../../hooks/usePositions";
import { useVaultActions } from "../../hooks/useVaultActions";
import { useWalletConnect } from "../../hooks/useWalletConnect";

const refetchPositions = vi.fn();
const deposit = vi.fn(async () => true);
const withdraw = vi.fn(async () => true);
const handleConnect = vi.fn();

const VAULT = {
  id: "meridian-usdc",
  protocol: "meridian",
  asset: "USDC",
  name: "Meridian",
  label: "USDC Vault",
  apy: 8,
  tvl: 10_000,
  userBalance: 0,
  riskLevel: "safe" as const,
};

const POSITION = {
  vaultId: "meridian-usdc",
  shares: 50,
  deposited: 100,
  earned: 5,
  entryTime: 1_700_000_000,
};

vi.mock("../../hooks/useVaults", () => ({ useVaults: vi.fn() }));
vi.mock("../../hooks/usePositions", () => ({ usePositions: vi.fn() }));
vi.mock("../../hooks/useVaultActions", () => ({ useVaultActions: vi.fn() }));
vi.mock("../../hooks/useWalletConnect", () => ({ useWalletConnect: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

function mockVaultsLoaded() {
  vi.mocked(useVaults).mockReturnValue({
    data: { vaults: [VAULT], recommendedVaultId: "meridian-usdc" },
    isLoading: false,
  } as ReturnType<typeof useVaults>);
}

function mockPositions(overrides: Partial<ReturnType<typeof usePositions>>) {
  vi.mocked(usePositions).mockReturnValue({
    data: [],
    isError: false,
    refetch: refetchPositions,
    ...overrides,
  } as ReturnType<typeof usePositions>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.setState({
    publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    connected: true,
    network: "testnet",
  });
  mockVaultsLoaded();
  mockPositions({ isError: false });
  vi.mocked(useVaultActions).mockReturnValue({
    deposit,
    withdraw,
    isDepositing: false,
    isWithdrawing: false,
  } as unknown as ReturnType<typeof useVaultActions>);
  vi.mocked(useWalletConnect).mockReturnValue({
    handleConnect,
    status: "idle",
    attemptedWalletId: "freighter",
  } as ReturnType<typeof useWalletConnect>);
});

describe("VaultPanel — position load error", () => {
  it("shows an error message with a retry button when positions fail to load", () => {
    mockPositions({ isError: true });
    render(<VaultPanel />);

    expect(screen.getByText("vaultPanel.positionsError")).toBeDefined();
    const retryButton = screen.getByText("common.retry");
    fireEvent.click(retryButton);
    expect(refetchPositions).toHaveBeenCalledTimes(1);
  });

  it("keeps the deposit tab usable while positions fail to load", () => {
    mockPositions({ isError: true });
    render(<VaultPanel />);

    const amountInput = screen.getByPlaceholderText("0.00");
    fireEvent.change(amountInput, { target: { value: "10" } });

    const depositButton = screen.getByTestId(
      "vault-deposit-submit"
    ) as HTMLButtonElement;
    expect(depositButton.disabled).toBe(false);
  });

  it("does not show the error message once positions load successfully", () => {
    mockPositions({ isError: false, data: [POSITION] });
    render(<VaultPanel />);

    expect(screen.queryByText("vaultPanel.positionsError")).toBeNull();
  });
});

describe("VaultPanel — disconnected", () => {
  it("prompts to connect instead of showing deposit/withdraw tabs", () => {
    useWalletStore.setState({ publicKey: null, connected: false });
    render(<VaultPanel />);

    expect(screen.getByText("vaultPanel.connectUSDC")).toBeDefined();
    expect(screen.queryByText("vaultPanel.deposit")).toBeNull();
  });

  it("calls handleConnect when the connect button is clicked", () => {
    useWalletStore.setState({ publicKey: null, connected: false });
    render(<VaultPanel />);

    fireEvent.click(screen.getByText("common.connectWallet"));
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });
});

describe("VaultPanel — tab switcher", () => {
  it("translates the tab labels instead of rendering raw tab ids", () => {
    render(<VaultPanel />);

    expect(screen.getByTestId("vault-tab-deposit").textContent).toBe(
      "vaultPanel.deposit"
    );
    expect(screen.getByTestId("vault-tab-withdraw").textContent).toBe(
      "vaultPanel.withdraw"
    );
  });
});

describe("VaultPanel — deposit", () => {
  it("deposits with no slippage floor for a first-time depositor (no existing position)", async () => {
    // No matching position exists yet, so there's no reliable share price
    // to derive a floor from — assuming 1:1 would be wrong for any vault
    // that has already accrued yield, and would revert every first deposit
    // with SlippageExceeded. min_shares_out must be omitted, not guessed.
    render(<VaultPanel />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("vault-deposit-submit"));

    await waitFor(() => {
      expect(deposit).toHaveBeenCalledWith(
        "25",
        "meridian-usdc",
        "USDC",
        undefined
      );
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText("0.00")).toHaveProperty("value", "");
    });
  });

  it("derives the slippage floor from the caller's own position in the recommended vault", async () => {
    mockPositions({ isError: false, data: [POSITION] });
    render(<VaultPanel />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("vault-deposit-submit"));

    await waitFor(() => {
      // POSITION: 50 shares / 100 deposited -> 0.5 share price.
      // 25 * 0.5 = 12.5 expected shares, * 0.995 tolerance = 12.4375.
      expect(deposit).toHaveBeenCalledWith(
        "25",
        "meridian-usdc",
        "USDC",
        "12.4375000"
      );
    });
  });

  it("deposits with no slippage floor when the caller only holds a position in a different vault", async () => {
    // A position in some other (legacy) vault carries an unrelated price
    // and must not be used to compute a floor for a deposit into bestVault.
    mockPositions({
      isError: false,
      data: [{ ...POSITION, vaultId: "blend-usdc-fixed" }],
    });
    render(<VaultPanel />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("vault-deposit-submit"));

    await waitFor(() => {
      expect(deposit).toHaveBeenCalledWith(
        "25",
        "meridian-usdc",
        "USDC",
        undefined
      );
    });
  });
});

describe("VaultPanel — withdraw", () => {
  it("shows the position and calls withdraw with the entered shares", async () => {
    mockPositions({ isError: false, data: [POSITION] });
    render(<VaultPanel />);

    fireEvent.click(screen.getByTestId("vault-tab-withdraw"));
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("vault-withdraw-submit"));

    await waitFor(() => {
      expect(withdraw).toHaveBeenCalledWith(
        "10",
        "meridian-usdc",
        "USDC",
        "19.9000000"
      );
    });
  });

  it("shows the no-position message when withdrawing with nothing deposited", () => {
    mockPositions({ isError: false, data: [] });
    render(<VaultPanel />);

    fireEvent.click(screen.getByTestId("vault-tab-withdraw"));
    expect(screen.getByText("vaultPanel.position")).toBeDefined();
  });
});
