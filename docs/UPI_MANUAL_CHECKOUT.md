# Manual UPI checkout

For INR payment links. Shows the payee's UPI ID and exact amount with copy buttons, and an **Open UPI App** button that shows how to open an app. It never creates a `upi://pay` link or any payment intent. The customer types the payee and amount themselves.

Code: `components/UpiManualCheckout.tsx`, `lib/clipboard.ts`. Mounted in `PaymentLinkWidget` for INR.

Config: `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` hides the existing `upi://pay` QR and leaves only this flow. Unset, both show (the QR is unchanged).

## Payment status
Nothing here changes order state. Opening an app, copying, or returning to PayQR does nothing to the order. The existing **I've paid** button only asks the protocol to verify, and the order completes only when the on-chain status says so (polled in `PaymentLinkWidget`). The UI says plainly that manual payment is not auto-confirmed.

## App launching: not supported
There is no supported way for a web page to open another app's home screen, so **Open UPI App shows steps only** (Google Pay / PhonePe / Paytm named, open from your home screen).

Tried and rejected: a Chrome `intent:` URL with `package=` + MAIN/LAUNCHER. Tested on Android Chrome, it opened the app's **Play Store page** instead of the app: Chrome only resolves `BROWSABLE` activities (developer.chrome.com/docs/android/intents) and launcher activities aren't, so the intent is treated as unresolved. iOS has no documented mechanism either; custom URL schemes are undocumented and not used. Removed rather than shipped.

If wanted later: the Play Store listing of an installed app has an Open button, a two-tap path, but it is a store page and should be labelled that way. Only a native/TWA wrapper or the apps' own documented integrations could launch directly.

## Limitations
- No app launching on any platform; the customer opens their app themselves.
- Copy needs a user tap; falls back to `execCommand` on older browsers, and the toast says so if both fail.
- Translations: hi/pt/es fall back to English for the new strings.

## Customer instructions
Open your UPI app, enter the merchant's UPI ID, enter the exact amount, pay, then return and tap **I Paid**.

## Test checklist
Automated: `npm test` (`test/clipboard.test.ts`).

**Android Chrome** (on a phone with each app installed, and one without)
- [ ] Copy UPI ID, then paste elsewhere: exact ID; toast shown.
- [ ] Copy amount: `123.45` form, no symbol; toast shown.
- [ ] Open UPI App shows the manual steps and does NOT navigate away or open the Play Store.
- [ ] No payment screen is ever pre-filled.
- [ ] Return to PayQR: order still pending.

**iOS Safari**
- [ ] Open UPI App shows manual steps; no navigation happens.
- [ ] Both copy buttons work (tap-triggered); denial shows the error toast.

**Desktop (Chrome, Firefox, Safari)**
- [ ] Manual guidance only.
- [ ] Copy works on https and on localhost; on plain http the legacy path or the error toast.
- [ ] Layout OK at 320 px and desktop widths; toast not clipped.

**All**
- [ ] With `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` the QR is gone; BRL and other rails unchanged.
- [ ] I've paid → "verifying"; completes only after on-chain confirmation.
