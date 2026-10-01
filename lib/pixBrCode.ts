/**
 * Pix BR Code — the scan-to-pay payload Brazilian bank apps read: the Central
 * Bank's implementation of EMVCo QRCPS-MPM. Every field is ID(2) + LENGTH(2) +
 * VALUE, sealed with a CRC16.
 *
 * Adapted from @p2pdotme/widgets src/core/pix-brcode.ts and the Checkout
 * widget's buildBrlQrPayload (MIT, © p2p.me), which the package does not
 * export. The payment-link page used to put the RAW Pix key in its QR and copy
 * it under the label "Pix Copia e Cola" — neither of which a bank app can pay
 * (review M2).
 */

type PixKeyType = "cpf" | "cnpj" | "email" | "phone" | "random";

function tlv(id: string, value: string): string {
  return `${id}${value.length.toString().padStart(2, "0")}${value}`;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflect, no xorout. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function sanitize(s: string, max: number): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .slice(0, max);
}

function buildStaticPixPayload(input: {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  amount?: number;
  txid?: string;
}): string {
  const merchantAccountInfo = tlv("00", "BR.GOV.BCB.PIX") + tlv("01", input.pixKey);
  // txid (EMV 62-05): alphanumeric, ≤25 chars; "***" is Bacen's "no txid".
  const txid = (input.txid ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 25);
  const body =
    tlv("00", "01") +
    tlv("01", "11") +
    tlv("26", merchantAccountInfo) +
    tlv("52", "0000") +
    tlv("53", "986") +
    (input.amount !== undefined ? tlv("54", input.amount.toFixed(2)) : "") +
    tlv("58", "BR") +
    tlv("59", sanitize(input.merchantName, 25) || "PIX") +
    tlv("60", sanitize(input.merchantCity, 15) || "BRASIL") +
    tlv("62", tlv("05", txid || "***"));
  return body + "6304" + crc16(body + "6304");
}

function normalizePixKey(raw: string, keyType: PixKeyType): string {
  const trimmed = raw.trim();
  switch (keyType) {
    case "cpf": {
      const digits = trimmed.replace(/\D/g, "");
      if (digits.length !== 11) throw new Error("CPF key must be 11 digits");
      return digits;
    }
    case "cnpj": {
      const digits = trimmed.replace(/\D/g, "");
      if (digits.length !== 14) throw new Error("CNPJ key must be 14 digits");
      return digits;
    }
    case "phone": {
      const digits = trimmed.replace(/\D/g, "");
      const withCountry = digits.startsWith("55") && digits.length > 11 ? digits : `55${digits}`;
      if (withCountry.length < 12 || withCountry.length > 13) throw new Error("Phone key must be +55 + area + number");
      return `+${withCountry}`;
    }
    case "email": {
      const lower = trimmed.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) throw new Error("Invalid email key");
      return lower;
    }
    case "random": {
      const lower = trimmed.toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(lower)) {
        throw new Error("Invalid random key");
      }
      return lower;
    }
  }
}

/** Best-effort key type for a Pix key with no separate type field. A phone key
 *  always carries its country code; a bare 11-digit number is a CPF. */
function detectPixKeyType(raw: string): PixKeyType {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return "random";
  if (trimmed.includes("@")) return "email";
  if (trimmed.startsWith("+") || (digits.startsWith("55") && (digits.length === 12 || digits.length === 13))) {
    return "phone";
  }
  if (digits.length === 14) return "cnpj";
  if (digits.length === 11) return "cpf";
  return "random";
}

/** Already a full BR Code ("Pix copia e cola"), which p2p.me also accepts as a
 *  partner's Pix ID: payable as it is. */
function isBrCode(s: string): boolean {
  const t = s.trim();
  return /^000201/.test(t) && t.toUpperCase().includes("BR.GOV.BCB.PIX") && /6304[0-9A-F]{4}$/i.test(t);
}

/**
 * The payable Pix code for a partner's Pix ID, with the amount and order id
 * embedded so the bank app fills them in. null when the ID can't be turned into
 * one — the page then shows the key to copy, labelled as a key.
 */
export function pixPayload(pixId: string, opts: { amount?: number; orderId?: string; merchantName?: string }): string | null {
  if (isBrCode(pixId)) return pixId.trim();
  try {
    return buildStaticPixPayload({
      pixKey: normalizePixKey(pixId, detectPixKeyType(pixId)),
      merchantName: opts.merchantName || "PIX",
      merchantCity: "BRASIL",
      txid: opts.orderId,
      amount: opts.amount,
    });
  } catch {
    return null;
  }
}
