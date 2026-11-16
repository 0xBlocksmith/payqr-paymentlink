import { describe, expect, it, vi, beforeEach } from "vitest";
import { pickSupportedLang, getLang, detectDeviceLang } from "../lib/i18n";

describe("pickSupportedLang", () => {
  it("maps regional tags to the supported base language", () => {
    expect(pickSupportedLang(["pt-BR"])).toBe("pt");
    expect(pickSupportedLang(["es-AR"])).toBe("es");
    expect(pickSupportedLang(["hi-IN"])).toBe("hi");
    expect(pickSupportedLang(["en-GB"])).toBe("en");
  });
  it("skips unsupported preferences and takes the next supported one", () => {
    expect(pickSupportedLang(["fr-FR", "de", "es-MX"])).toBe("es");
  });
  it("falls back to English when nothing matches or input is empty", () => {
    expect(pickSupportedLang(["ja", "zh-CN"])).toBe("en");
    expect(pickSupportedLang([])).toBe("en");
    expect(pickSupportedLang(undefined)).toBe("en");
  });
  it("is case- and separator-insensitive", () => {
    expect(pickSupportedLang(["PT_br"])).toBe("pt");
  });
});

describe("getLang — device default, manual choice wins", () => {
  beforeEach(() => { vi.stubGlobal("window", globalThis); });

  it("uses the device language when nothing is saved", () => {
    vi.stubGlobal("navigator", { languages: ["pt-BR", "en"], language: "pt-BR" });
    expect(detectDeviceLang()).toBe("pt");
    expect(getLang()).toBe("pt");
  });

  it("a saved manual choice always wins over the device language", () => {
    vi.stubGlobal("navigator", { languages: ["pt-BR"], language: "pt-BR" });
    localStorage.setItem("payqr.lang", "hi");
    expect(getLang()).toBe("hi");
  });

  it("ignores a saved value that isn't a supported language", () => {
    vi.stubGlobal("navigator", { languages: ["es-AR"], language: "es-AR" });
    localStorage.setItem("payqr.lang", "xx");
    expect(getLang()).toBe("es");
  });
});
