import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../../components/ui/ErrorBoundary";

vi.mock("react-i18next", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withTranslation: () => (WrappedComponent: any) => {
    function Wrapped(props: Record<string, unknown>) {
      return <WrappedComponent {...props} t={(key: string) => key} />;
    }
    return Wrapped;
  },
}));

function Bomb(): never {
  throw new Error("render panic");
}

describe("ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("fine")).toBeDefined();
  });

  it("catches a render error and shows a fallback instead of crashing", () => {
    // React logs the caught error to the console by default; keep the test
    // output clean since we're deliberately triggering it.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    expect(screen.getByText("errorBoundary.title")).toBeDefined();
    expect(screen.getByText("errorBoundary.reload")).toBeDefined();

    consoleErrorSpy.mockRestore();
  });
});
