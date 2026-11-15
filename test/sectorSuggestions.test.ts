import { describe, expect, it } from "vitest";
import { translate, type Lang } from "../lib/i18n";

const LANGS: Lang[] = ["en", "hi", "pt", "es"];
const COUNT = 8; // SECTOR_SUGGESTIONS in app/onboarding/page.tsx

describe("onboarding business-type suggestions", () => {
  for (const lang of LANGS) {
    it(`${lang}: every suggestion exists, is translated, and fits the contract's 31-byte limit`, () => {
      const bytes = (s: string) => new TextEncoder().encode(s.trim()).length;
      for (let i = 1; i <= COUNT; i++) {
        const text = translate(`ob.sug.${i}`, lang);
        expect(text, `${lang} ob.sug.${i}`).not.toBe(`ob.sug.${i}`);     // key resolved
        expect(bytes(text), `${lang} "${text}"`).toBeLessThanOrEqual(31); // bytes32 sector
        expect(bytes(text), `${lang} ob.sug.${i} empty`).toBeGreaterThan(0);
      }
    });

    it(`${lang}: suggestions are unique (a duplicate would highlight two chips at once)`, () => {
      const all = Array.from({ length: COUNT }, (_, i) => translate(`ob.sug.${i + 1}`, lang).toLowerCase());
      expect(new Set(all).size).toBe(COUNT);
    });
  }
});
