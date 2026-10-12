# Manual UPI checkout

For INR payment links. Shows the payee's UPI ID and exact amount with copy buttons, and an **Open UPI App** button that opens an app's home screen. It never creates a `upi://pay` link or any payment intent, so the customer types the payee and amount themselves.

Code: `components/UpiManualCheckout.tsx`, `lib/upiAppLaunch.ts`, `lib/clipboard.ts`. Mounted in `PaymentLinkWidget` for INR.

Config: `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` hides the existing `upi://pay` QR and leaves only this flow. Unset, both show (the QR is unchanged).

## Payment status
Nothing here changes order state. Opening an app, copying, or returning to PayQR does nothing to the order. The existing **I've paid** button only asks the protocol to verify, and the order completes only when the on-chain status says so (polled in `PaymentLinkWidget`). The UI says plainly that manual payment is not auto-confirmed.

## What launches what

| Platform | Mechanism | Status |
|---|---|---|
| Android, Chrome | Chrome `intent:` URL with `package=` and MAIN/LAUNCHER (documented syntax: developer.chrome.com/docs/android/intents) | **Unverified on-device.** Chrome's docs say only `BROWSABLE` activities can be invoked; launcher activities usually lack it, so this may do nothing. |
| Android, webviews / Firefox | none | Manual instructions |
| iOS Safari | none | No documented way for a web page to open another app's home screen; custom schemes are undocumented and not used. Manual instructions. |
| Desktop | none | Manual instructions |

Package ids (Google Play): Google Pay `com.google.android.apps.nbu.paisa.user`, PhonePe `com.phonepe.app`, Paytm `net.one97.paytm`.

Because launching is best-effort, `launchUpiApp` watches for the page being hidden/blurred within 1.6 s. If it stays in the foreground the UI tells the customer to open the app themselves. **Do not describe Android launching as working until the checklist below passes.** If it fails everywhere, the feature still works as copy + manual instructions; the Open button just leads to guidance.

## Limitations
- No installed-app detection from the web, so all three apps are offered on Android.
- Detection of "opened" is a heuristic, not proof.
- Copy needs a user tap; falls back to `execCommand` on older browsers, and the toast says so if both fail.
- Translations: hi/pt/es fall back to English for the new strings.

## Customer instructions
Open your UPI app, enter the merchant's UPI ID, enter the exact amount, pay, then return and tap **I Paid**.

## Test checklist
Automated: `npm test` (`test/upiAppLaunch.test.ts`).

**Android Chrome** (on a phone with each app installed, and one without)
- [ ] Copy UPI ID, then paste elsewhere: exact ID; toast shown.
- [ ] Copy amount: `123.45` form, no symbol; toast shown.
- [ ] Open UPI App shows Google Pay / PhonePe / Paytm.
- [ ] Each app: does it open? Record per app + app version + Chrome version in this doc.
- [ ] Not-installed app / launch does nothing: fallback message appears after ~1.6 s, no error page.
- [ ] No payment screen is ever pre-filled.
- [ ] Return to PayQR: order still pending.
- [ ] Android in-app browser (e.g. Instagram): chooser is replaced by manual guidance.

**iOS Safari**
- [ ] Open UPI App shows manual guidance only; no navigation happens.
- [ ] Both copy buttons work (tap-triggered); denial shows the error toast.

**Desktop (Chrome, Firefox, Safari)**
- [ ] Manual guidance only.
- [ ] Copy works on https and on localhost; on plain http the legacy path or the error toast.
- [ ] Layout OK at 320 px and desktop widths; toast not clipped.

**All**
- [ ] With `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` the QR is gone; BRL and other rails unchanged.
- [ ] I've paid → "verifying"; completes only after on-chain confirmation.
