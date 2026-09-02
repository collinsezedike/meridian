import { Component, type ErrorInfo, type ReactNode } from "react";
import { withTranslation, type WithTranslation } from "react-i18next";

interface ErrorBoundaryProps extends WithTranslation {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// Catches unexpected render panics, separate from the predictable async data
// failures TanStack Query already surfaces via isError/error (handled inline
// in VaultPanel). A boundary can't recover from a render error other than
// remounting its subtree, so this deliberately only offers a reload.
class ErrorBoundaryBase extends Component<
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
      const { t } = this.props;
      return (
        <div className="rounded-2xl border border-red-900/50 bg-red-950/20 p-6 text-center">
          <p className="text-sm text-red-400">{t("errorBoundary.title")}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 rounded-lg border border-red-800/70 px-4 py-1.5 text-xs font-medium text-red-300 hover:border-red-700 hover:text-red-200 transition-colors duration-150"
          >
            {t("errorBoundary.reload")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryBase);
