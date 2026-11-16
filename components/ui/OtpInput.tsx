"use client";

import { useEffect, useRef } from "react";

/**
 * One box per digit. Typing advances, Backspace steps back, pasting (or the
 * phone's SMS autofill) fills every box, and `onComplete` fires once the last
 * digit is in — so the user never has to find a "Verify" button.
 */
export function OtpInput({ value, onChange, onComplete, length = 6, disabled, invalid, autoFocus = true }: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  length?: number;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length }, (_, i) => value[i] || "");

  useEffect(() => { if (autoFocus && !disabled) refs.current[Math.min(value.length, length - 1)]?.focus(); }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit(next: string, focusAt?: number) {
    const v = next.replace(/\D/g, "").slice(0, length);
    onChange(v);
    if (focusAt != null) refs.current[Math.min(focusAt, length - 1)]?.focus();
    if (v.length === length) onComplete?.(v);
  }

  return (
    <div className={`otp ${invalid ? "bad" : ""}`} role="group" aria-label="One-time code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          className="otp-box"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={length}               // allows SMS autofill / paste into any box
          value={d}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, "");
            if (!raw) return commit(value.slice(0, i) + value.slice(i + 1), i);
            if (raw.length > 1) return commit(value.slice(0, i) + raw, i + raw.length);   // paste / autofill
            commit(value.slice(0, i) + raw + value.slice(i + 1), i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d && i > 0) { e.preventDefault(); commit(value.slice(0, i - 1) + value.slice(i), i - 1); }
            else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
            else if (e.key === "ArrowRight" && i < length - 1) refs.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            const txt = e.clipboardData.getData("text").replace(/\D/g, "");
            if (!txt) return;
            e.preventDefault();
            commit(txt, txt.length);
          }}
        />
      ))}
    </div>
  );
}
