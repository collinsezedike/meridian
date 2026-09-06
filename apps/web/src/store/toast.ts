import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

// Error messages are usually longer and matter more than a short success
// confirmation ("Deposit failed: ..." vs. "Deposited"), so they get a longer
// read window rather than the same one every kind used to share.
export const TOAST_DURATION_MS: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  error: 8000,
};

// Timers live outside the store: they're imperative handles, not rendered
// state, and keeping them out means pausing/resuming never re-renders the
// toast list.
interface ToastTimer {
  handle: ReturnType<typeof setTimeout>;
  // What is left of the dismiss window; recomputed on every pause so a toast
  // hovered several times still disappears after its full duration of
  // *un-hovered* time rather than restarting from scratch each time.
  remainingMs: number;
  startedAt: number;
  paused: boolean;
}

const timers = new Map<string, ToastTimer>();

interface ToastStore {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: string) => void;
  // Called while the user is hovering or keyboard-focused inside a toast, so
  // a message can't vanish mid-read.
  pauseTimer: (id: string) => void;
  resumeTimer: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => {
  function clearTimer(id: string) {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer.handle);
    timers.delete(id);
  }

  function remove(id: string) {
    clearTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }

  function startTimer(id: string, remainingMs: number) {
    timers.set(id, {
      handle: setTimeout(() => remove(id), remainingMs),
      remainingMs,
      startedAt: Date.now(),
      paused: false,
    });
  }

  return {
    toasts: [],
    push: (kind, message) => {
      const id = `${Date.now()}-${Math.random()}`;
      set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
      startTimer(id, TOAST_DURATION_MS[kind]);
    },
    dismiss: (id) => remove(id),
    pauseTimer: (id) => {
      const timer = timers.get(id);
      if (!timer || timer.paused) return;
      clearTimeout(timer.handle);
      timers.set(id, {
        ...timer,
        remainingMs: Math.max(
          0,
          timer.remainingMs - (Date.now() - timer.startedAt)
        ),
        paused: true,
      });
    },
    resumeTimer: (id) => {
      const timer = timers.get(id);
      if (!timer || !timer.paused) return;
      startTimer(id, timer.remainingMs);
    },
  };
});
