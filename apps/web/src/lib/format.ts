/**
 * Formats a numeric USD value as a localised currency string.
 *
 * @param value  - The numeric amount to format.
 * @param locale - The i18n locale string (e.g. "en", "fr").
 * @returns A string such as "$1,234.56" or "1 234,56 $US".
 */
export function formatUsd(value: number, locale: string): string {
  return value.toLocaleString(locale === "fr" ? "fr-FR" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
