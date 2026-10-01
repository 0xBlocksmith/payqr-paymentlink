"use client";

import { QRCodeSVG } from "qrcode.react";

/**
 * Shared brand styling for a Payment Link QR code — bgColor/fgColor/level,
 * centralized here so the merchant-facing list (app/payment-links/page.tsx),
 * the customer-facing pay screen (components/PaymentLinkWidget.tsx), and any
 * other caller render an identical QR instead of drifting copies.
 */
export const PAYMENT_LINK_QR_STYLE = { bgColor: "#ffffff", fgColor: "#14132b", level: "M" as const };

export function PaymentLinkQR({ url, size = 160 }: { url: string; size?: number }) {
  return (
    <div style={{ display: "inline-block", padding: 12, background: "#fff", borderRadius: 12 }}>
      <QRCodeSVG value={url} size={size} {...PAYMENT_LINK_QR_STYLE} />
    </div>
  );
}
