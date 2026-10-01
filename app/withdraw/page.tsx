"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { encodeFunctionData } from "viem";
import { useReadContract, usePublicClient } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Icon } from "../../components/Icons";
import { PrevTerminalWithdraw } from "../../components/PrevTerminalWithdraw";
import { usePrevBalances } from "../../components/usePrevBalances";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc, currencyFromBytes32, friendlyError } from "../../lib/contract";
import { USDC_ADDRESS } from "../../lib/p2p";
import { STATIC_STALE_MS } from "../../lib/cache";
import { fetchUsdcRate } from "../../lib/rates";
import { loadCountry, fmtFiat, fmtSymbolCode, COUNTRIES } from "../../lib/countries";
import { buildUsdcWithdraw, buildUsdcTransfer } from "../../lib/withdraw";
import { fetchCashoutFee } from "../../lib/pricing";
import { fetchWithdrawals } from "../../lib/history";
import { useT } from "../../lib/i18n";

// The p2p Cashout widget is a large dependency and only appears when the merchant
// actually starts a fiat cash-out. Lazy-load it so it is NOT in the withdraw
// page's first-load bundle (it was ~250 kB of it) — the page paints fast, the
// widget's code is fetched on demand when `cashout` becomes non-null.
const CashoutWidget = dynamic(
  () => import("../../components/CashoutWidget").then((m) => m.CashoutWidget),
  { ssr: false, loading: () => <p className="muted" style={{ textAlign: "center" }}>Loading cash-out…</p> }
);

// Always in DAYS (never seconds/minutes/hours) — the real prod settlement
// window is 30 days; this build's shortened ~10 min test window is a contract
// setting, not something this display should reveal. Round UP so any time
// still remaining reads as at least "1 day", never "0 days" (which would
// look identical to "ready").
function fmtRemaining(secs) {
  if (secs <= 0) return "ready";
  const days = Math.max(1, Math.ceil(secs / 86400));
  return `${days} day${days === 1 ? "" : "s"}`;
}

// Fiat cash-out (the UPI / bank offramp, in local currency) is HIDDEN: the only
// withdrawal offered is USDC to the merchant's wallet. Flip to true to bring the
// local-currency destination back — the whole fiat path below (destination
// chooser, withdraw-currency picker, Cashout widget handoff, small-order fee
// handling) is left intact, it just isn't rendered while this is false.
const FIAT_WITHDRAW_ENABLED = false;

export default function Withdraw() {
  const { ready, address, sendTransaction } = useMerchant();
  const publicClient = usePublicClient();
  const { t } = useT();

  const [country, setCountry] = useState(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [wdCode, setWdCode] = useState("");          // the currency to withdraw IN
  const [otherOpts, setOtherOpts] = useState([]);    // all countries (+ live flag)
  const [otherOpen, setOtherOpen] = useState(false);
  const [rate, setRate] = useState(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [cashout, setCashout] = useState(null); // active fiat cash-out (Cashout widget)
  // "Max" tapped: the input SHOWS the max value (so it doesn't look empty/broken),
  // but we remember it was Max so submit uses the EXACT on-chain bigint instead of
  // re-parsing the rounded display string (which could round a half-cent over the
  // real max and revert). Cleared the moment the merchant edits the field by hand.
  const [maxSelected, setMaxSelected] = useState(false);
  // USDC-withdraw multi-step flow: null (form) → "address" (review destination)
  //   → "confirm" (final dialog) → success (`done` set). The amount to send is
  // captured when entering the flow so it can't shift underneath the merchant.
  const [usdcStep, setUsdcStep] = useState<null | "address" | "confirm">(null);
  const [usdcSend, setUsdcSend] = useState<{ raw: bigint; usdc: number }>({ raw: 0n, usdc: 0 });
  // USDC destination: "self" = keep in the merchant's own connected wallet (the
  // contract pays out to msg.sender directly); "external" = forward to a pasted
  // address (withdrawUSDC into the wallet, then an ERC-20 transfer on to it).
  const [usdcDest, setUsdcDest] = useState<"self" | "external">("self");
  const [extAddr, setExtAddr] = useState("");
  // A valid EVM address is 0x + 40 hex. Trim + validate so a stray space or a
  // truncated paste can't send USDC into a dead address.
  const extAddrTrim = extAddr.trim();
  const extAddrValid = /^0x[0-9a-fA-F]{40}$/.test(extAddrTrim);
  // Which destination the merchant is withdrawing to: chosen FIRST, before any
  // currency/UPI UI is shown, so we don't ask USDC-bound questions about local
  // currency (and vice versa). null = not yet chosen.
  // With fiat hidden there is nothing to choose between, so the USDC path is
  // pre-selected and the chooser (and its back button) never render.
  const [destChoice, setDestChoice] = useState<null | "fiat" | "usdc">(
    FIAT_WITHDRAW_ENABLED ? null : "usdc"
  );

  useEffect(() => { const c = loadCountry(); setCountry(c); setWdCode(c.code); }, []);

  // Every configured country is selectable as the withdraw currency (default =
  // the merchant's registered one). The circle is resolved at withdrawal time.
  useEffect(() => { setOtherOpts(COUNTRIES); }, []);
  // 1s countdown ticker for the settlement timers. PAUSED while the Cashout
  // modal is open: it re-renders the mounted CashoutWidget every second, and the
  // widget's status-poll effect resets on each re-render — a live tick would
  // starve the poll so the offramp never advances. The timers aren't visible
  // behind the modal anyway.
  useEffect(() => {
    if (cashout) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [cashout]);
  useEffect(() => {
    if (!country) return;
    let on = true;
    // Rate for the currency actually being WITHDRAWN (wdCode), not the home
    // country — otherwise selecting "withdraw in" a non-home currency would size
    // the "≈ X" figures + the Max fee reservation with the wrong currency's rate,
    // and the USDC handed to the Cashout widget (which prices in wdCode) would
    // diverge from what the form showed. Falls back to the home country until a
    // withdraw currency is chosen. "sell" = cash-OUT rate, not the buy price.
    const rateCountry = (wdCode && COUNTRIES.find((c) => c.code === wdCode)) || country;
    // Clear the previous currency's rate FIRST — otherwise, for the second or
    // two after switching "withdraw in", the ≈ figures and Max convert the new
    // currency's amounts at the OLD currency's rate. With rate=null the form
    // shows "fetching rate" and disables withdraw until the right one loads.
    setRate(null);
    fetchUsdcRate(rateCountry, "sell").then((r) => on && setRate(r)).catch(() => {});
    return () => { on = false; };
  }, [country, wdCode]);

  const { data: buckets } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantBuckets",
    args: [address], query: { enabled: !!address, refetchInterval: 15000 },
  });
  const lockedBuckets = (buckets || []).filter((b) => b.amount > 0n && Number(b.unlockTimestamp) > now);

  const { data: balance, refetch } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantBalance",
    args: [address], query: { enabled: !!address, refetchInterval: 20000 },
  });
  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });
  // Read the merchant struct to detect an IN-FLIGHT fiat withdrawal (index 8).
  // A new fiat withdraw reverts WithdrawalInFlight while this is > 0, so we warn
  // the merchant and offer a self-service recover.
  const { data: mstruct, refetch: refetchMerchant } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "merchants",
    args: [address], query: { enabled: !!address, refetchInterval: 20000 },
  });
  const inFlight = mstruct ? Number((mstruct as any)[8]) : 0;
  const { data: proxyAddr } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "proxyAddress",
    args: [address], query: { enabled: !!address && inFlight > 0, staleTime: STATIC_STALE_MS },
  });
  // Is the connected wallet a contract OWNER? Only an owner can run the admin
  // recovery (freeze → adminAbort → unfreeze) that frees an order the LP left
  // stuck at "matching" (which reconcileWithdrawal alone can't). The v12 contract
  // is MULTI-OWNER (no owner()), so we ask isOwner(address) directly.
  const { data: ownerFlag } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "isOwner",
    args: [address], query: { enabled: inFlight > 0 && !!address, staleTime: STATIC_STALE_MS },
  });
  const isOwner = !!ownerFlag;
  // The payout handle is now collected inside the Cashout widget, so the withdraw
  // form no longer decrypts/displays the saved handle here.

  async function sendAndWait(functionName: string, args: any[]) {
    const data = encodeFunctionData({ abi: INTEGRATOR_ABI, functionName, args } as any);
    const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status === "reverted") throw new Error(functionName + " reverted");
    return hash;
  }

  // Recover a stuck in-flight fiat withdrawal.
  //  1) Try reconcileWithdrawal (permissionless) — works once the Diamond has
  //     CANCELLED the order (sweeps the refund back, frees the slot).
  //  2) If that reverts AND the connected wallet is the OWNER, run the admin path
  //     freeze → adminAbortWithdrawal → unfreeze, which recovers an order stuck at
  //     "matching" that the LP never released. This returns the escrowed USDC and
  //     frees the in-flight slot so withdrawals work again.
  //  3) Otherwise (not owner, still active), show a clear "needs support" message.
  async function recoverInFlight() {
    setError(""); setDone("");
    if (!proxyAddr) return setError("Still loading — try again in a moment.");
    setBusy("recover");
    try {
      // Recovery calls reconcile on the CURRENT contract, so only its own
      // withdrawals qualify — history now spans every integrator.
      const rows = (await fetchWithdrawals(proxyAddr as string)).filter(
        (r) => (r.integrator || "").toLowerCase() === CONTRACT_ADDRESS.toLowerCase()
      );
      const latest = rows?.[0]; // newest-first
      if (!latest?.orderId) throw new Error("Couldn't find the withdrawal to recover.");
      const orderId = BigInt(latest.orderId);

      // 1) permissionless reconcile
      try {
        await sendAndWait("reconcileWithdrawal", [orderId]);
        setDone(`Recovered withdrawal #${latest.orderId}. You can withdraw again.`);
        refetch(); refetchMerchant();
        return;
      } catch (reconErr) {
        // 2) owner-only admin recovery for an order the LP left active
        if (isOwner) {
          await sendAndWait("freezeMerchant", [address]);
          try {
            await sendAndWait("adminAbortWithdrawal", [orderId]);
          } finally {
            // ALWAYS unfreeze, even if abort failed, so we never leave frozen.
            await sendAndWait("unfreezeMerchant", [address]);
          }
          setDone(`Admin-recovered withdrawal #${latest.orderId}. Funds returned to your balance (re-locked for the settlement window shown below); you can withdraw again once they mature.`);
          refetch(); refetchMerchant();
          return;
        }
        throw reconErr; // not owner → fall through to the message below
      }
    } catch (err: any) {
      setError(
        friendlyError(err,
          "This withdrawal is still active on-chain and couldn't be recovered automatically. It can only be released by the payment partner or by support — please contact support with the order number.")
      );
    } finally { setBusy(""); }
  }
  // The merchant's REGISTERED offramp currency (getMerchantInfo[2], bytes32).
  // The contract pins withdrawals to this — so "home currency" must be derived
  // from it, not from the freely-editable UI country preference.
  const registeredCode = currencyFromBytes32(info?.[2] as string);
  const [pending, available] = balance ?? [0n, 0n];
  const availNum = Number(available) / 1e6;               // withdrawable (unlocked) USDC
  const availFiat = rate ? availNum * rate.rate : null;   // withdrawable in local fiat
  // ACCOUNT BALANCE = everything the contract holds for this merchant, matured
  // or not (pending = still-locked buckets + available = unlocked). NOT
  // totalDeposited, which is a lifetime counter that never decreases.
  const pendingNum = Number(pending) / 1e6;
  const accountNum = pendingNum + availNum;               // total USDC in contract
  const accountFiat = rate ? accountNum * rate.rate : null;
  // HEADLINE figures include every PREVIOUS contract too, so a contract upgrade
  // never makes a merchant's money look like it vanished. The withdraw FORM
  // below still works against the current contract only (availNum/availFiat);
  // old balances are moved by the PrevTerminalWithdraw card.
  const prevBal = usePrevBalances(address);
  const prevTotalNum = Number(prevBal.total) / 1e6;
  const prevAvailNum = Number(prevBal.available) / 1e6;
  const shownAccountNum = accountNum + prevTotalNum;
  const shownAvailNum = availNum + prevAvailNum;
  const shownAccountFiat = rate ? shownAccountNum * rate.rate : null;
  const shownAvailFiat = rate ? shownAvailNum * rate.rate : null;
  // Soonest unlock across the locked buckets → drives the maturity note with the
  // REAL on-chain wait (this build settles in ~10 min; prod uses 30 days). We
  // read the actual timestamp rather than hardcode a period that may be wrong.
  const nextUnlock = lockedBuckets.reduce(
    (min, b) => Math.min(min, Number(b.unlockTimestamp)),
    Infinity
  );
  const nextUnlockSecs = nextUnlock === Infinity ? 0 : Math.max(0, nextUnlock - now);

  // The AMOUNT FIELD is entered in LOCAL FIAT (₹ / R$ / …) for the bank path —
  // what a shopkeeper thinks in — and converted to USDC under the hood. Empty =
  // withdraw MAX. On the USDC path the same field is USDC directly, no
  // conversion needed.
  const typedFiat = amount.trim();
  // Empty field OR "Max" tapped (and not hand-edited since) = withdraw everything.
  // Treating maxSelected as "everything" keeps usdcNum/overBalance pinned to the
  // exact on-chain balance so the shown Max value can't round itself over-balance.
  const isMaxAmount = typedFiat === "" || maxSelected;
  // fiat the user wants → USDC (÷ rate). Max means "everything".
  const fiatNum = isMaxAmount ? availFiat ?? 0 : (Number(typedFiat) || 0);
  const usdcNum = isMaxAmount
    ? availNum
    : destChoice === "usdc" ? (Number(typedFiat) || 0) : (rate ? fiatNum / rate.rate : 0);
  const overBalance = usdcNum > availNum + 1e-9;

  // Small-order cash-out fee for the withdraw currency. On the FIAT path the
  // Cashout widget adds this fee ON TOP of the amount when the order is small
  // (<= threshold), so tapping "Max" for the full balance would overshoot →
  // "insufficient". We load the fee here so Max can reserve it.
  const [cashoutFee, setCashoutFee] = useState<{ threshold: number; fee: number }>({ threshold: 0, fee: 0 });
  useEffect(() => {
    if (!wdCode) return;
    let alive = true;
    fetchCashoutFee(wdCode)
      .then((f) => alive && setCashoutFee({ threshold: Number(f.threshold) / 1e6, fee: Number(f.fee) / 1e6 }))
      .catch(() => alive && setCashoutFee({ threshold: 0, fee: 0 }));
    return () => { alive = false; };
  }, [wdCode]);

  // The most USDC the merchant can actually cash out to fiat right now: if the
  // whole balance is a small order (<= threshold), the fixed fee applies, so the
  // spendable principal is (balance - fee). Above the threshold there's no fee,
  // so Max is the full balance. Never goes below 0.
  const maxFiatUsdc =
    cashoutFee.fee > 0 && availNum > 0 && availNum <= cashoutFee.threshold
      ? Math.max(0, availNum - cashoutFee.fee)
      : availNum;
  const maxFiat = rate ? maxFiatUsdc * rate.rate : null;

  // withdraw-currency helpers
  const CC = { india: "in", brazil: "br", argentina: "ar", venezuela: "ve" };
  const flagOf = (code) => {
    const c = COUNTRIES.find((x) => x.code === code);
    return `https://flagcdn.com/w40/${CC[c?.id] || "un"}.png`;
  };
  const wdCountry = COUNTRIES.find((c) => c.code === wdCode) || country;
  // "Home" = withdrawing in the merchant's REGISTERED currency (the one the
  // contract pins the SELL to). Derived from the on-chain currency, not the UI
  // country pref — else an INR merchant who set their UI to Brazil would place an
  // INR order on the BRL circle. Falls back to the UI country only until info loads.
  const isHome = registeredCode
    ? wdCode === registeredCode
    : (!!country && wdCode === country.code);

  async function withdraw(kind) {
    setError(""); setDone("");
    // Empty input = withdraw MAX. Otherwise the entered amount is used (fiat is
    // converted to USDC ÷ rate). "0"/negative is rejected, not coerced to "all".
    // MAX = the field is empty OR the merchant tapped "Max" and hasn't hand-edited
    // it since. Either way we withdraw the exact on-chain max (fee reserved), not
    // the rounded display string.
    const isMax = typedFiat === "" || maxSelected;
    // FIAT MAX reserves the small-order fee (maxFiatUsdc) so the widget's added
    // fee doesn't push the total over the balance. USDC MAX uses the full balance
    // (no small-order fee on a plain USDC transfer).
    // Block a fiat-denominated cash-out sized from an UNTRUSTED rate (no real
    // rate source for this currency — a bare 1:1 placeholder). Without this a
    // typed fiat amount divided by a fake rate of 1 would size a wildly wrong
    // USDC principal. MAX is safe (it uses the on-chain USDC balance directly,
    // no rate), and the USDC path never divides by the rate.
    if (kind === "fiat" && !isMax && rate?.untrusted) {
      return setError(
        "Live exchange rate unavailable right now — clear the amount to withdraw the maximum, or withdraw as USDC."
      );
    }
    const maxUsdc = kind === "fiat" ? maxFiatUsdc : availNum;
    const sendUsdc = isMax ? maxUsdc : usdcNum;
    // Unconditional (Max included): a balance at/below the small-order fee makes
    // Max resolve to 0 — opening the cash-out widget with 0 USDC just dies
    // downstream with a cryptic revert.
    if (sendUsdc <= 0) {
      return setError(
        isMax && kind === "fiat" && availNum > 0
          ? `Balance too small to cash out — the ${cashoutFee.fee.toFixed(2)} USDC network fee would consume it. You can still withdraw it as USDC.`
          : "Enter an amount greater than zero."
      );
    }
    if (sendUsdc > availNum + 1e-9) return setError("Amount exceeds your available balance.");
    // Sub-threshold fiat cash-outs pay a fixed fee ON TOP of the principal, and
    // the contract deducts BOTH from the balance at delivery. A typed amount
    // that fits the balance but not amount+fee would place fine, then wedge
    // in-flight when the delivery top-up reverts — block it up front.
    if (kind === "fiat" && !isMax && cashoutFee.fee > 0 && sendUsdc <= cashoutFee.threshold
        && sendUsdc + cashoutFee.fee > availNum + 1e-9) {
      return setError(
        `Small withdrawals add a ${cashoutFee.fee.toFixed(2)} USDC network fee, and this amount plus the fee exceeds your balance. Clear the amount to withdraw the maximum (the fee is reserved automatically), or enter less.`
      );
    }

    // Use the exact on-chain `available` bigint only for a TRUE full-balance MAX
    // (USDC path, or fiat with no fee reserved) so float rounding can't push it 1
    // unit over and revert. When the fee was reserved, the amount is below the
    // balance, so convert the reserved figure instead.
    const useExactMax = (isMax && sendUsdc >= availNum - 1e-9) || sendUsdc >= availNum;
    const raw = useExactMax ? (available as bigint) : BigInt(Math.round(sendUsdc * 1e6));

    // FIAT: hand off to the official Cashout widget. It collects the payout
    // handle (once), encrypts it, and runs the full offramp lifecycle. We no
    // longer ask for the handle here — the widget owns that single input.
    if (kind === "fiat") {
      setCashout({ defaultAmountUsdc: raw, code: wdCode, isHome });
      return;
    }

    // USDC: don't send immediately — capture the amount and step through
    // review (destination address) → confirm dialog → send. The transfer goes
    // to the merchant's OWN connected wallet (withdrawUSDC → msg.sender).
    setUsdcSend({ raw, usdc: sendUsdc });
    setUsdcStep("address");
  }

  // Final on-chain USDC send, fired from the confirm dialog.
  //  • self:     one tx — withdrawUSDC pays out to the merchant's own wallet.
  //  • external: two sponsored txs — withdrawUSDC pulls the funds into the wallet,
  //              then a USDC ERC-20 transfer forwards them to the pasted address.
  //              (The contract can only pay out to msg.sender, so the hop through
  //              the wallet is required.) Step 1 must fully confirm before step 2,
  //              or the transfer would race the wallet's incoming balance.
  async function confirmUsdcWithdraw() {
    setError("");
    setBusy("usdc");
    try {
      // For an EXTERNAL send, snapshot the wallet's USDC balance BEFORE the
      // withdraw so step 2 forwards exactly what step 1 actually deposited — not
      // the gross requested amount. If the contract ever delivered less than
      // requested (e.g. a fee), forwarding the gross figure would exceed the
      // wallet balance and revert; forwarding the measured delta can't.
      const balanceOfAbi = [{
        type: "function", name: "balanceOf", stateMutability: "view",
        inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }],
      }] as const;
      let balBefore = 0n;
      if (usdcDest === "external" && extAddrValid && address) {
        try {
          balBefore = (await publicClient.readContract({
            address: USDC_ADDRESS as `0x${string}`, abi: balanceOfAbi,
            functionName: "balanceOf", args: [address as `0x${string}`],
          } as any)) as bigint;
        } catch { balBefore = 0n; }
      }

      // Step 1 — always: pull USDC out of the contract into the merchant's wallet.
      const { data } = buildUsdcWithdraw({ amountRaw: usdcSend.raw });
      const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("Withdrawal failed on-chain.");

      if (usdcDest === "external" && extAddrValid) {
        // Measure what actually landed and forward only that (capped at the
        // requested amount). Falls back to the requested amount if the read fails.
        let fwd = usdcSend.raw;
        if (address) {
          try {
            const balAfter = (await publicClient.readContract({
              address: USDC_ADDRESS as `0x${string}`, abi: balanceOfAbi,
              functionName: "balanceOf", args: [address as `0x${string}`],
            } as any)) as bigint;
            const delta = balAfter > balBefore ? balAfter - balBefore : 0n;
            if (delta > 0n) fwd = delta < usdcSend.raw ? delta : usdcSend.raw;
          } catch { /* keep requested amount */ }
        }
        // Step 2 — forward the just-withdrawn USDC on to the external address.
        const xfer = buildUsdcTransfer({ to: extAddrTrim as `0x${string}`, amountRaw: fwd });
        const xh = await sendTransaction({ to: xfer.to, data: xfer.data });
        const xrc = await publicClient.waitForTransactionReceipt({ hash: xh });
        if (xrc.status === "reverted") {
          // The funds are safe in the merchant's own wallet — only the forward
          // failed. Tell them plainly so they know the money isn't lost.
          throw new Error(
            "Your USDC was withdrawn to your wallet, but forwarding it to the address failed. The funds are safe in your wallet — you can send them again from there."
          );
        }
        setUsdcStep(null);
        setDone(
          `${usdcSend.usdc.toFixed(2)} USDC sent to ${extAddrTrim.slice(0, 8)}…${extAddrTrim.slice(-6)}.`
        );
      } else {
        setUsdcStep(null);
        setDone(
          `${usdcSend.usdc.toFixed(2)} USDC sent to your wallet ${address ? `(${address.slice(0,6)}…${address.slice(-4)})` : ""}. If you don't see it, add the USDC token to your wallet.`
        );
      }
      setAmount(""); setExtAddr(""); setUsdcDest("self"); refetch();
    } catch (err) {
      console.error(err);
      setUsdcStep(null);
      setError(friendlyError(err, "Withdrawal failed. Please try again."));
    } finally {
      setBusy("");
    }
  }

  // Auth gate is handled inside useMerchant (redirects a logged-out visitor to
  // /login); `ready` already folds in auth + smart-account + registration load,
  // so gate the shell on it and show the loading fallback until it's true.
  if (!ready || !country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p></div></>;

  return (
    <>
      <Nav back />
      {cashout && (
        <CashoutWidget
          defaultAmountUsdc={cashout.defaultAmountUsdc}
          isHome={cashout.isHome}
          encPayout={(info?.[0] as string) || ""}
          currency={{ code: cashout.code, flag: wdCountry?.flag, fiat: wdCountry?.fiat, symbol: wdCountry?.symbol }}
          onComplete={() => { setCashout(null); setDone(`Withdrawal in ${wdCountry?.fiat} completed.`); setAmount(""); refetch(); }}
          onCancelled={() => { setCashout(null); refetch(); }}
          onClose={() => { setCashout(null); refetch(); }}
          onError={(m) => setError(m)}
        />
      )}
      <div className="screen">
        {/* USDC WITHDRAW — STEP 2: choose WHERE the USDC goes. Either keep it in
            the merchant's OWN connected wallet (the contract pays out to
            msg.sender), or forward it to a pasted external address (two sponsored
            steps: withdrawUSDC into the wallet, then an ERC-20 transfer on to it). */}
        {usdcStep === "address" && (
          <div className="wd-usdc-step">
            <button className="wallet-back" onClick={() => { setUsdcStep(null); setError(""); }}>
              <Icon.Back width="16" height="16" /> {t("wd.usdcTitle")}
            </button>
            <div className="wd-usdc-amt">
              <span className="wd-usdc-amt-val">{usdcSend.usdc.toFixed(2)} USDC</span>
              <span className="wd-usdc-amt-sub">{t("wd.usdcChooseDest")}</span>
            </div>

            {/* Option A — keep in my wallet (default) */}
            <button type="button"
              className={`wd-payout-opt ${usdcDest === "self" ? "sel" : ""}`}
              onClick={() => { setUsdcDest("self"); setError(""); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px", marginTop: 10, borderRadius: 10, border: "1px solid var(--border)", background: usdcDest === "self" ? "var(--accent-soft, rgba(20,136,255,.08))" : "transparent", cursor: "pointer" }}>
              <span className="wd-radio">{usdcDest === "self" ? "●" : "○"}</span>
              <span style={{ flex: 1, textAlign: "left" }}>
                <b>{t("wd.usdcKeepInWallet")}</b>
                <small style={{ display: "block", color: "var(--muted)", fontFamily: "monospace", marginTop: 2 }}>
                  {address ? `${address.slice(0, 10)}…${address.slice(-8)}` : "…"}
                </small>
              </span>
            </button>

            {/* Option B — send to another address (paste) */}
            <button type="button"
              className={`wd-payout-opt ${usdcDest === "external" ? "sel" : ""}`}
              onClick={() => { setUsdcDest("external"); setError(""); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px", marginTop: 8, borderRadius: 10, border: "1px solid var(--border)", background: usdcDest === "external" ? "var(--accent-soft, rgba(20,136,255,.08))" : "transparent", cursor: "pointer" }}>
              <span className="wd-radio">{usdcDest === "external" ? "●" : "○"}</span>
              <span style={{ flex: 1, textAlign: "left" }}>
                <b>{t("wd.usdcSendToAddress")}</b>
                <small style={{ display: "block", color: "var(--muted)", marginTop: 2 }}>{t("wd.usdcSendToAddressHint")}</small>
              </span>
            </button>

            {usdcDest === "external" && (
              <>
                <input className="input" style={{ marginTop: 10, fontFamily: "monospace" }}
                  placeholder="0x…" value={extAddr} autoComplete="off" spellCheck={false}
                  onChange={(e) => setExtAddr(e.target.value)} />
                {extAddrTrim !== "" && !extAddrValid && (
                  <p className="error" style={{ marginTop: 6 }}>{t("wd.usdcBadAddress")}</p>
                )}
                <p className="wallet-hint" style={{ marginTop: 8 }}>{t("wd.usdcExternalNote")}</p>
              </>
            )}

            {usdcDest === "self" && (
              <p className="wallet-hint" style={{ marginTop: 10 }}>{t("wd.usdcOwnWalletNote")}</p>
            )}

            {error && <p className="error" style={{ textAlign: "center", marginTop: 10 }}>{error}</p>}
            <button className="btn" style={{ width: "100%", marginTop: 16 }}
              disabled={!address || !!busy || (usdcDest === "external" && !extAddrValid)}
              onClick={() => setUsdcStep("confirm")}>
              {t("common.continue")}
            </button>
          </div>
        )}

        {/* In-flight withdrawal warning — a new fiat withdraw is blocked while one
            is unsettled. Explain it and offer a self-service recover. */}
        {!usdcStep && inFlight > 0 && (
          <div className="wd-inflight" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 12, border: "1px solid var(--warn-border, #e0b100)", background: "var(--warn-soft, rgba(224,177,0,.08))", marginBottom: 12 }}>
            <span><Icon.Clock /></span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{t("wd.inflightTitle")}</div>
              <div className="muted" style={{ fontSize: 12 }}>{t("wd.inflightBody")}</div>
            </div>
            <button className="btn small secondary" disabled={busy === "recover"}
              onClick={recoverInFlight}>
              {busy === "recover" ? t("wd.working") : t("wd.recover")}
            </button>
          </div>
        )}

        {/* The withdraw FORM — hidden while stepping through the USDC flow. */}
        {!usdcStep && (
        <>
        {/* TWO balance figures, side by side, so the merchant sees at a glance
            what they HAVE (account balance = everything in the contract) vs what
            they can withdraw RIGHT NOW (matured/unlocked). The gap is funds still
            in the settlement window. */}
        <div className="wd-balances">
          <div className="wd-bal-box">
            <div className="wd-bal-label">{t("wd.accountBalance")}</div>
            <div className="wd-bal-amt">${shownAccountNum.toFixed(2)}</div>
            <div className="wd-bal-sub">
              {shownAccountFiat != null ? `≈ ${fmtFiat(country, shownAccountFiat)} ${country.code}` : "≈ —"}
            </div>
          </div>
          <div className="wd-bal-box">
            <div className="wd-bal-label">{t("wd.withdrawable")}</div>
            <div className="wd-bal-amt">${shownAvailNum.toFixed(2)}</div>
            <div className="wd-bal-sub">
              {shownAvailFiat != null ? `≈ ${fmtFiat(country, shownAvailFiat)} ${country.code}` : "≈ —"}
            </div>
          </div>
        </div>
        {prevTotalNum > 0 && (
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 2px 0" }}>
            This terminal ${accountNum.toFixed(2)} · previous terminal{prevBal.rows.length > 1 ? "s" : ""} ${prevTotalNum.toFixed(2)} (move below)
          </p>
        )}
        {/* Funds still maturing → show how much and the REAL time until the next
            tranche unlocks (read from chain, not a hardcoded period). */}
        {pendingNum > 0 && (
          <div className="wd-maturity">
            {fmtUsdc(pending)} USDC {t("wd.settlingNote")}
            {nextUnlockSecs > 0 ? ` · ${t("wd.maturityNote")} (${fmtRemaining(nextUnlockSecs)})` : ""}
          </div>
        )}

        {lockedBuckets.length > 0 && (
          <div className="wd-locked">
            <div className="wd-locked-h">{t("wd.unlockingSoon")}</div>
            {lockedBuckets.map((b, i) => {
              const secs = Number(b.unlockTimestamp) - now;
              return (
                <div key={i} className="wd-locked-row">
                  <span>{fmtUsdc(b.amount)} USDC</span>
                  <span className="badge locked">in {fmtRemaining(secs)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Upgrade safety net: if the app has been repointed to a new integrator
            and this merchant still holds a balance on the OLD one, let them drain
            it here. Fully dormant (renders nothing) unless a previous address is
            configured AND the merchant has funds there. */}
        <PrevTerminalWithdraw onWithdrawn={() => refetch()} />

        {/* STEP 1 — ask WHERE first: local currency (bank/UPI) or USDC wallet.
            Nothing currency- or UPI-specific is shown until this is answered,
            so a USDC withdrawal never has to wade through fiat/UPI fields. */}
        {FIAT_WITHDRAW_ENABLED && !destChoice && (
          <div className="wd-dest-bar">
            <div className="wd-dest-head">{t("wd.chooseDest")}</div>
            <button className="wd-dest-btn"
              disabled={!ready || availNum <= 0}
              onClick={() => { setAmount(""); setDestChoice("fiat"); }}>
              <span className="wd-dest-ico"><Icon.Bank /></span>
              <span className="wd-dest-txt">
                <b>{t("wd.sendToBank")} {wdCountry?.fiat}</b>
                <small>{t("wd.destBankHint")}</small>
              </span>
              <span className="wd-dest-arrow">›</span>
            </button>
            <button className="wd-dest-btn usdc"
              disabled={!ready || availNum <= 0}
              onClick={() => { setAmount(""); setDestChoice("usdc"); }}>
              <span className="wd-dest-ico"><Icon.Wallet /></span>
              <span className="wd-dest-txt">
                <b>{t("wd.usdcTitle")}</b>
                <small>{t("wd.destUsdcHint")}</small>
              </span>
              <span className="wd-dest-arrow">›</span>
            </button>
          </div>
        )}

        {/* STEP 2, fiat path — amount, withdraw currency, and UPI/payout fields.
            Only ever shown after "Send to my UPI/bank" is chosen. */}
        {FIAT_WITHDRAW_ENABLED && destChoice === "fiat" && (
          <>
            <button className="wallet-back" onClick={() => setDestChoice(null)}>
              <Icon.Back width="16" height="16" /> {t("wd.sendToBank")} {wdCountry?.fiat}
            </button>

            <div className="wd-card">
              <label className="wd-label">{t("wd.amount")} ({country.code})</label>
              <div className="wd-amt-row">
                {/* Amount entered in LOCAL FIAT (₹/R$/…) with the currency symbol; the
                    USDC equivalent is shown small below. */}
                <div className="wd-fiat-input" style={{ display: "flex", alignItems: "center", flex: 1, gap: 6 }}>
                  <span className="wd-fiat-sym" style={{ fontWeight: 700, color: "var(--muted)" }}>{country.symbol}</span>
                  <input className="input" type="number" min="0" step="0.01"
                    placeholder={maxFiat != null ? maxFiat.toFixed(2) : "0.00"} value={amount}
                    onChange={(e) => { setAmount(e.target.value); setMaxSelected(false); }} style={{ flex: 1 }} />
                </div>
                {/* Max SHOWS the max fiat value (so the field isn't confusingly blank)
                    but flags `maxSelected` so submit still uses the EXACT on-chain
                    bigint (fee reserved) rather than the rounded display string —
                    which could round a half-cent over the real max and revert. */}
                <button className="btn secondary small" type="button"
                  onClick={() => {
                    setAmount(maxFiat != null ? maxFiat.toFixed(2) : "");
                    setMaxSelected(true);
                    setError("");
                  }}>{t("wd.max")}</button>
              </div>
              {/* small USDC equivalent of whatever fiat is typed */}
              <div className="wd-usdc-hint muted" style={{ fontSize: 12, marginTop: 6 }}>
                ≈ {usdcNum > 0 ? usdcNum.toFixed(2) : maxFiatUsdc.toFixed(2)} USDC
                {typedFiat === "" && <span> · {t("wd.max")}</span>}
              </div>
              {/* When Max had to hold back the fee, explain WHY it's less than the
                  full balance — otherwise it looks like funds went missing. */}
              {maxFiatUsdc < availNum - 1e-9 && (
                <div className="wd-usdc-hint muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                  {t("wd.feeReserved").replace("{fee}", `${cashoutFee.fee.toFixed(2)} USDC`)}
                </div>
              )}
              {overBalance && <p className="error">{t("wd.exceeds")}</p>}
            </div>

            {/* WITHDRAW CURRENCY — Accept-style dropdown. Default = registered
                country; pick another to cash out in that currency. */}
            <div className="wd-label" style={{ marginTop: 18 }}>{t("wd.withdrawIn")}</div>
            <div className="picker wd-cur">
              <button className={`picker-btn ${otherOpen ? "on" : ""}`} onClick={() => setOtherOpen((o) => !o)}>
                <img className="pk-flag-img" src={flagOf(wdCode)} alt="" />
                <span className="pk-text">{wdCountry?.name} · {wdCountry ? fmtSymbolCode(wdCountry) : wdCode}</span>
                <span className="pk-car">▾</span>
              </button>
              {otherOpen && (
                <div className="picker-pop">
                  {otherOpts.map((c) => (
                    <button key={c.id} className={`picker-item ${wdCode === c.code ? "sel" : ""}`}
                      onClick={() => { setWdCode(c.code); setOtherOpen(false); }}>
                      <img className="pk-flag-img" src={flagOf(c.code)} alt="" />
                      <span className="pk-item-txt">{c.name}<small>{c.fiat} · {fmtSymbolCode(c)}</small></span>
                      {wdCode === c.code && <span className="pk-chk">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* NOTE: the payout handle (UPI/PIX/…) is entered ONCE, inside the
                secure Cashout step that opens next — it collects and encrypts it
                to the assigned partner's key at the ACCEPTED handoff. We used to
                also ask for it here, which meant the merchant typed it twice; that
                picker has been removed. To change a saved handle, use Settings. */}

            {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
            {done && <p className="success" style={{ textAlign: "center" }}>✓ {done}</p>}

            {/* If the merchant typed a fiat amount but the USDC↔fiat rate hasn't loaded,
                we can't convert it yet — show a hint and disable withdraw (rather than
                coercing the conversion to 0 and rejecting a valid amount). An empty
                (MAX) input needs no rate, so it stays enabled. */}
            {typedFiat !== "" && !rate && (
              <p className="muted" style={{ textAlign: "center", fontSize: 12, marginTop: 10 }}>{t("wd.fetchingRate")}</p>
            )}

            <button className="btn" style={{ width: "100%", marginTop: 16 }}
              disabled={!!busy || !ready || availNum <= 0 || overBalance || (typedFiat !== "" && !rate)}
              onClick={() => withdraw("fiat")}>
              {busy === "fiat" ? t("wd.working") : `${t("wd.sendToBank")} ${wdCountry?.fiat}`}
            </button>
          </>
        )}

        {/* STEP 2, USDC path — just the amount; destination is the merchant's own
            connected wallet, confirmed in the next step. No fiat/UPI fields at all. */}
        {destChoice === "usdc" && (
          <>
            {FIAT_WITHDRAW_ENABLED ? (
              <button className="wallet-back" onClick={() => setDestChoice(null)}>
                <Icon.Back width="16" height="16" /> {t("wd.usdcTitle")}
              </button>
            ) : (
              /* No chooser to go back to when fiat is hidden — keep the title as
                 a plain heading so the form still says what it does. */
              <div className="wd-dest-head">{t("wd.usdcTitle")}</div>
            )}

            <div className="wd-card">
              <label className="wd-label">Withdraw to wallet</label>
              <div className="wd-amt-row">
                <div className="wd-fiat-input" style={{ display: "flex", alignItems: "center", flex: 1, gap: 6 }}>
                  <input className="input" type="number" min="0" step="0.01"
                    placeholder={availNum.toFixed(2)} value={amount}
                    onChange={(e) => { setAmount(e.target.value); setMaxSelected(false); }} style={{ flex: 1 }} />
                  <span className="wd-fiat-sym" style={{ fontWeight: 700, color: "var(--muted)" }}>USDC</span>
                </div>
                {/* Max SHOWS the full balance (so the field isn't confusingly
                    blank) but flags `maxSelected` so submit still sends the
                    EXACT on-chain `available` bigint, not a .toFixed(2) string
                    that could round a fraction of a cent OVER the balance. */}
                <button className="btn secondary small" type="button"
                  onClick={() => { setAmount(availNum.toFixed(2)); setMaxSelected(true); setError(""); }}>{t("wd.max")}</button>
              </div>
              {(typedFiat === "" || maxSelected) && (
                <div className="wd-usdc-hint muted" style={{ fontSize: 12, marginTop: 6 }}>{t("wd.max")}</div>
              )}
              {overBalance && <p className="error">{t("wd.exceeds")}</p>}
            </div>

            {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
            {done && <p className="success" style={{ textAlign: "center" }}>✓ {done}</p>}

            <button className="btn" style={{ width: "100%", marginTop: 16 }}
              disabled={!!busy || !ready || availNum <= 0 || overBalance}
              onClick={() => withdraw("usdc")}>
              {t("common.continue")}
            </button>
          </>
        )}
        </>
        )}
      </div>

      {/* USDC WITHDRAW — STEP 3: final confirm dialog before the on-chain send. */}
      {usdcStep === "confirm" && (
        <div className="confirm-overlay" onClick={() => busy ? null : setUsdcStep("address")}>
          <div className="confirm-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-h">{t("wd.usdcConfirmTitle")}</div>
            <div className="confirm-amt">{usdcSend.usdc.toFixed(2)} USDC</div>
            <p className="confirm-sub">
              {usdcDest === "external" ? t("wd.usdcConfirmBodyExt") : t("wd.usdcConfirmBody")}
            </p>
            <div className="confirm-row">
              <span>{t("wd.destAddress")}</span>
              <b style={{ fontFamily: "monospace" }}>
                {usdcDest === "external"
                  ? (extAddrValid ? `${extAddrTrim.slice(0, 8)}…${extAddrTrim.slice(-6)}` : "—")
                  : (address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "—")}
              </b>
            </div>
            {usdcDest === "external" && (
              <div className="confirm-row">
                <span>{t("wd.usdcSteps")}</span>
                <b>{t("wd.usdcTwoSteps")}</b>
              </div>
            )}
            {error && <p className="error" style={{ textAlign: "center", marginTop: 8 }}>{error}</p>}
            <div className="confirm-actions">
              <button className="btn ghost" disabled={!!busy} onClick={() => setUsdcStep("address")}>
                {t("common.cancel")}
              </button>
              <button className="btn" disabled={!!busy} onClick={confirmUsdcWithdraw}>
                {busy === "usdc" ? t("wd.working") : t("wd.usdcConfirmCta")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
