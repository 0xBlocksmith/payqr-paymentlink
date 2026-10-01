import { describe, expect, it } from "vitest";
import { crc16, pixPayload } from "../lib/pixBrCode";

// The Central Bank's own example from the BR Code manual.
const BACEN_EXAMPLE =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-426655440000" +
  "5204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";

/** A BR Code is valid when its last four characters are the CRC of the rest. */
function crcValid(code: string): boolean {
  return crc16(code.slice(0, -4)) === code.slice(-4);
}

describe("crc16", () => {
  it("matches the CRC-16/CCITT-FALSE check value", () => {
    expect(crc16("123456789")).toBe("29B1");
  });

  it("matches the Bacen example", () => {
    expect(crc16(BACEN_EXAMPLE.slice(0, -4))).toBe("1D3D");
  });
});

describe("pixPayload", () => {
  const RANDOM_KEY = "123e4567-e12b-12d1-a456-426655440000";

  it("builds a payable code with the amount and order id inside", () => {
    const code = pixPayload(RANDOM_KEY, { amount: 10.5, orderId: "760489", merchantName: "Loja" })!;
    expect(code.startsWith("000201")).toBe(true);
    expect(code).toContain("BR.GOV.BCB.PIX");
    expect(code).toContain(`01${RANDOM_KEY.length}${RANDOM_KEY}`);
    expect(code).toContain("540510.50");
    expect(code).toContain("62100506760489");
    expect(code).toContain("5904LOJA");
    expect(crcValid(code)).toBe(true);
  });

  it("leaves the amount out when none is given", () => {
    const code = pixPayload(RANDOM_KEY, {})!;
    // Currency (53) runs straight into country (58): no amount field (54).
    expect(code).toContain("53039865802BR");
    expect(code).toContain("0503***");
    expect(crcValid(code)).toBe(true);
  });

  it("normalizes CPF, phone and email keys", () => {
    expect(pixPayload("123.456.789-09", {})).toContain("011112345678909");
    expect(pixPayload("+55 11 91234-5678", {})).toContain("0114+5511912345678");
    expect(pixPayload("Pay@Example.com", {})).toContain("0115pay@example.com");
  });

  it("strips accents and symbols from the merchant name", () => {
    expect(pixPayload(RANDOM_KEY, { merchantName: "São José & Cia" })).toContain("5913SAO JOSE  CIA");
  });

  it("passes a full BR Code through unchanged", () => {
    expect(pixPayload(` ${BACEN_EXAMPLE} `, { amount: 5 })).toBe(BACEN_EXAMPLE);
  });

  it("returns null for something that is not a Pix key", () => {
    expect(pixPayload("not a key", {})).toBeNull();
    expect(pixPayload("123", {})).toBeNull();
  });
});
