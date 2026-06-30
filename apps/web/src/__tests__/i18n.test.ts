import { describe, it, expect } from "vitest";

import en from "../../messages/en.json";
import fr from "../../messages/fr.json";

const locales = {
  fr,
};

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
      : `${prefix}${key}`
  );
}

describe("i18n", () => {
  const englishKeys = flatten(en).sort();

  Object.entries(locales).forEach(([locale, translations]) => {
    it(`${locale} has the same keys as english`, () => {
      expect(flatten(translations).sort()).toEqual(englishKeys);
    })
  })
});
