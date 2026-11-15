import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { translate } from "../lib/i18n";
import * as stage from "../lib/i18n.stage";

const ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "test", "public", "docs", "scripts"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Merchant-facing sources only: the payer-side pages use their own dictionary.
const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components")), ...walk(path.join(ROOT, "lib"))]
  .filter((f) => !/[\\/]app[\\/](pay|p)[\\/]/.test(f) && !/payerI18n|PaymentLinkWidget|i18n(\.stage)?\.tsx?$/.test(f));

const KEY = /\bt\(\s*"([A-Za-z0-9_.]+)"\s*\)/g;

describe("merchant i18n keys", () => {
  const used = new Map<string, string>();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(KEY)) if (!used.has(m[1])) used.set(m[1], path.relative(ROOT, f));
  }

  it("found a realistic number of literal keys (guards the scanner itself)", () => {
    expect(used.size).toBeGreaterThan(150);
  });

  it("every literal t('key') used by merchant code exists in English", () => {
    const missing = [...used].filter(([k]) => translate(k, "en") === k).map(([k, f]) => `${k}  (${f})`);
    expect(missing).toEqual([]);
  });

  it("the dynamic key families resolve", () => {
    const families = [
      ...["learn", "register", "payout", "first", "track"].flatMap((id) => [`setup.${id}.title`, `setup.${id}.desc`]),
      "dispute.tier1", "dispute.tier2", "dispute.tier3",
      "dispute.confirm.escalate", "dispute.confirm.appeal", "dispute.confirm.finalize",
      "status.waiting", "status.receivedOn", "status.receivedSettling", "status.available",
      "status.cancelled", "status.wdProcessing", "status.wdPartial", "status.wdFailed", "status.withdrawn",
      "pl.tabLinks", "pl.tabPayments", "pl.tabSummary",
    ];
    expect(families.filter((k) => translate(k, "en") === k)).toEqual([]);
  });

  it("every new string exists in all four languages (no silent English fallbacks)", () => {
    const en = Object.keys(stage.en).sort();
    for (const lang of ["hi", "pt", "es"] as const) {
      const have = new Set(Object.keys(stage[lang]));
      expect(en.filter((k) => !have.has(k)), lang).toEqual([]);
    }
  });

  it("placeholders match across languages", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    const bad: string[] = [];
    for (const k of Object.keys(stage.en)) {
      for (const lang of ["hi", "pt", "es"] as const) {
        if (ph(stage.en[k]) !== ph(stage[lang][k])) bad.push(`${lang}:${k}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
