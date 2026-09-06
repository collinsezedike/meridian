import { useToastStore } from "../../store/toast";

const ICON: Record<string, string> = {
  success: "✓",
  error: "✕",
  info: "i",
};

const STYLES: Record<string, string> = {
  success: "border-emerald-700 bg-emerald-950/80 text-emerald-300",
  error: "border-red-800 bg-red-950/80 text-red-300",
  info: "border-gray-700 bg-gray-900/80 text-gray-300",
};

export function Toasts() {
  const { toasts, dismiss, pauseTimer, resumeTimer } = useToastStore();

  return (
    <div
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-72"
      role="status"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : undefined}
          aria-live={t.kind === "error" ? "assertive" : undefined}
          aria-atomic="true"
          // Pausing on hover and on focus (focus events bubble in React, so
          // this also covers a keyboard user reaching the dismiss button)
          // keeps a toast on screen for as long as it's being read.
          onMouseEnter={() => pauseTimer(t.id)}
          onMouseLeave={() => resumeTimer(t.id)}
          onFocus={() => pauseTimer(t.id)}
          onBlur={() => resumeTimer(t.id)}
          className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-right-4 duration-200 ${STYLES[t.kind]}`}
        >
          <span className="font-bold shrink-0" aria-hidden="true">
            {ICON[t.kind]}
          </span>
          <span className="flex-1 leading-snug">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="shrink-0 opacity-50 hover:opacity-100 transition-opacity duration-100 text-xs"
            aria-label={`Dismiss ${t.kind} notification`}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}
    </div>
  );
}
