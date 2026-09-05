import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Toasts } from "../../components/ui/Toasts";
import { TOAST_DURATION_MS, useToastStore } from "../../store/toast";

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
  render(<Toasts />);
});
afterEach(() => vi.useRealTimers());

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function pushToast(kind: "success" | "error" | "info", message: string) {
  act(() => useToastStore.getState().push(kind, message));
  return screen.getByText(message).closest("div[aria-atomic]") as HTMLElement;
}

describe("Toasts", () => {
  it("dismisses on its own when left alone", () => {
    pushToast("success", "Deposited");
    advance(TOAST_DURATION_MS.success);
    expect(screen.queryByText("Deposited")).toBeNull();
  });

  it("pauses the dismiss timer while hovered and resumes on mouse leave", () => {
    const toast = pushToast("error", "Deposit failed: trustline missing");

    fireEvent.mouseEnter(toast);
    advance(60_000);
    expect(screen.getByText("Deposit failed: trustline missing")).toBeDefined();

    fireEvent.mouseLeave(toast);
    advance(TOAST_DURATION_MS.error);
    expect(screen.queryByText("Deposit failed: trustline missing")).toBeNull();
  });

  it("pauses while focus is inside the toast", () => {
    // A keyboard user tabbing to the dismiss button is reading the toast just
    // as much as a hovering one; focus events bubble, so the wrapper sees it.
    pushToast("info", "Network switched");

    fireEvent.focus(
      screen.getByRole("button", { name: "Dismiss info notification" })
    );
    advance(60_000);
    expect(screen.getByText("Network switched")).toBeDefined();

    fireEvent.blur(
      screen.getByRole("button", { name: "Dismiss info notification" })
    );
    advance(TOAST_DURATION_MS.info);
    expect(screen.queryByText("Network switched")).toBeNull();
  });

  it("still dismisses immediately on the close button while hovered", () => {
    const toast = pushToast("success", "Withdrawn");

    fireEvent.mouseEnter(toast);
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss success notification" })
    );
    expect(screen.queryByText("Withdrawn")).toBeNull();
  });

  it("renders the correct icon and style for each toast kind", () => {
    act(() => {
      useToastStore.setState({
        toasts: [
          { id: "1", kind: "success", message: "Deposit confirmed" },
          { id: "2", kind: "error", message: "Deposit failed" },
          { id: "3", kind: "info", message: "Syncing balances" },
        ],
      });
    });

    const success = screen.getByText("Deposit confirmed").closest("div")!;
    expect(success.textContent).toContain("✓");
    expect(success.className).toContain("border-emerald-700");

    const error = screen.getByText("Deposit failed").closest("div")!;
    expect(error.textContent).toContain("✕");
    expect(error.className).toContain("border-red-800");

    const info = screen.getByText("Syncing balances").closest("div")!;
    expect(info.textContent).toContain("i");
    expect(info.className).toContain("border-gray-700");
  });

  it("gives an error toast role=alert and aria-live=assertive", () => {
    act(() => {
      useToastStore.setState({
        toasts: [{ id: "1", kind: "error", message: "Deposit failed" }],
      });
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Deposit failed");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
  });

  it("does not give success or info toasts role=alert or aria-live=assertive", () => {
    act(() => {
      useToastStore.setState({
        toasts: [
          { id: "1", kind: "success", message: "Deposit confirmed" },
          { id: "2", kind: "info", message: "Syncing balances" },
        ],
      });
    });

    expect(screen.queryByRole("alert")).toBeNull();

    const success = screen.getByText("Deposit confirmed").closest("div")!;
    const info = screen.getByText("Syncing balances").closest("div")!;
    expect(success.getAttribute("aria-live")).toBeNull();
    expect(info.getAttribute("aria-live")).toBeNull();
  });

  it("calls dismiss with the correct toast id when its dismiss button is clicked", () => {
    act(() => {
      useToastStore.setState({
        toasts: [
          { id: "1", kind: "success", message: "first" },
          { id: "2", kind: "error", message: "second" },
        ],
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: /dismiss error notification/i })
    );

    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual(["1"]);
  });
});
