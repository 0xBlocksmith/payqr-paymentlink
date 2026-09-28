"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";

/**
 * Composites a QR code onto the payqr.pro poster template
 * (public/qr_temp_1.jpeg) inside its dashed placeholder square, and renders
 * the result as a single downloadable PNG. The placeholder's position is
 * expressed as a fraction of the template's own dimensions so it stays
 * correct regardless of what size the source image is loaded at.
 */
const TEMPLATE_SRC = "/qr_temp_1.jpeg";

// Dashed square's inner edge, as a fraction of the template image size.
const BOX = { left: 0.213, top: 0.311, right: 0.785, bottom: 0.672 };

export function PaymentLinkPoster({
  url,
  fileName = "payqr-poster.png",
  downloadLabel = "Download poster",
  onPosterReady,
}: {
  url: string;
  fileName?: string;
  downloadLabel?: string;
  /** Fired with the composited poster's data URL each time it (re)composes,
   *  and with null while composing/on error — so a caller (e.g. a Share
   *  button rendered alongside this component) can attach the same image a
   *  user would download, without duplicating the QR-compositing logic. */
  onPosterReady?: (dataUrl: string | null) => void;
}) {
  const qrRef = useRef<HTMLCanvasElement>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Ref so a caller passing a fresh onPosterReady closure every render (the
  // common case — an inline arrow function) doesn't retrigger this effect and
  // re-run the whole compose-from-scratch sequence.
  const onPosterReadyRef = useRef(onPosterReady);
  onPosterReadyRef.current = onPosterReady;

  useEffect(() => {
    let cancelled = false;
    // Drop the previous poster immediately — showing a QR that encodes the
    // OLD link while the new one composites is worse than showing nothing.
    setPosterUrl(null);
    setError(false);
    onPosterReadyRef.current?.(null);

    /** Wait until after the browser has painted, twice.
     *
     *  QRCodeCanvas draws in its OWN effect. This effect and that one both run
     *  in the same commit, and child-vs-parent effect ordering is not something
     *  to rely on — compositing immediately can capture the canvas as it was
     *  for the PREVIOUS url (or blank on first mount). Yielding past a paint
     *  guarantees the QR for THIS url is on the canvas before it's copied. */
    const afterPaint = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );

    async function compose() {
      await afterPaint();
      if (cancelled) return;

      const qrCanvas = qrRef.current;
      if (!qrCanvas) return;

      const template = new Image();
      template.src = TEMPLATE_SRC;
      try {
        await template.decode();
      } catch {
        if (!cancelled) {
          setError(true);
          onPosterReadyRef.current?.(null);
        }
        return;
      }
      if (cancelled) return;

      const canvas = document.createElement("canvas");
      canvas.width = template.naturalWidth;
      canvas.height = template.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(template, 0, 0);

      const boxLeft = BOX.left * canvas.width;
      const boxTop = BOX.top * canvas.height;
      const boxSize = Math.min((BOX.right - BOX.left) * canvas.width, (BOX.bottom - BOX.top) * canvas.height);
      const qrLeft = boxLeft + ((BOX.right - BOX.left) * canvas.width - boxSize) / 2;
      const qrTop = boxTop + ((BOX.bottom - BOX.top) * canvas.height - boxSize) / 2;

      ctx.drawImage(qrCanvas, qrLeft, qrTop, boxSize, boxSize);

      if (!cancelled) {
        const dataUrl = canvas.toDataURL("image/png");
        setPosterUrl(dataUrl);
        onPosterReadyRef.current?.(dataUrl);
      }
    }

    compose();
    return () => { cancelled = true; };
  }, [url]);

  function download() {
    if (!posterUrl) return;
    const a = document.createElement("a");
    a.href = posterUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="poster-wrap">
      {/* Offscreen source QR the composite draws from — not shown directly. */}
      <div style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}>
        <QRCodeCanvas ref={qrRef} value={url} size={512} bgColor="#ffffff" fgColor="#16151f" level="M" />
      </div>

      {error && <div className="sub">Could not load the poster template.</div>}

      {posterUrl && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={posterUrl} alt="Payment QR poster" className="poster-img" />
          <button className="btn" onClick={download} style={{ marginTop: 12, width: "100%" }}>
            {downloadLabel}
          </button>
        </>
      )}

      <style jsx>{`
        .poster-wrap { display: flex; flex-direction: column; align-items: center; margin-top: 16px; }
        .poster-img { width: 100%; max-width: 320px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.12); }
      `}</style>
    </div>
  );
}
