import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// Catches unexpected render panics, separate from the predictable async data
// failures TanStack Query already surfaces via isError/error (handled inline
// in VaultPanel). A boundary can't recover from a render error other than
// remounting its subtree, so this deliberately only offers a reload.
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      "[ErrorBoundary] caught render error:",
      error,
      info.componentStack
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-2xl border border-red-900/50 bg-red-950/20 p-6 text-center">
          <p className="text-sm text-red-400">
            Something went wrong. Please reload the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 rounded-lg border border-red-800/70 px-4 py-1.5 text-xs font-medium text-red-300 hover:border-red-700 hover:text-red-200 transition-colors duration-150"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
