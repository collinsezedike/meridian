import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdminDashboard } from "../../pages/AdminDashboard";

vi.mock("../../components/admin/KeeperHealthPanel", () => ({
  KeeperHealthPanel: () => <div data-testid="keeper-health-panel" />,
}));
vi.mock("../../components/admin/VaultStatePanel", () => ({
  VaultStatePanel: () => <div data-testid="vault-state-panel" />,
}));
vi.mock("../../components/dashboard/AdminActionHistory", () => ({
  AdminActionHistory: () => <div data-testid="admin-action-history" />,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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

describe("AdminDashboard", () => {
  it("renders the keeper health, vault state, and admin history panels", () => {
    render(<AdminDashboard />);

    expect(screen.getByTestId("keeper-health-panel")).toBeDefined();
    expect(screen.getByTestId("vault-state-panel")).toBeDefined();
    expect(screen.getByTestId("admin-action-history")).toBeDefined();
  });
});
