import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

const { StatusPage } = await import("../../pages/StatusPage");

describe("StatusPage", () => {
  it("renders the status heading", () => {
    render(<StatusPage />);
    expect(screen.getByText("statusPage.heading")).toBeDefined();
    expect(screen.getByText("testnet")).toBeDefined();
    expect(screen.getByText("mainnet")).toBeDefined();
  });

  it("renders contract address labels", () => {
    render(<StatusPage />);
    // Each label appears once per network card (testnet + mainnet)
    expect(
      screen.getAllByText("statusPage.vault").length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText("statusPage.musdc").length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText("statusPage.usdc").length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("statusPage.parameters")).toBeDefined();
  });

  it("shows back-to-app link", () => {
    render(<StatusPage />);
    const link = screen.getByText("statusPage.backToApp");
    expect(link).toBeDefined();
    expect(link.closest("a")?.getAttribute("href")).toBe("/app/");
  });
});
