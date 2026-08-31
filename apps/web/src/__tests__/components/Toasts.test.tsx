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
});
