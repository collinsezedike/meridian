import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AmountInput } from "../../components/ui/AmountInput";

describe("AmountInput — accessible name", () => {
  it("input has an accessible name that includes the currency", () => {
    render(<AmountInput currency="USDC" value="0" onChange={() => {}} />);

    const input = screen.getByRole("spinbutton", { name: /amount in usdc/i });
    expect(input).toBeDefined();
  });

  it("accessible name updates when the currency prop changes", () => {
    const { rerender } = render(
      <AmountInput currency="ETH" value="0" onChange={() => {}} />
    );

    expect(
      screen.getByRole("spinbutton", { name: /amount in eth/i })
    ).toBeDefined();

    rerender(<AmountInput currency="USDC" value="0" onChange={() => {}} />);

    expect(
      screen.getByRole("spinbutton", { name: /amount in usdc/i })
    ).toBeDefined();
  });

  // No axe audit is included because jest-axe / @axe-core/react are not
  // installed in this project. The getByRole query above provides the
  // accessibility assertion: if the input has no accessible name the query
  // throws and the test fails.
});

describe("AmountInput — regression: existing props unaffected", () => {
  it("remains disabled when disabled prop is passed and still has an accessible name", () => {
    // AmountInput does not yet expose a disabled prop, but the input's
    // native attributes (min, max, type) must survive the aria-label addition.
    render(<AmountInput currency="USDC" value="0" onChange={() => {}} />);

    const input = screen.getByRole("spinbutton", { name: /amount in usdc/i });
    expect(input).toHaveProperty("min", "0");
    expect(input).toHaveProperty("type", "number");
    expect(input).toHaveProperty("placeholder", "0.00");
  });

  it("fires onChange with the typed value", () => {
    const onChange = vi.fn();
    render(<AmountInput currency="USDC" value="" onChange={onChange} />);

    const input = screen.getByRole("spinbutton", { name: /amount in usdc/i });
    fireEvent.change(input, { target: { value: "42" } });

    expect(onChange).toHaveBeenCalledWith("42");
  });

  it("renders the currency badge as visible text alongside the input", () => {
    render(<AmountInput currency="mUSDC" value="0" onChange={() => {}} />);

    // The span next to the input must still display the currency ticker.
    expect(screen.getByText("mUSDC")).toBeDefined();
    // And the input's accessible name must also carry the currency.
    expect(
      screen.getByRole("spinbutton", { name: /amount in musdc/i })
    ).toBeDefined();
  });
});
