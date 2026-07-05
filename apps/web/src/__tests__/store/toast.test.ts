import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useToastStore } from "../../store/toast";

beforeEach(() => useToastStore.setState({ toasts: [] }));
afterEach(() => vi.useRealTimers());

describe("useToastStore", () => {
  it("push adds a toast with the correct kind and message", () => {
    useToastStore.getState().push("success", "Wallet connected");
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: "success",
      message: "Wallet connected",
    });
    expect(typeof toasts[0].id).toBe("string");
  });

  it("push adds multiple toasts in order", () => {
    useToastStore.getState().push("success", "first");
    useToastStore.getState().push("error", "second");
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(2);
    expect(toasts[0].message).toBe("first");
    expect(toasts[1].message).toBe("second");
  });

  it("dismiss removes the toast with the given id", () => {
    useToastStore.getState().push("info", "fyi");
    const { id } = useToastStore.getState().toasts[0];
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("dismiss is a no-op for an unknown id", () => {
    useToastStore.getState().push("error", "boom");
    useToastStore.getState().dismiss("nonexistent-id");
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("auto-dismisses after 4 seconds", () => {
    vi.useFakeTimers();
    useToastStore.getState().push("success", "temp");
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
