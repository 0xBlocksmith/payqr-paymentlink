import { describe, expect, it } from "vitest";
import { defaultLangForCountry } from "../lib/countries";

describe("defaultLangForCountry", () => {
  it("India reads English by default", () => expect(defaultLangForCountry("india")).toBe("en"));
  it("Brazil reads Portuguese", () => expect(defaultLangForCountry("brazil")).toBe("pt"));
  it("Argentina and Venezuela read Spanish", () => {
    expect(defaultLangForCountry("argentina")).toBe("es");
    expect(defaultLangForCountry("venezuela")).toBe("es");
  });
  it("anything unknown falls back to English", () => {
    expect(defaultLangForCountry("narnia")).toBe("en");
    expect(defaultLangForCountry(null)).toBe("en");
  });
});
