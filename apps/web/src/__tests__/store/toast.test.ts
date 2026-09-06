import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TOAST_DURATION_MS, useToastStore } from "../../store/toast";

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

describe("useToastStore dismiss timing", () => {
  beforeEach(() => vi.useFakeTimers());

  it("gives an error toast a longer read window than a success toast", () => {
    useToastStore.getState().push("error", "Deposit failed: trustline missing");
    vi.advanceTimersByTime(TOAST_DURATION_MS.success);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_DURATION_MS.error - TOAST_DURATION_MS.success);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("pauseTimer keeps a toast on screen for as long as it is held", () => {
    useToastStore.getState().push("success", "temp");
    const { id } = useToastStore.getState().toasts[0];

    vi.advanceTimersByTime(1000);
    useToastStore.getState().pauseTimer(id);
    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("resumeTimer finishes the remaining window, not a fresh one", () => {
    useToastStore.getState().push("success", "temp");
    const { id } = useToastStore.getState().toasts[0];

    vi.advanceTimersByTime(3000);
    useToastStore.getState().pauseTimer(id);
    vi.advanceTimersByTime(60_000);
    useToastStore.getState().resumeTimer(id);

    vi.advanceTimersByTime(999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("does not lose time on a repeated pause", () => {
    // Two mouseenter events without an intervening mouseleave (e.g. moving
    // between the message and the dismiss button) must not subtract the same
    // elapsed time twice and dismiss early.
    useToastStore.getState().push("success", "temp");
    const { id } = useToastStore.getState().toasts[0];

    vi.advanceTimersByTime(1000);
    useToastStore.getState().pauseTimer(id);
    vi.advanceTimersByTime(5000);
    useToastStore.getState().pauseTimer(id);
    useToastStore.getState().resumeTimer(id);

    vi.advanceTimersByTime(2999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("survives several hover/unhover cycles", () => {
    useToastStore.getState().push("info", "fyi");
    const { id } = useToastStore.getState().toasts[0];

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000);
      useToastStore.getState().pauseTimer(id);
      vi.advanceTimersByTime(10_000);
      useToastStore.getState().resumeTimer(id);
    }
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("resumeTimer without a pause is a no-op", () => {
    useToastStore.getState().push("success", "temp");
    const { id } = useToastStore.getState().toasts[0];

    vi.advanceTimersByTime(2000);
    useToastStore.getState().resumeTimer(id);
    vi.advanceTimersByTime(2000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("pause and resume are no-ops for an unknown id", () => {
    useToastStore.getState().push("success", "temp");
    expect(() => {
      useToastStore.getState().pauseTimer("nonexistent-id");
      useToastStore.getState().resumeTimer("nonexistent-id");
    }).not.toThrow();
    vi.advanceTimersByTime(TOAST_DURATION_MS.success);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("dismiss cancels a pending timer", () => {
    useToastStore.getState().push("success", "first");
    const { id } = useToastStore.getState().toasts[0];
    useToastStore.getState().dismiss(id);
    useToastStore.setState({
      toasts: [{ id, kind: "info", message: "reused" }],
    });

    vi.advanceTimersByTime(TOAST_DURATION_MS.success);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
