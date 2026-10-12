# Manual UPI checkout

For INR payment links. Shows the payee's UPI ID and exact amount with copy buttons, and an Open UPI app button (bare `upi://`). It never creates a `upi://pay` link or any payment intent. The customer types the payee and amount themselves.

Code: `components/UpiManualCheckout.tsx`, `lib/upiAppLaunch.ts`, `lib/clipboard.ts`. Mounted in `PaymentLinkWidget` for INR.

Config: `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` hides the existing `upi://pay` QR and leaves only this flow. Unset, both show (the QR is unchanged).

## Payment status
Nothing here changes order state. Opening an app, copying, or returning to PayQR does nothing to the order. The existing **I've paid** button only asks the protocol to verify, and the order completes only when the on-chain status says so (polled in `PaymentLinkWidget`). The UI says plainly that manual payment is not auto-confirmed.

## App launching (experimental)
The **Open UPI app** button navigates to the bare `upi://` scheme: no payee, amount, order or `pay` path, so nothing is paid or pre-filled. On Android this should show the system's UPI app chooser. **Unverified**: test on a device. If the page never leaves the foreground within 1.6 s, it shows "No UPI app opened. Open ... yourself."

Tried and removed, tested on an Android phone (Chrome):
- `intent:` launcher URL with `package=`: opened the app's Play Store page (Chrome only resolves `BROWSABLE` activities).
- Bare app schemes: `tez://` (Google Pay) and `phonepe://` did nothing; `paytmmp://` opened Paytm to an "App upgrade required" page. The other schemes tried (navipay, super, bhim, credpay, etc.) also did not work.

If bare `upi://` also fails, remove the button (`UpiManualCheckout.tsx`, `lib/upiAppLaunch.ts`): no web mechanism short of a payment intent opens these apps.

## Limitations
- Opening is best-effort and detection is a heuristic, not proof.
- iOS: `upi://` is not a supported way to open an app there; expect nothing or a Safari error.
- Copy needs a user tap; falls back to `execCommand` on older browsers, and the toast says so if both fail.
- Translations: hi/pt/es fall back to English for the new strings.

## Customer instructions
Open your UPI app, enter the merchant's UPI ID, enter the exact amount, pay, then return and tap **I Paid**.

## Test checklist
Automated: `npm test` (`test/upiAppLaunch.test.ts`, `test/clipboard.test.ts`).

**Android Chrome** (on a phone with each app installed, and one without)
- [ ] Copy UPI ID, then paste elsewhere: exact ID; toast shown.
- [ ] Copy amount: `123.45` form, no symbol; toast shown.
- [ ] Open UPI app: shows the system UPI chooser (record), not a payment screen, not the Play Store.
- [ ] No UPI app / dismissed: "No UPI app opened" message after ~1.6 s.
- [ ] No payment screen is ever pre-filled.
- [ ] Return to PayQR: order still pending.

**iOS Safari**
- [ ] Open UPI app: record what happens (likely nothing / Safari error). Copy buttons work.
- [ ] Both copy buttons work (tap-triggered); denial shows the error toast.

**Desktop (Chrome, Firefox, Safari)**
- [ ] Copy works on https and on localhost; on plain http the legacy path or the error toast.
- [ ] Layout OK at 320 px and desktop widths; toast not clipped.

**All**
- [ ] INR shows one details block (UPI ID + amount, with copy), not two.
- [ ] With `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` the QR is gone; BRL and other rails unchanged.
- [ ] I've paid → "verifying"; completes only after on-chain confirmation.
