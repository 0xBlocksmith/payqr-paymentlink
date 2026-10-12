# Manual UPI checkout

For INR payment links. Shows the payee's UPI ID and exact amount with copy buttons, and instructions to enter them in any UPI app. It never creates a `upi://pay` link or any payment intent. The customer types the payee and amount themselves.

Code: `components/UpiManualCheckout.tsx`, `lib/clipboard.ts`. Mounted in `PaymentLinkWidget` for INR.

Config: `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` hides the existing `upi://pay` QR and leaves only this flow. Unset, both show (the QR is unchanged).

## Payment status
Nothing here changes order state. Opening an app, copying, or returning to PayQR does nothing to the order. The existing **I've paid** button only asks the protocol to verify, and the order completes only when the on-chain status says so (polled in `PaymentLinkWidget`). The UI says plainly that manual payment is not auto-confirmed.

## App launching: not offered
Tried and removed, tested on an Android phone (Chrome):
- `intent:` launcher URL with `package=`: opened the app's **Play Store page** (Chrome only resolves `BROWSABLE` activities).
- Bare app schemes (no path, payee or amount): `tez://` (Google Pay) and `phonepe://` did nothing; `paytmmp://` opened Paytm to an **"App upgrade required"** error page.
- Bare `upi://`: no host, so Android sends it to whichever app claims the scheme (on the test phone, an unrelated crypto app); with that app uninstalled, nothing opened.
- `upi://pay` / `intent://pay#Intent;scheme=upi;end` (no payee or amount): the system UPI chooser appears, but every app then shows a "technical error" because there is nothing to pay.

None of the apps documents a bare "open me" link, and iOS has no supported mechanism either. The card therefore names the apps in text and the customer opens one themselves. The only mechanism that reliably opens these apps is a UPI payment intent (`upi://pay`), which this flow deliberately avoids.

## Limitations
- The customer opens their UPI app by hand.
- Copy needs a user tap; falls back to `execCommand` on older browsers, and the toast says so if both fail.
- Translations: hi/pt/es fall back to English for the new strings.

## Customer instructions
Open your UPI app, enter the merchant's UPI ID, enter the exact amount, pay, then return and tap **I Paid**.

## Test checklist
Automated: `npm test` (`test/clipboard.test.ts`).

**Android Chrome** (on a phone with each app installed, and one without)
- [ ] Copy UPI ID, then paste elsewhere: exact ID; toast shown.
- [ ] Copy amount: `123.45` form, no symbol; toast shown.
- [ ] Card names Google Pay / PhonePe / Paytm in text; nothing navigates or opens the Play Store.
- [ ] No payment screen is ever pre-filled.
- [ ] Return to PayQR: order still pending.

**iOS Safari**
- [ ] No navigation; copy buttons work.
- [ ] Both copy buttons work (tap-triggered); denial shows the error toast.

**Desktop (Chrome, Firefox, Safari)**
- [ ] Copy works on https and on localhost; on plain http the legacy path or the error toast.
- [ ] Layout OK at 320 px and desktop widths; toast not clipped.

**All**
- [ ] INR shows one details block (UPI ID + amount, with copy), not two.
- [ ] With `NEXT_PUBLIC_UPI_MANUAL_ONLY=1` the QR is gone; BRL and other rails unchanged.
- [ ] I've paid → "verifying"; completes only after on-chain confirmation.
