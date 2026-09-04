import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WithdrawTab } from "../../components/dashboard/WithdrawTab";

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

function renderWithdrawTab(
  overrides: Partial<Parameters<typeof WithdrawTab>[0]> = {}
) {
  return render(
    <WithdrawTab
      amount=""
      onAmountChange={onAmountChange}
      onAmountKeyDown={onAmountKeyDown}
      bestVault={VAULT}
      position={POSITION}
      hasPosition={true}
      isWithdrawing={false}
      onSubmit={onSubmit}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WithdrawTab", () => {
  it("shows the no-position message when hasPosition is false", () => {
    renderWithdrawTab({ hasPosition: false, position: undefined });

    expect(screen.getByText("vaultPanel.position")).toBeDefined();
    expect(screen.queryByTestId("vault-withdraw-submit")).toBeNull();
  });

  it("calls onAmountChange with the max shares when the Max button is clicked", () => {
    renderWithdrawTab();

    fireEvent.click(screen.getByTestId("vault-withdraw-max"));

    expect(onAmountChange).toHaveBeenCalledWith("50.0000000");
  });

  it("renders the Max label through the translation key", () => {
    renderWithdrawTab();

    expect(screen.getByTestId("vault-withdraw-max").textContent).toBe(
      "vaultPanel.max: 50.00"
    );
  });

  it("calls onSubmit when the withdraw button is clicked", () => {
    renderWithdrawTab({ amount: "10" });

    fireEvent.click(screen.getByTestId("vault-withdraw-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button when amount is zero", () => {
    renderWithdrawTab({ amount: "0" });
    expect(screen.getByTestId("vault-withdraw-submit")).toHaveProperty(
      "disabled",
      true
    );
  });

  it("disables the submit button when amount is negative", () => {
    renderWithdrawTab({ amount: "-1" });
    expect(screen.getByTestId("vault-withdraw-submit")).toHaveProperty(
      "disabled",
      true
    );
  });

  it("disables the submit button when amount exceeds available shares", () => {
    renderWithdrawTab({ amount: "999" });

    const button = screen.getByTestId("vault-withdraw-submit");
    expect(button).toHaveProperty("disabled", true);
  });

  it("disables the submit button when isWithdrawing is true", () => {
    renderWithdrawTab({ amount: "10", isWithdrawing: true });

    const button = screen.getByTestId("vault-withdraw-submit");
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText("vaultPanel.waiting")).toBeDefined();
  });

  it("calls onAmountChange when the input value changes", () => {
    renderWithdrawTab();

    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "15" },
    });

    expect(onAmountChange).toHaveBeenCalledWith("15");
  });
});
