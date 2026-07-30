interface AmountInputProps {
  currency: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function AmountInput({
  currency,
  value,
  onChange,
  onKeyDown,
}: AmountInputProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-900/70 px-4 py-3.5 focus-within:border-gray-500 transition-colors duration-150">
      {/* Accessible name for screen readers — ties the input to its currency denomination */}
      <input
        type="number"
        min="0"
        step="any"
        placeholder="0.00"
        aria-label={`Amount in ${currency}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="flex-1 min-w-0 bg-transparent text-white text-xl font-semibold outline-none placeholder:text-gray-700 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="rounded-lg bg-gray-800 border border-gray-700 px-2.5 py-1 text-xs font-semibold text-gray-300 shrink-0">
        {currency}
      </span>
    </div>
  );
}
