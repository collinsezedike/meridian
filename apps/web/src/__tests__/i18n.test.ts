import { describe, it, expect } from "vitest";

import en from "../../messages/en.json";
import fr from "../../messages/fr.json";

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
      : `${prefix}${key}`
  );
}

describe("i18n", () => {
  it("english and french translations have identical keys", () => {
    expect(flatten(en).sort()).toEqual(flatten(fr).sort());
  });
});