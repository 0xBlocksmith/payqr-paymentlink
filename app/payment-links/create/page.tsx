"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePublicClient } from "wagmi";
import { Nav } from "../../../components/Nav";
import { Splash } from "../../../components/Splash";
import { useMerchant } from "../../../components/useMerchant";
import { useRelayIdentity } from "../../../components/useRelayIdentity";
import { CONTRACT_ADDRESS, LINK_ROUTER_ADDRESS, INTEGRATOR_ABI, friendlyError, currencyFromBytes32 } from "../../../lib/contract";
import { stringToHex } from "viem";
import { useReadContract } from "wagmi";
import { countryForCurrency, fmtFiat, COUNTRIES } from "../../../lib/countries";
import { fetchSupportedCurrencies } from "../../../lib/p2p";
import { fetchPriceConfig, usdcForFiat, fiatForUsdc, usdcForUsdcTarget } from "../../../lib/pricing";
import { encryptToSelf } from "../../../lib/payoutCrypto";
import {
  buildCreateLinkCalldata,
  buildRegisterAgentCalldata,
  provisionLinkWallet,
  computeLinkId,
  randomLinkSalt,
  buildPayLinkUrl,
  rememberLink,
  PAYMENT_LINKS_ENABLED,
} from "../../../lib/paymentLinks";
import { ACTIVE_CHAIN } from "../../../lib/chain";
import { useT } from "../../../lib/i18n";
import { PaymentLinkPoster } from "../../../components/PaymentLinkPoster";

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
 * No session key, no delegate, no funded relayer; the backend (a separate
 * Cloudflare Worker) only ever drives that link's own wallet later, when a
 * customer pays — never anything created or funded here.
 */
export default function CreatePaymentLink() {
  const router = useRouter();
  const { ready, authenticated, address, isRegistered, sendBatchTransaction, signTypedData } = useMerchant();
  const { t } = useT();
  const { getIdentity } = useRelayIdentity();
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
  /** Which unit the typed number is in. The link always stores 6-dec USDC. */
  const [amountUnit, setAmountUnit] = useState<"fiat" | "usdc">("fiat");

  // The live price, held in state rather than fetched only at submit, so the
  // equivalence below can update as the merchant types. Re-fetched when the
  // link's currency changes, since the rate is per-currency.
  const [priceCfg, setPriceCfg] = useState<Awaited<ReturnType<typeof fetchPriceConfig>>>(null);
  useEffect(() => {
    if (!linkCurrency) return;
    let alive = true;
    fetchPriceConfig(linkCurrency)
      .then((cfg) => { if (alive) setPriceCfg(cfg); })
      .catch(() => { if (alive) setPriceCfg(null); });
    return () => { alive = false; };
  }, [linkCurrency]);

  /**
   * What the typed amount comes to in the OTHER unit, plus a warning when it is
   * over the cap — shown while typing rather than discovered on submit.
   */
  const equivalentHint = (() => {
    const typed = Number(amountFiat);
    if (!typed || typed <= 0) return "";
    if (!priceCfg) return "Fetching today's rate…";
    const usdc6 =
      amountUnit === "usdc" ? usdcForUsdcTarget(typed, priceCfg) : usdcForFiat(typed, priceCfg);
    if (usdc6 <= 0n) return "";
    const over = capUsdc6 !== null && usdc6 > capUsdc6;
    const other =
      amountUnit === "usdc"
        ? `≈ ${fmtFiat(country, fiatForUsdc(usdc6, priceCfg))}`
        : `≈ ${(Number(usdc6) / 1e6).toFixed(2)} USDC`;
    if (!over) return `Customer pays ${other}`;
    const capFiat = fiatForUsdc(capUsdc6!, priceCfg);
    return `${other} — over your ${fmtFiat(country, capFiat)} limit per payment.`;
  })();
  const [description, setDescription] = useState("");
  const [singleUse, setSingleUse] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState<"" | "1" | "7" | "30">("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ linkId: string; url: string } | null>(null);
  const [posterDataUrl, setPosterDataUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  if (!ready || !authenticated) return <Splash />;

  if (!PAYMENT_LINKS_ENABLED) {
    return (
      <>
        <Nav back backHref="/payment-links" />
        <div className="screen">
          <div className="card">
            <div className="label">Payment Links</div>
            <div className="sub">This feature isn't configured on this deployment yet.</div>
          </div>
        </div>
      </>
    );
  }

  async function handleCreate() {
    setError("");
    setBusy(true);
    try {
      // Re-read rather than trusting the state used for the live hint: the rate
      // moves, and the number actually written on-chain should be priced at
      // submit time, not at whatever moment the merchant last typed.
      const cfg = amountMode === "fixed" ? await fetchPriceConfig(linkCurrency) : null;
      let amountUsdc6 = 0n;
      if (amountMode === "fixed") {
        const typed = Number(amountFiat);
        if (!typed || typed <= 0) throw new Error("Enter a valid amount.");
        if (!cfg) throw new Error("Could not price this amount right now. Try again shortly.");
        // Either unit lands on the same field — the link stores 6-decimal USDC
        // regardless. usdcForUsdcTarget inverts the small-order fee so "5 USDC"
        // charges the customer five, not five plus a fee.
        amountUsdc6 =
          amountUnit === "usdc" ? usdcForUsdcTarget(typed, cfg) : usdcForFiat(typed, cfg);
        if (amountUsdc6 <= 0n) throw new Error("That amount is too small.");
        // Refuse here, in the merchant's own words, rather than letting
        // createLink revert ExceedsPerTxCap after they have signed.
        if (capUsdc6 !== null && amountUsdc6 > capUsdc6) {
          const capFiat = fiatForUsdc(capUsdc6, cfg);
          throw new Error(
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
        throw new Error("Wallet isn't ready yet. Please try again in a moment.");
      }

      // Encrypt the description to the merchant's OWN relay key before it ever
      // reaches calldata — LinkCreated emits encryptedConfig as a PUBLIC event
      // field, so sending it as plaintext (the previous behavior here) made
      // any order reference or note in the description permanently
      // world-readable on-chain. Self-recipient, same primitive as the
      // merchant's payout handle (lib/payoutCrypto.ts) — only the merchant's
      // own browser (or another device after re-entering it) can decrypt it
      // back; nothing downstream currently decrypts and shows it, but at
      // least it's no longer plaintext meanwhile.
      let encryptedConfig: `0x${string}` | undefined;
      // Encrypted, the description grows past the contract's 1,024-byte limit
      // (FieldTooLong) at roughly 250 bytes of text — about 85 characters in
      // Hindi. Refuse it here, before the merchant signs anything.
      if (description && new TextEncoder().encode(description).length > 250) {
        throw new Error("That description is too long — please shorten it.");
      }
      if (description) {
        const identity = await getIdentity();
        encryptedConfig = await encryptToSelf(description, identity, "Could not secure the description. Please try again.");
      }

      // 1 — Mint the link's own funds-free AA wallet from the worker. Must
      // happen BEFORE createLink: registerAgent needs its address, and the
      // worker's own ordering contract requires createLink + registerAgent to
      // land in the SAME batch (see lib/paymentLinks.ts's provisionLinkWallet).
      const { account: agent, existing } = await provisionLinkWallet({
        linkId,
        chainId: ACTIVE_CHAIN.id,
        signTypedData,
        signerAddress: address as `0x${string}`,
      });

      // `existing: true` means the worker has already minted this exact
      // linkId's wallet before (a retried provisioning call, not a fresh
      // one) — registerAgent is safe to resend regardless, but createLink is
      // NOT: if it already landed on-chain from that earlier attempt,
      // resending it here reverts with LinkExists() and drags the whole
      // batch down with it. Check on-chain rather than assume either way.
      let createAlreadyLanded = false;
      if (existing) {
        try {
          const existingLink = (await publicClient!.readContract({
            address: CONTRACT_ADDRESS,
            abi: INTEGRATOR_ABI,
            functionName: "getLink",
            args: [linkId],
          } as any)) as readonly [`0x${string}`, bigint, `0x${string}`, bigint, number, number, number, number];
          createAlreadyLanded = existingLink[0] !== "0x0000000000000000000000000000000000000000";
        } catch {
          // Read failure — fall through and attempt createLink as normal;
          // if it truly already exists, LinkExists() surfaces below anyway.
        }
      }

      const registerData = buildRegisterAgentCalldata(linkId, agent);
      const batch = createAlreadyLanded
        ? [{ to: LINK_ROUTER_ADDRESS as `0x${string}`, data: registerData }]
        : [
            {
              to: CONTRACT_ADDRESS,
              data: buildCreateLinkCalldata({
                linkId,
                amountUsdc6,
                currencyCode: linkCurrency,
                maxUses: singleUse ? 1 : 0,
                expiresAt,
                encryptedConfig,
              }),
            },
            { to: LINK_ROUTER_ADDRESS as `0x${string}`, data: registerData },
          ];

      // 2 — ONE batched transaction: createLink then registerAgent, in that
      // order (unless createLink already landed from a prior attempt, above).
      // registerAgent reads getLink to check ownership, so a link that
      // doesn't exist yet within the same batch makes it revert — never send
      // these as two separate transactions (see provisionLinkWallet's doc).
      const hash = await sendBatchTransaction(batch);
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("The transaction reverted.");

      // Record the id locally, now that the link definitely exists on-chain.
      // The list page cannot reliably rediscover it: getMerchantLinks is not
      // deployed on every integrator, and the log-scan fallback only reaches a
      // couple of hours back on a rate-limited RPC — after which a merchant's
      // own links vanish from their own list. Only the ID is stored; every
      // field still comes from getLink on-chain.
      rememberLink(address as `0x${string}`, linkId);

      const url = buildPayLinkUrl(linkId);
      setCreated({ linkId, url });
    } catch (e: any) {
      setError(friendlyError(e, e?.message || "Could not create the link. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function handleShare() {
    if (!created || sharing) return;
    setSharing(true);
    try {
      const message = `Pay me on PayQR: ${created.url}`;

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

  if (created) {
    return (
      <>
        <Nav back backHref="/payment-links" />
        <div className="screen pl-done">
          <div className="pl-done-head">
            <div className="pl-done-title">Payment link created</div>
            <div className="pl-done-url">{created.url}</div>
          </div>

          <PaymentLinkPoster
            url={created.url}
            fileName={`payqr-${created.linkId}.png`}
            downloadLabel="Download Counter QR"
            onPosterReady={setPosterDataUrl}
          />

          <div className="pl-done-actions">
            <button className="btn" onClick={handleShare} disabled={sharing}>
              {sharing ? "Sharing…" : "Share"}
            </button>
            <button className="btn secondary" onClick={() => router.push("/payment-links")}>
              Done
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Nav back backHref="/payment-links" />
      <div className="screen pl-create">
        <div className="pl-head">
          <div className="pl-title">New payment link</div>
          <div className="pl-subtitle">Set an amount, share the link or QR, get paid.</div>
        </div>

        {/* CURRENCY. Applies to BOTH link types: a fixed link is priced in it,
            and a counter QR is the currency the customer types their amount in.
            Offered only for currencies the protocol has a live circle for —
            anything else would create a link nobody can pay. Hidden entirely
            when there is only one choice, so the common case stays one tap. */}
        {supported.length > 1 && (
          <div className="pl-card">
            <div className="pl-section-label">Currency</div>
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
                Charged in {linkCurrency}; you are still paid in USDC at the protocol&apos;s
                live rate. Your {registeredCurrency} per-payment limit still applies.
              </div>
            )}
          </div>
        )}

        <div className="pl-card">
          <div className="pl-section-label">Amount</div>
          <div className="seg">
            <button
              type="button"
              className={`seg-opt ${amountMode === "fixed" ? "on" : ""}`}
              onClick={() => {
                setAmountMode("fixed");
                setSingleUse(true);
                setExpiresInDays("7");
              }}
            >
              Fixed amount
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
              Counter QR
            </button>
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
                  placeholder="0.00"
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
            <div className="pl-hint">Customer types in the amount to pay at checkout — handy as a counter QR for walk-in sales.</div>
          )}
        </div>

        <div className="pl-card">
          <div className="pl-section-label">Description</div>
          <input
            className="input"
            type="text"
            maxLength={200}
            placeholder="e.g. Order #482 (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="pl-hint">Encrypted before it's stored — only you can read it.</div>
        </div>

        <div className="pl-card">
          <div className="pl-row-split">
            <div className="pl-field-half">
              <div className="pl-section-label">Uses</div>
              <div className="seg">
                <button
                  type="button"
                  className={`seg-opt ${singleUse ? "on" : ""}`}
                  onClick={() => setSingleUse(true)}
                >
                  Single use
                </button>
                <button
                  type="button"
                  className={`seg-opt ${!singleUse ? "on" : ""}`}
                  onClick={() => setSingleUse(false)}
                >
                  Multi-use
                </button>
              </div>
            </div>
          </div>

          <div className="pl-section-label" style={{ marginTop: 18 }}>Expires</div>
          <div className="chip-row">
            {(["1", "7", "30", ""] as const).map((d) => (
              <button
                key={d || "never"}
                type="button"
                className={`chip ${expiresInDays === d ? "on" : ""}`}
                onClick={() => setExpiresInDays(d)}
              >
                {d === "" ? "Never" : `${d} days`}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="error" style={{ marginTop: 4 }}>{error}</div>}

        <button className="btn pl-submit" disabled={busy} onClick={handleCreate}>
          {busy ? "Creating…" : "Create payment link"}
        </button>
      </div>
    </>
  );
}
