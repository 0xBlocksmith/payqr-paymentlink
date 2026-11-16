"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePublicClient } from "wagmi";
import { Nav } from "../../../components/Nav";
import { Splash } from "../../../components/Splash";
import { useMerchant } from "../../../components/useMerchant";
import { CONTRACT_ADDRESS, LINK_ROUTER_ADDRESS, INTEGRATOR_ABI, currencyFromBytes32 } from "../../../lib/contract";
import { toUserError, ValidationError, type UserError } from "../../../lib/errors";
import { savePendingLink, loadPendingLink, clearPendingLink, type PendingLink } from "../../../lib/pendingLink";
import { useGuardedSend } from "../../../components/useGuardedSend";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ErrorPanel } from "../../../components/ui/ErrorPanel";
import { SettlementNote } from "../../../components/ui/SettlementNote";
import { useCopy } from "../../../components/useCopy";
import { fill, fmtLockWindow } from "../../../lib/format";
import { fetchLink, isLinkNotFound } from "../../../lib/paymentLinks";
import { usePriceConfig } from "../../../components/usePriceConfig";
import { stringToHex } from "viem";
import { useReadContract } from "wagmi";
import { countryForCurrency, fmtFiat, COUNTRIES } from "../../../lib/countries";
import { fetchSupportedCurrencies } from "../../../lib/p2p";
import { fetchPriceConfig, usdcForFiat, fiatForUsdc, usdcForUsdcTarget, minimumFiat, minimumUsdc } from "../../../lib/pricing";
import {
  buildCreateLinkCalldata,
  buildRegisterAgentCalldata,
  provisionLinkWallet,
  computeLinkId,
  randomLinkSalt,
  buildPayLinkUrl,
  rememberLink,
  fixedAmountTypedData,
  relayerFeatures,
  PAYMENT_LINKS_ENABLED,
  type SignedLinkPrice,
} from "../../../lib/paymentLinks";
import { ACTIVE_CHAIN } from "../../../lib/chain";
import { useT } from "../../../lib/i18n";
import { PaymentLinkPoster } from "../../../components/PaymentLinkPoster";
import { Icon } from "../../../components/Icons";

/**
 * Merchant-facing Payment Link creation. Mirrors /qr's auth-gate shape
 * (useMerchant -> Splash -> registration redirect -> <Nav back/>) and its
 * amount/currency entry UI.
 *
 * Two steps, matching the worker's required ordering (payment-integrators
 * PR #104, worker/src/provision.ts):
 *   1. provisionLinkWallet — an off-chain request, signed (EIP-712) by the
 *      merchant's smart account, that mints the link's own funds-free AA
 *      wallet and returns its address.
 *   2. ONE sponsored, merchant-signed BATCH transaction: createLink then
 *      registerAgent, in that order — registerAgent reads getLink to check
 *      ownership, so createLink must land first within the same batch.
 * No session key, no delegate, no funded relayer; the backend (the separate
 * payer-relayer service) only ever drives that link's own wallet later, when a
 * customer pays — never anything created or funded here.
 */
export default function CreatePaymentLink() {
  const router = useRouter();
  const { ready, authenticated, address, isRegistered, sendBatchTransaction, signTypedData } = useMerchant();
  const { t, lang } = useT();
  const publicClient = usePublicClient();

  useEffect(() => {
    if (ready && isRegistered === false) router.replace("/onboarding");
  }, [ready, isRegistered, router]);

  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address },
  });
  const registeredCurrency = currencyFromBytes32((info?.[2] as string) || "") || "INR";

  /**
   * The currency THIS LINK charges in, which need not be the merchant's own.
   *
   * The contract supports this explicitly rather than by accident —
   * PaymentLinksLib.create takes the currency as a parameter, and
   * `validateOrder` ignores the order's currency entirely, keying the per-tx
   * cap off the merchant's REGISTERED currency instead. Its own comment spells
   * out the case: "an INR merchant keeps their INR cap even on a BRL link".
   *
   * So an Indian merchant can invoice a Brazilian customer in BRL. The customer
   * pays R$ through Pix, the LP settles it, and the merchant is credited in
   * USDC exactly as they would be for a rupee sale — the conversion is the
   * protocol's live price for that currency, not a rate we invent.
   *
   * One consequence worth keeping in mind: the CAP does not travel. An INR
   * merchant keeps the 50-USDC INR cap on a BRL link, not the 100-USDC default.
   */
  const [currency, setCurrency] = useState("");
  const [supported, setSupported] = useState<string[]>([]);

  useEffect(() => {
    // Which currencies the protocol can actually settle, read from its live
    // circles rather than hardcoded — a currency with no funded circle would
    // produce a link nobody can pay. Several circles can share a code (INR has
    // two), so dedupe.
    // A currency is offered only if BOTH are true: the protocol has a funded
    // circle for it, AND this app has a country entry.
    //
    // The circle alone is not enough. The protocol settles IDR, but nothing
    // here knows what Indonesia's rail is called, what its payout handle looks
    // like, or how its numbers group — so an IDR link would render as a bare
    // ISO code with a generic bank-transfer card and no validation on the
    // merchant's payout id. Listing a currency we cannot present properly
    // invites a merchant to issue a link they cannot support.
    //
    // This also means the two lists stay in step on their own: add a country to
    // lib/countries.ts and it appears here the moment a circle exists for it;
    // add a circle for something unlisted and it stays hidden until someone
    // fills in how to display it.
    fetchSupportedCurrencies()
      .then((rows) => {
        const live = Array.from(new Set(rows.map((r) => r.code))).filter(Boolean);
        setSupported(live.filter((code) => COUNTRIES.some((c) => c.code === code)));
      })
      .catch(() => setSupported([]));
  }, []);

  // Default to the merchant's own currency once it has loaded — the common case
  // by far, and the one that needs no thought.
  useEffect(() => {
    if (!currency && registeredCurrency) setCurrency(registeredCurrency);
  }, [registeredCurrency, currency]);

  const linkCurrency = currency || registeredCurrency;
  const country = countryForCurrency(linkCurrency);

  /**
   * The merchant's per-payment ceiling, read live.
   *
   * `PaymentLinksLib.create` refuses a fixed amount above it (ExceedsPerTxCap)
   * — sensibly, since such a link would revert at pay time in front of a
   * customer with the merchant absent. But nothing checked it here, so the
   * merchant learned about it as a failed sponsored transaction reporting a raw
   * selector, after signing.
   *
   * Keyed off the merchant's REGISTERED currency, not the link's: that is what
   * the contract enforces, and the distinction is the whole reason an INR
   * merchant keeps a 50-USDC cap on a BRL link.
   */
  const [capUsdc6, setCapUsdc6] = useState<bigint | null>(null);
  useEffect(() => {
    if (!publicClient || !registeredCurrency) return;
    let alive = true;
    publicClient
      .readContract({
        address: CONTRACT_ADDRESS,
        abi: INTEGRATOR_ABI,
        functionName: "perTxCap",
        args: [stringToHex(registeredCurrency, { size: 32 })],
      } as any)
      .then((v: any) => { if (alive && typeof v === "bigint" && v > 0n) setCapUsdc6(v); })
      // Unreadable: let the contract be the judge rather than blocking a link
      // that would have been fine.
      .catch(() => {});
    return () => { alive = false; };
  }, [publicClient, registeredCurrency]);

  const [amountMode, setAmountMode] = useState<"fixed" | "variable">("fixed");
  const [amountFiat, setAmountFiat] = useState("");
  /** Which unit the typed number is in. USDC is stored on-chain as the link's
   *  fixed amount; a local-currency amount is kept by the relayer, signed by
   *  the merchant, and priced at payment time (see fixedAmountTypedData). */
  const [amountUnit, setAmountUnit] = useState<"fiat" | "usdc">("fiat");

  // The live price, held in state rather than fetched only at submit, so the
  // equivalence below can update as the merchant types. Re-fetched when the
  // link's currency changes, since the rate is per-currency.
  const { cfg: priceCfg, failed: priceFailed } = usePriceConfig(linkCurrency);

  // Whether the relayer can hold a fixed LOCAL price. Without it a local
  // amount is fixed in USDC on-chain instead — safe, since the contract
  // enforces it, but the customer's amount then moves slightly with the rate.
  const [localPriceSupported, setLocalPriceSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    relayerFeatures().then((f) => { if (alive) setLocalPriceSupported(f.has("fixed-price")); });
    return () => { alive = false; };
  }, []);

  /**
   * What the typed amount comes to in the OTHER unit, plus a warning when it is
   * over the cap — shown while typing rather than discovered on submit.
   */
  const equivalentHint = (() => {
    const typed = Number(amountFiat);
    if (!typed || typed <= 0) return "";
    if (!priceCfg) return priceFailed ? t("link.rateUnavailable") : t("qr.fetchingRate");
    const usdc6 =
      amountUnit === "usdc" ? usdcForUsdcTarget(typed, priceCfg) : usdcForFiat(typed, priceCfg);
    if (usdc6 <= 0n) return "";
    const over = capUsdc6 !== null && usdc6 > capUsdc6;
    if (over) {
      const capFiat = fiatForUsdc(capUsdc6!, priceCfg);
      return fill(t("link.overLimit"), { limit: fmtFiat(country, capFiat) });
    }
    // A local amount is what the customer pays, always; the USDC it credits is
    // today's figure and moves with the rate (after p2p.me's small-order fee).
    if (amountUnit === "usdc") return fill(t("link.customerPaysApprox"), { fiat: fmtFiat(country, fiatForUsdc(usdc6, priceCfg)) });
    return localPriceSupported === false
      ? fill(t("link.paysVaries"), { fiat: fmtFiat(country, typed), usdc: (Number(usdc6) / 1e6).toFixed(2) })
      : fill(t("link.paysFixed"), { fiat: fmtFiat(country, typed), usdc: (Number(usdc6) / 1e6).toFixed(2) });
  })();
  const [singleUse, setSingleUse] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState<"" | "1" | "7" | "30">("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError | string>("");
  // Synchronous lock: a double tap on "Create" can never start two links.
  const creator = useGuardedSend();
  // A link whose creation tx was submitted but whose outcome is unknown. While
  // this exists the form is locked, so a timeout can never lead to a duplicate.
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [startOverOpen, setStartOverOpen] = useState(false);
  const [checkMsg, setCheckMsg] = useState("");
  const [created, setCreated] = useState<{
    linkId: string; url: string;
    summary?: { mode: "fixed" | "variable"; amount: string; currency: string; single: boolean; expiresDays: string };
  } | null>(null);
  const copier = useCopy();
  const [posterDataUrl, setPosterDataUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  if (!ready || !authenticated) return <Splash />;

  if (!PAYMENT_LINKS_ENABLED) {
    return (
      <>
        <Nav back backHref="/payment-links" />
        <div className="screen">
          <div className="card">
            <div className="label">{t("pl.title")}</div>
            <div className="sub">{t("plx.notConfigured")}</div>
          </div>
        </div>
      </>
    );
  }

  // Guarded entry point (see useGuardedSend): the lock is taken synchronously,
  // so the ONLY way to a second createLink is a deliberate "Start over".
  function handleCreate() {
    if (pendingLink) return;
    return creator.run(createLinkFlow, { skipStepUp: true });
  }

  async function createLinkFlow() {
    setError("");
    setBusy(true);
    // "submitted" = the batch tx may now exist on-chain. Before that point a
    // failure is certain (nothing was made); after it, only a known revert or a
    // wallet cancel is certain.
    let stage: "prep" | "submitted" = "prep";
    try {
      // Re-read rather than trusting the state used for the live hint: the rate
      // moves, and the number actually written on-chain should be priced at
      // submit time, not at whatever moment the merchant last typed.
      const cfg = amountMode === "fixed" ? await fetchPriceConfig(linkCurrency) : null;
      let amountUsdc6 = 0n;
      // A fixed LOCAL amount: the link is open-amount on-chain, and the relayer
      // keeps this signed price and charges it (see fixedAmountTypedData).
      let fixedLocal6: bigint | null = null;
      if (amountMode === "fixed") {
        const typed = Number(amountFiat);
        if (!typed || typed <= 0) throw new ValidationError(t("plx.badAmount"));
        if (!cfg) throw new ValidationError(t("plx.cantPrice"));
        // usdcForUsdcTarget inverts the small-order fee so "5 USDC" charges the
        // customer five, not five plus a fee. A local amount is priced again at
        // payment time; today's USDC here only checks it against the cap.
        // Below p2p.me's small-order fee the customer would pay the fee on top.
        const floor = amountUnit === "usdc" ? minimumUsdc(cfg) : minimumFiat(cfg);
        if (typed < floor) {
          const shown = Math.ceil(floor * 100) / 100;
          throw new ValidationError(
            `That amount is too small — the minimum is ${amountUnit === "usdc" ? `${shown.toFixed(2)} USDC` : fmtFiat(country, shown)}.`
          );
        }
        const usdc6 = amountUnit === "usdc" ? usdcForUsdcTarget(typed, cfg) : usdcForFiat(typed, cfg);
        if (usdc6 <= 0n) throw new ValidationError(t("plx.tooSmall"));
        if (amountUnit === "usdc") amountUsdc6 = usdc6;
        // Asked now, not trusted from the page's first load: a local price sent
        // to a relayer that can't keep it would leave the link pay-anything.
        else if ((await relayerFeatures()).has("fixed-price")) fixedLocal6 = BigInt(Math.round(typed * 1e6));
        // The relayer can't hold a local price: fix it in USDC on-chain, which
        // the contract enforces.
        else amountUsdc6 = usdc6;
        // Refuse here, in the merchant's own words, rather than letting
        // createLink revert ExceedsPerTxCap after they have signed.
        if (capUsdc6 !== null && usdc6 > capUsdc6) {
          const capFiat = fiatForUsdc(capUsdc6, cfg);
          throw new ValidationError(
            `That is above your limit of ${fmtFiat(country, capFiat)} per payment. ` +
              `Lower the amount, or use a Counter QR and let the customer pay in parts.`
          );
        }
      }

      const expiresAt =
        expiresInDays === "" ? 0 : Math.floor(Date.now() / 1000) + Number(expiresInDays) * 86400;

      // createLink no longer returns the id or emits it in a way worth
      // trusting from a return value — the CALLER derives it up front via
      // computeLinkId(merchant, salt) (payment-integrators PR #104) and just
      // uses that if the transaction succeeds.
      const salt = randomLinkSalt();
      const linkId = computeLinkId(address as `0x${string}`, salt);

      if (!signTypedData || !sendBatchTransaction) {
        throw new ValidationError(t("plx.walletNotReady"));
      }

      // Signed before the link exists — the signature only names the id — and
      // handed to the relayer with provisioning, which keeps it BEFORE the link
      // is created: a failure there stops here with nothing made on-chain.
      let fixedPrice: SignedLinkPrice | null = null;
      if (fixedLocal6 !== null) {
        const currency = stringToHex(linkCurrency, { size: 32 });
        const signature = await signTypedData(fixedAmountTypedData(ACTIVE_CHAIN.id, linkId, fixedLocal6, currency));
        fixedPrice = { amount6: fixedLocal6, currency, signature };
      }

      // 1 — Mint the link's own funds-free AA wallet from the worker. Must
      // happen BEFORE createLink: registerAgent needs its address, and the
      // worker's own ordering contract requires createLink + registerAgent to
      // land in the SAME batch (see lib/paymentLinks.ts's provisionLinkWallet).
      const { account: agent } = await provisionLinkWallet({
        linkId,
        chainId: ACTIVE_CHAIN.id,
        signTypedData,
        signerAddress: address as `0x${string}`,
        ...(fixedPrice ? { fixedPrice } : {}),
      });

      const registerData = buildRegisterAgentCalldata(linkId, agent);
      // Every attempt draws a fresh salt, so the link id is new each time and
      // createLink cannot already have landed from an earlier attempt — the
      // "already created" branch that lived here could never run (review).
      const batch = [
        {
          to: CONTRACT_ADDRESS,
          data: buildCreateLinkCalldata({
            linkId,
            amountUsdc6,
            currencyCode: linkCurrency,
            maxUses: singleUse ? 1 : 0,
            expiresAt,
          }),
        },
        { to: LINK_ROUTER_ADDRESS as `0x${string}`, data: registerData },
      ];

      // 2 — ONE batched transaction: createLink then registerAgent, in that
      // order.
      // registerAgent reads getLink to check ownership, so a link that
      // doesn't exist yet within the same batch makes it revert — never send
      // these as two separate transactions (see provisionLinkWallet's doc).
      // Write the link id down FIRST. If the connection drops or the receipt
      // times out from here on, this record is what stops the merchant from
      // creating a second link for the same intent, and what lets the page find
      // the first one.
      const rec: PendingLink = { linkId, url: buildPayLinkUrl(linkId), at: Date.now() };
      savePendingLink(address, rec);
      stage = "submitted";
      const hash = await sendBatchTransaction(batch);
      const receipt = await publicClient!.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status === "reverted") {
        clearPendingLink(address); // a reverted batch created nothing
        throw new Error("create reverted");
      }
      clearPendingLink(address);

      // Record the id locally, now that the link definitely exists on-chain.
      // The list page cannot reliably rediscover it: getMerchantLinks is not
      // deployed on every integrator, and the log-scan fallback only reaches a
      // couple of hours back on a rate-limited RPC — after which a merchant's
      // own links vanish from their own list. Only the ID is stored; every
      // field still comes from getLink on-chain.
      rememberLink(address as `0x${string}`, linkId);

      // A plain URL: the price, if any, is the relayer's, not the link's.
      const url = buildPayLinkUrl(linkId);
      setCreated({
        linkId, url,
        summary: {
          mode: amountMode, currency: linkCurrency, single: singleUse, expiresDays: expiresInDays,
          amount: amountMode === "fixed"
            ? (amountUnit === "usdc" ? `${Number(amountFiat).toFixed(2)} USDC` : fmtFiat(country, Number(amountFiat)))
            : "",
        },
      });
    } catch (e: any) {
      const ue = toUserError(e, { context: "create-link", fallbackKey: "err.createLink", uncertainKey: stage === "submitted" ? "err.uncertainLink" : undefined });
      if (stage === "submitted" && !ue.uncertain && (ue.kind === "unknown" || ue.kind === "network")) {
        // Unknown failure AFTER submit: the batch may still land. Keep the record.
        ue.uncertain = true;
        ue.message = t("err.uncertainLink");
      }
      if (stage === "submitted" && ue.uncertain) {
        setPendingLink(loadPendingLink(address));
      } else if (stage === "submitted") {
        clearPendingLink(address); // cancel or a known revert: nothing was created
      }
      setError(ue);
    } finally {
      setBusy(false);
    }
  }

  // Look for the exact link id we wrote down. Read-only; safe to repeat.
  async function checkPendingLink(silent = false) {
    const rec = loadPendingLink(address);
    if (!rec || !publicClient) return;
    try {
      const link = await fetchLink(publicClient, rec.linkId as `0x${string}`);
      if (link.owner && !/^0x0+$/i.test(link.owner)) {
        rememberLink(address as `0x${string}`, rec.linkId as `0x${string}`);
        clearPendingLink(address);
        setPendingLink(null); setError(""); setCheckMsg("");
        setCreated({ linkId: rec.linkId, url: rec.url });
      } else if (!silent) {
        setCheckMsg(t("link.notFoundYet"));
      }
    } catch (e) {
      // getLink REVERTS (LinkNotFound) for an id that is not on chain — that is
      // "not there yet", not a connection problem.
      if (!silent) setCheckMsg(t(isLinkNotFound(e) ? "link.notFoundYet" : "err.network"));
    }
  }

  useEffect(() => { setPendingLink(loadPendingLink(address)); }, [address]);
  useEffect(() => {
    if (!pendingLink) return;
    checkPendingLink(true);
    const id = setInterval(() => { if (document.visibilityState === "visible") checkPendingLink(true); }, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLink?.linkId, publicClient]);

  async function handleShare() {
    if (!created || sharing) return;
    setSharing(true);
    try {
      const message = `Hi! Please complete your payment securely with PayQR.

Scan the QR code or tap the link below to pay:

${created.url}`;

      // Try image + text + link together first (the native share sheet on
      // Android/iOS supports this combination for MANY targets — Messages,
      // Telegram, Mail, etc.). Some targets that accept files (notably
      // WhatsApp) silently drop the text/url when a file is attached — a
      // known platform limitation this code can't work around, not a bug
      // here. canShare() is the only reliable way to know ahead of time
      // whether files can be combined with text at all on this device.
      if (posterDataUrl && navigator.canShare) {
        try {
          const res = await fetch(posterDataUrl);
          const blob = await res.blob();
          const file = new File([blob], `payqr-${created.linkId}.png`, { type: "image/png" });
          const filesPayload = { files: [file], title: "PayQR payment link", text: message };
          if (navigator.canShare(filesPayload)) {
            await navigator.share(filesPayload);
            navigator.clipboard?.writeText(created.url).catch(() => {});
            return;
          }
        } catch (e: any) {
          // AbortError = the user closed the share sheet — not a failure,
          // don't fall back into a second share prompt right after.
          if (e?.name === "AbortError") return;
        }
      }

      // Fall back to a text+url-only share (no image) — still opens the
      // native share sheet with the message and link intact.
      if (navigator.share) {
        try {
          await navigator.share({ title: "PayQR payment link", text: message, url: created.url });
          navigator.clipboard?.writeText(created.url).catch(() => {});
          return;
        } catch (e: any) {
          if (e?.name === "AbortError") return;
        }
      }

      // No Web Share API at all (most desktop browsers) — copy is the best
      // available action, matching the button's previous "Copy link" behavior.
      navigator.clipboard?.writeText(created.url).catch(() => {});
    } finally {
      setSharing(false);
    }
  }

  function copyLink() {
    if (created) copier.copy(created.url, "created");
  }

  if (created) {
    const sm = created.summary;
    const copied = copier.copiedKey === "created";
    return (
      <>
        <Nav back backHref="/payment-links" />
        <div className="screen pl-done">
          <div className="pl-done-head">
            <div className="pl-done-title">{t("link.createdTitle")}</div>
            <div className="pl-done-url">
              <span>{created.url}</span>
              <button
                type="button"
                className={`pl-done-copy${copied ? " copied" : ""}`}
                onClick={copyLink}
                aria-label={t("link.copyAria")}
                title={copied ? t("ui.copied") : t("link.copyLink")}
              >
                {copied ? <Icon.Check width="14" height="14" /> : <Icon.Copy width="14" height="14" />}
              </button>
            </div>
            {copier.failedKey === "created" && <p className="error" role="alert">{t("ui.copyFailed")}</p>}
          </div>

          {/* What was created, in plain words. */}
          {sm && (
            <div className="pl-card pl-summary">
              <div className="pl-sum-row"><span>{t("link.type")}</span><b>{sm.mode === "fixed" ? t("link.fixed") : t("link.counter")}</b></div>
              <div className="pl-sum-row"><span>{t("link.amount")}</span><b>{sm.mode === "fixed" ? sm.amount : t("link.customerTypes")}</b></div>
              <div className="pl-sum-row"><span>{t("link.currency")}</span><b>{sm.currency}</b></div>
              <div className="pl-sum-row"><span>{t("link.uses")}</span><b>{sm.single ? t("link.single") : t("link.multi")}</b></div>
              <div className="pl-sum-row"><span>{t("link.expires")}</span><b>{sm.expiresDays ? fmtLockWindow(Number(sm.expiresDays) * 86400, lang) : t("link.never")}</b></div>
            </div>
          )}

          <PaymentLinkPoster
            url={created.url}
            fileName={`payqr-${created.linkId}.png`}
            downloadLabel={t(sm?.mode === "variable" ? "link.downloadCounter" : "link.downloadQr")}
            onPosterReady={setPosterDataUrl}
          />

          {/* What happens next — the merchant's side of the payment. */}
          <div className="pl-card">
            <div className="pl-section-label">{t("link.nextTitle")}</div>
            <ul className="pl-next">
              <li>{fill(t("link.next1"), { method: country.fiat })}</li>
              <li>{t("link.next2")}</li>
              <li><SettlementNote currency={registeredCurrency} /></li>
              <li>{t("link.next3")}</li>
            </ul>
          </div>

          <div className="pl-done-actions">
            <button className="btn" onClick={handleShare} disabled={sharing}>
              {sharing ? t("link.sharing") : t("link.share")}
            </button>
            <button className="btn secondary" onClick={() => router.push("/payment-links")}>
              {t("ui.done")}
            </button>
          </div>
          <button className="linklike" style={{ margin: "10px auto 0", display: "block" }}
            onClick={() => { setCreated(null); setAmountFiat(""); setPosterDataUrl(null); }}>
            {t("link.another")}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <Nav back backHref="/payment-links" />
      <div className="screen pl-create">
        <div className="pl-head" style={{ textAlign: "center" }}>
          <div className="pl-title">{t("link.title")}</div>
        </div>

        {/* CURRENCY. Applies to BOTH link types: a fixed link is priced in it,
            and a counter QR is the currency the customer types their amount in.
            Offered only for currencies the protocol has a live circle for —
            anything else would create a link nobody can pay. Hidden entirely
            when there is only one choice, so the common case stays one tap. */}
        {supported.length > 1 && (
          <div className="pl-card">
            <div className="pl-section-label">{t("link.currency")}</div>
            <div className="chip-row">
              {supported.map((code) => (
                <button
                  key={code}
                  type="button"
                  className={`chip ${linkCurrency === code ? "on" : ""}`}
                  onClick={() => setCurrency(code)}
                >
                  {countryForCurrency(code).flag} {code}
                </button>
              ))}
            </div>
            {linkCurrency !== registeredCurrency && (
              <div className="pl-hint">
                {fill(t("link.chargedIn"), { cur: linkCurrency, reg: registeredCurrency })}
              </div>
            )}
          </div>
        )}

        <div className="pl-card">
          <div className="pl-section-label">{t("link.amount")}</div>
          <div className="seg" role="group" aria-label={t("link.type")}>
            <button
              type="button"
              className={`seg-opt ${amountMode === "fixed" ? "on" : ""}`}
              onClick={() => {
                setAmountMode("fixed");
                setSingleUse(true);
                setExpiresInDays("7");
              }}
            >
              {t("link.fixed")}
            </button>
            <button
              type="button"
              className={`seg-opt ${amountMode === "variable" ? "on" : ""}`}
              onClick={() => {
                setAmountMode("variable");
                // A counter QR is a standing terminal for walk-in sales, not a
                // one-off share — it should stay put and keep taking payments
                // rather than default to expiring or locking after one use.
                setSingleUse(false);
                setExpiresInDays("");
              }}
            >
              {t("link.counter")}
            </button>
          </div>
          {/* Say what each one IS, so the merchant picks on purpose. */}
          <div className="pl-hint" style={{ marginBottom: 8 }}>
            {amountMode === "fixed" ? t("link.fixedDesc") : t("link.counterDesc")}
          </div>

          {amountMode === "fixed" ? (
            <>
              <div className="pl-amount-row">
                <span className="pl-amount-symbol">
                  {amountUnit === "usdc" ? "$" : country.symbol}
                </span>
                <input
                  className="pl-amount-input"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  aria-label={t("link.amount")}
                  value={amountFiat}
                  onChange={(e) => setAmountFiat(e.target.value)}
                />
              </div>

              {/* Enter in either unit. The merchant thinks in their own
                  currency when pricing goods, but the LIMIT the contract
                  enforces is in USDC — so a merchant near the cap was doing the
                  conversion in their head to find out whether a price would be
                  accepted. Neither unit is the "real" one: the link stores
                  6-decimal USDC either way. */}
              <div className="seg" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className={`seg-opt ${amountUnit === "fiat" ? "on" : ""}`}
                  onClick={() => setAmountUnit("fiat")}
                >
                  {linkCurrency}
                </button>
                <button
                  type="button"
                  className={`seg-opt ${amountUnit === "usdc" ? "on" : ""}`}
                  onClick={() => setAmountUnit("usdc")}
                >
                  USDC
                </button>
              </div>

              {equivalentHint && <div className="pl-hint">{equivalentHint}</div>}
            </>
          ) : (
            <div className="pl-hint">{t("link.variableHint")}</div>
          )}
        </div>

        <div className="pl-card">
          <div className="pl-row-split">
            <div className="pl-field-half">
              <div className="pl-section-label">{t("link.uses")}</div>
              <div className="seg">
                <button
                  type="button"
                  className={`seg-opt ${singleUse ? "on" : ""}`}
                  onClick={() => setSingleUse(true)}
                >
                  {t("link.single")}
                </button>
                <button
                  type="button"
                  className={`seg-opt ${!singleUse ? "on" : ""}`}
                  onClick={() => setSingleUse(false)}
                >
                  {t("link.multi")}
                </button>
              </div>
              {amountMode === "variable" && singleUse && (
                <div className="pl-hint" style={{ color: "var(--warn)" }}>{t("link.counterSingleWarn")}</div>
              )}
            </div>
          </div>

          <div className="pl-section-label" style={{ marginTop: 18 }}>{t("link.expires")}</div>
          <div className="chip-row">
            {(["1", "7", "30", ""] as const).map((d) => (
              <button
                key={d || "never"}
                type="button"
                className={`chip ${expiresInDays === d ? "on" : ""}`}
                onClick={() => setExpiresInDays(d)}
              >
                {d === "" ? t("link.never") : fmtLockWindow(Number(d) * 86400, lang)}
              </button>
            ))}
          </div>
        </div>

        {/* STILL CONFIRMING: the creation tx was submitted but its outcome is
            unknown. The form below is locked so a timeout can never produce a
            duplicate link; the page keeps checking for the exact link id. */}
        {pendingLink && (
          <div className="ui-err ui-err-warn" role="status">
            <div className="ui-err-msg"><b>{t("link.confirmingTitle")}</b></div>
            <div className="ui-err-msg" style={{ marginTop: 4 }}>{t("err.uncertainLink")}</div>
            {checkMsg && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{checkMsg}</div>}
            <div className="ui-err-actions">
              <button className="btn small" onClick={() => checkPendingLink(false)}>{t("link.checkNow")}</button>
              <button className="btn small ghost" onClick={() => setStartOverOpen(true)}>{t("link.startOver")}</button>
            </div>
          </div>
        )}
        {!pendingLink && <ErrorPanel error={error} />}
        {!pendingLink && checkMsg && <p className="error" role="alert">{checkMsg}</p>}

        {/* Before creating: what happens to the money. */}
        <div className="pl-card"><SettlementNote currency={registeredCurrency} /></div>

        <button className="btn pl-submit" disabled={busy || creator.busy || !!pendingLink} onClick={handleCreate}>
          {busy || creator.busy ? t("link.creating") : t("link.create")}
        </button>
        {(busy || creator.busy) && <p className="muted" style={{ textAlign: "center", fontSize: 12.5 }}>{t("ui.stillWorking")}</p>}

        <ConfirmDialog
          open={startOverOpen}
          tone="danger"
          title={t("link.startOverTitle")}
          confirmLabel={t("link.startOver")}
          onCancel={() => setStartOverOpen(false)}
          onConfirm={() => { clearPendingLink(address); setPendingLink(null); setError(""); setCheckMsg(""); setStartOverOpen(false); }}
        >
          <p>{t("link.startOverBody")}</p>
        </ConfirmDialog>
      </div>
    </>
  );
}
