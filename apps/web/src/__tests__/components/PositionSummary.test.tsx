import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PositionSummary } from "../../components/dashboard/PositionSummary";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

const POSITION = {
  vaultId: "meridian-usdc",
  shares: 50,
  deposited: 100,
  earned: 5,
  entryTime: 1_700_000_000,
};

describe("PositionSummary", () => {
  it("shows the deposited amount formatted as currency", () => {
    render(<PositionSummary position={POSITION} />);

    expect(screen.getByText("$100.00")).toBeDefined();
  });

  it("shows the earned amount formatted as currency with a plus sign", () => {
    render(<PositionSummary position={POSITION} />);

    expect(screen.getByText("+$5.00")).toBeDefined();
  });
});
