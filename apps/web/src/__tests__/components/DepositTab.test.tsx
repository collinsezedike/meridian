import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DepositTab } from "../../components/dashboard/DepositTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

const VAULT = {
  id: "meridian-usdc",
  protocol: "meridian" as const,
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

const onAmountChange = vi.fn();
const onAmountKeyDown = vi.fn();
const onSubmit = vi.fn();

class InMemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

Object.defineProperty(window, "localStorage", {
  value: new InMemoryStorage(),
  configurable: true,
});

function renderDepositTab(
  overrides: Partial<Parameters<typeof DepositTab>[0]> = {}
) {
  return render(
    <DepositTab
      amount=""
      onAmountChange={onAmountChange}
      onAmountKeyDown={onAmountKeyDown}
      bestVault={VAULT}
      position={undefined}
      hasPosition={false}
      hasPositionInBestVault={false}
      isDepositing={false}
      onSubmit={onSubmit}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("DepositTab", () => {
  it("calls onSubmit when the deposit button is clicked", () => {
    renderDepositTab({ amount: "25" });

    fireEvent.click(screen.getByTestId("vault-deposit-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button when amount is zero", () => {
    renderDepositTab({ amount: "0" });
    expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
      "disabled",
      true
    );
  });

  it("disables the submit button when amount is negative", () => {
    renderDepositTab({ amount: "-1" });
    expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
      "disabled",
      true
    );
  });

  it("disables the submit button when amount is empty", () => {
    renderDepositTab({ amount: "" });

    const button = screen.getByTestId("vault-deposit-submit");
    expect(button).toHaveProperty("disabled", true);
  });

  it("disables the submit button when isDepositing is true", () => {
    renderDepositTab({ amount: "25", isDepositing: true });

    const button = screen.getByTestId("vault-deposit-submit");
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText("vaultPanel.waiting")).toBeDefined();
  });

  it("shows the current balance when hasPosition is true", () => {
    renderDepositTab({ hasPosition: true, position: POSITION });

    expect(screen.getByText(/vaultPanel.balance/)).toBeDefined();
  });

  it("does not show a balance line when hasPosition is false", () => {
    renderDepositTab({ hasPosition: false });

    expect(screen.queryByText(/vaultPanel.balance/)).toBeNull();
  });

  it("calls onAmountChange when the input value changes", () => {
    renderDepositTab();

    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "42" },
    });

    expect(onAmountChange).toHaveBeenCalledWith("42");
  });

  it("shows the one-time risk disclosure for a new wallet", () => {
    renderDepositTab({ amount: "25", walletAddress: "GA7NEW" });

    expect(screen.getByTestId("deposit-risk-disclosure")).toBeDefined();
    expect(
      screen.getByText("vaultPanel.riskDisclosure.smartContractRisk")
    ).toBeDefined();
    expect(
      screen.getByText("vaultPanel.riskDisclosure.adapterRisk")
    ).toBeDefined();
    expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
      "disabled",
      true
    );
  });

  it("persists risk acknowledgement per wallet after acceptance", () => {
    const { unmount } = renderDepositTab({
      amount: "25",
      walletAddress: "GA7NEW",
    });
    fireEvent.click(screen.getByTestId("deposit-risk-acknowledgement"));

    expect(
      window.localStorage.getItem("meridian.deposit-risk-disclosure:GA7NEW")
    ).toBe("true");
    expect(screen.queryByTestId("deposit-risk-disclosure")).toBeNull();
    expect(screen.getByTestId("vault-deposit-submit")).toHaveProperty(
      "disabled",
      false
    );
    unmount();

    renderDepositTab({ amount: "25", walletAddress: "GA7NEW" });
    expect(screen.queryByTestId("deposit-risk-disclosure")).toBeNull();
  });

  it("uses an independent acknowledgement for another wallet", () => {
    const firstRender = renderDepositTab({
      amount: "25",
      walletAddress: "GA7NEW",
    });
    fireEvent.click(screen.getByTestId("deposit-risk-acknowledgement"));
    firstRender.unmount();

    renderDepositTab({ amount: "25", walletAddress: "GB8OTHER" });
    expect(screen.getByTestId("deposit-risk-disclosure")).toBeDefined();
  });

  it("does not show the disclosure after a wallet already has a position in this vault", () => {
    window.localStorage.removeItem("meridian.deposit-risk-disclosure:GA7NEW");
    renderDepositTab({
      amount: "25",
      walletAddress: "GA7NEW",
      hasPosition: true,
      hasPositionInBestVault: true,
      position: POSITION,
    });

    expect(screen.queryByTestId("deposit-risk-disclosure")).toBeNull();
  });

  it("still shows the disclosure for a first deposit into this vault even if the wallet holds a position in a different, legacy vault", () => {
    window.localStorage.removeItem("meridian.deposit-risk-disclosure:GA7NEW");
    renderDepositTab({
      amount: "25",
      walletAddress: "GA7NEW",
      hasPosition: true,
      hasPositionInBestVault: false,
      position: { ...POSITION, vaultId: "legacy-vault" },
    });

    expect(screen.getByTestId("deposit-risk-disclosure")).toBeDefined();
  });
});
