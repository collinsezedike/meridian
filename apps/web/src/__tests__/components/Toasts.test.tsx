import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Toasts } from "../../components/ui/Toasts";
import { useToastStore } from "../../store/toast";

beforeEach(() => useToastStore.setState({ toasts: [] }));

describe("Toasts", () => {
  it("renders the correct icon and style for each toast kind", () => {
    useToastStore.setState({
      toasts: [
        { id: "1", kind: "success", message: "Deposit confirmed" },
        { id: "2", kind: "error", message: "Deposit failed" },
        { id: "3", kind: "info", message: "Syncing balances" },
      ],
    });
    render(<Toasts />);

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
    useToastStore.setState({
      toasts: [{ id: "1", kind: "error", message: "Deposit failed" }],
    });
    render(<Toasts />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Deposit failed");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
  });

  it("does not give success or info toasts role=alert or aria-live=assertive", () => {
    useToastStore.setState({
      toasts: [
        { id: "1", kind: "success", message: "Deposit confirmed" },
        { id: "2", kind: "info", message: "Syncing balances" },
      ],
    });
    render(<Toasts />);

    expect(screen.queryByRole("alert")).toBeNull();

    const success = screen.getByText("Deposit confirmed").closest("div")!;
    const info = screen.getByText("Syncing balances").closest("div")!;
    expect(success.getAttribute("aria-live")).toBeNull();
    expect(info.getAttribute("aria-live")).toBeNull();
  });

  it("calls dismiss with the correct toast id when its dismiss button is clicked", () => {
    useToastStore.setState({
      toasts: [
        { id: "1", kind: "success", message: "first" },
        { id: "2", kind: "error", message: "second" },
      ],
    });
    render(<Toasts />);

    fireEvent.click(
      screen.getByRole("button", { name: /dismiss error notification/i })
    );

    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual(["1"]);
  });
});
