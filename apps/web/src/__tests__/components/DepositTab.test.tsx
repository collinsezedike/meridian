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
      isDepositing={false}
      onSubmit={onSubmit}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
