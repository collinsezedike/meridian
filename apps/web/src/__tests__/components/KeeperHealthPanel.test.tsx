import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KeeperHealthPanel } from "../../components/admin/KeeperHealthPanel";
import { useKeeperHealth } from "../../hooks/useKeeperHealth";

const refetch = vi.fn();

vi.mock("../../hooks/useKeeperHealth", () => ({
  useKeeperHealth: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: "en" },
  }),
}));

function mock(overrides: Partial<ReturnType<typeof useKeeperHealth>>) {
  vi.mocked(useKeeperHealth).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch,
    ...overrides,
  } as ReturnType<typeof useKeeperHealth>);
}

beforeEach(() => vi.clearAllMocks());

describe("KeeperHealthPanel", () => {
  it("shows an error state with a retry button when the fetch fails", () => {
    mock({ isError: true });
    render(<KeeperHealthPanel />);

    expect(screen.getByText("admin.keeperHealth.loadError")).toBeDefined();
    fireEvent.click(screen.getByText("common.retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows a green status dot and the schedule interval for a healthy keeper", () => {
    mock({
      data: {
        keepers: [
          {
            id: "accrual",
            intervalMs: 15 * 60_000,
            lastSuccessMs: Date.now() - 60_000,
            healthy: true,
          },
        ],
        checkedAt: new Date().toISOString(),
      },
    });
    render(<KeeperHealthPanel />);

    const dot = screen.getByTestId("keeper-status-dot-accrual");
    expect(dot.className).toContain("bg-emerald-500");
    expect(screen.getByText("admin.keeperHealth.healthy")).toBeDefined();
  });

  it("shows a red status dot and reports never-run for a keeper with no recorded success", () => {
    mock({
      data: {
        keepers: [
          {
            id: "migration",
            intervalMs: 60 * 60_000,
            lastSuccessMs: null,
            healthy: false,
          },
        ],
        checkedAt: new Date().toISOString(),
      },
    });
    render(<KeeperHealthPanel />);

    const dot = screen.getByTestId("keeper-status-dot-migration");
    expect(dot.className).toContain("bg-red-500");
    expect(screen.getByText("admin.keeperHealth.stalled")).toBeDefined();
    expect(screen.getByText("admin.keeperHealth.never")).toBeDefined();
  });

  it("reports how overdue a stalled keeper with a prior success is", () => {
    mock({
      data: {
        keepers: [
          {
            id: "migration",
            intervalMs: 60 * 60_000,
            lastSuccessMs: Date.now() - 3 * 60 * 60_000,
            healthy: false,
          },
        ],
        checkedAt: new Date().toISOString(),
      },
    });
    render(<KeeperHealthPanel />);

    expect(
      screen.getByText('admin.keeperHealth.overdueBy:{"duration":"3h"}')
    ).toBeDefined();
  });
});
