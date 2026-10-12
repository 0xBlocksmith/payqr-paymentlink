# Manual UPI checkout

For INR payment links. Shows the payee's UPI ID and exact amount with copy buttons, and Google Pay / PhonePe / Paytm buttons that only open the app. It never creates a `upi://pay` link or any payment intent. The customer types the payee and amount themselves.

Code: `components/UpiManualCheckout.tsx`, `lib/upiAppLaunch.ts`, `lib/clipboard.ts`. Mounted in `PaymentLinkWidget` for INR.

Config: `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` hides the existing `upi://pay` QR and leaves only this flow. Unset, both show (the QR is unchanged).

## Payment status
Nothing here changes order state. Opening an app, copying, or returning to PayQR does nothing to the order. The existing **I've paid** button only asks the protocol to verify, and the order completes only when the on-chain status says so (polled in `PaymentLinkWidget`). The UI says plainly that manual payment is not auto-confirmed.

## App launching
Phones show **Pay with UPI apps** buttons: Google Pay (`tez://`), PhonePe (`phonepe://`), Paytm (`paytmmp://`). Each is a bare scheme with no path, payee or amount, so it only opens the app. Desktop shows text only.

**Unverified:** these schemes are registered by the apps and handled as UPI-app schemes by payment SDKs (e.g. Cashfree), but none of the apps documents a bare "open me" link. Test on real devices (checklist below). After a tap, if the page never leaves the foreground within 1.6 s, the UI says "<app> didn't open. Open it yourself from your home screen."

Tried and rejected: a Chrome `intent:` URL with `package=` + MAIN/LAUNCHER. On Android Chrome it opened the app's **Play Store page**, because Chrome only resolves `BROWSABLE` activities.

Known behaviour to check: on iOS Safari a scheme with no installed app may show a "cannot open page" alert; if the apps don't open on a device, remove that app's entry from `UPI_APPS`.

## Limitations
- Opening is best-effort and detection is a heuristic, not proof.
- No installed-app detection from the web, so all three apps are offered.
- Copy needs a user tap; falls back to `execCommand` on older browsers, and the toast says so if both fail.
- Translations: hi/pt/es fall back to English for the new strings.

## Customer instructions
Open your UPI app, enter the merchant's UPI ID, enter the exact amount, pay, then return and tap **I Paid**.

## Test checklist
Automated: `npm test` (`test/upiAppLaunch.test.ts`, `test/clipboard.test.ts`).

**Android Chrome** (on a phone with each app installed, and one without)
- [ ] Copy UPI ID, then paste elsewhere: exact ID; toast shown.
- [ ] Copy amount: `123.45` form, no symbol; toast shown.
- [ ] Each app button: opens the app's home screen (record per app + version), not a payment screen and not the Play Store.
- [ ] App not installed / not opening: "didn't open" message after ~1.6 s.
- [ ] No payment screen is ever pre-filled.
- [ ] Return to PayQR: order still pending.

**iOS Safari**
- [ ] Each app button: opens the app, or Safari shows an error alert (record which).
- [ ] Both copy buttons work (tap-triggered); denial shows the error toast.

**Desktop (Chrome, Firefox, Safari)**
- [ ] No app buttons; text guidance only.
- [ ] Copy works on https and on localhost; on plain http the legacy path or the error toast.
- [ ] Layout OK at 320 px and desktop widths; toast not clipped.

**All**
- [ ] INR shows one details block (UPI ID + amount, with copy), not two.
- [ ] With `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` the QR is gone; BRL and other rails unchanged.
- [ ] I've paid → "verifying"; completes only after on-chain confirmation.
