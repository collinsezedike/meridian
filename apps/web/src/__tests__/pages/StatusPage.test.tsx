import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPage } from "../../pages/StatusPage";
import { I18nextProvider } from "react-i18next";
import i18n from "../../i18n";

describe("StatusPage", () => {
  it("renders the status heading", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatusPage />
      </I18nextProvider>
    );

    expect(screen.getByText(/System Status/i)).toBeDefined();
    expect(screen.getByText(/testnet/i)).toBeDefined();
    expect(screen.getByText(/mainnet/i)).toBeDefined();
  });

  it("renders contract address labels", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatusPage />
      </I18nextProvider>
    );

    expect(screen.getByText(/Vault/i)).toBeDefined();
    expect(screen.getByText(/mUSDC/i)).toBeDefined();
    expect(screen.getByText(/USDC/i)).toBeDefined();
    expect(screen.getByText(/Parameters/i)).toBeDefined();
  });

  it("shows back-to-app link", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StatusPage />
      </I18nextProvider>
    );

    const link = screen.getByText(/Back to app/i);
    expect(link).toBeDefined();
    expect(link.closest("a")?.getAttribute("href")).toBe("/app/");
  });
});
