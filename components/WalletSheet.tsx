"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useReadContract, useBalance } from "wagmi";
import { useActiveWallet } from "thirdweb/react";
import { Insight } from "thirdweb";
import { thirdwebClient, THIRDWEB_CHAIN } from "../lib/thirdweb";
import { QRCodeSVG } from "qrcode.react";
import { encodeFunctionData, parseUnits } from "viem";
import { Icon } from "./Icons";
import { useT } from "../lib/i18n";
import { useSmartAccount } from "./useSmartAccount";
import { useAuth } from "./useAuth";

// Heavy @walletconnect deps — only pulled in when the merchant opens the panel.
const WalletConnectPanel = dynamic(
  () => import("./WalletConnectPanel").then((m) => m.WalletConnectPanel),
  { ssr: false, loading: () => <p className="muted" style={{ textAlign: "center", padding: "24px 0" }}>Loading…</p> }
);
import { CONTRACT_ADDRESS, fmtUsdc, friendlyError } from "../lib/contract";
import { STATIC_STALE_MS } from "../lib/cache";
import { fmtFiat, clearLocalUserData } from "../lib/countries";
import { ACTIVE_CHAIN } from "../lib/chain";

const USDC = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "") as `0x${string}`;
const ERC20_TRANSFER = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;
const ERC20_BALANCE = [{
  type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }],
  outputs: [{ type: "uint256" }],
}] as const;

// Matches the deployed v12 contract: getMerchantInfo returns 5 values
// (encPayoutId, shopName, currency, isRegistered, isFrozen). Index 0 is now the
// ENCRYPTED payout blob (bytes) — this sheet only reads index 1 (shop name), so
// the payout type just needs to decode correctly and is never displayed raw.
const INFO_ABI = [{
  type: "function", name: "getMerchantInfo", stateMutability: "view",
  inputs: [{ name: "merchant", type: "address" }],
  outputs: [
    { name: "encPayoutId", type: "bytes" }, { name: "shopName", type: "string" },
    { name: "currency", type: "bytes32" },
    { name: "isRegistered", type: "bool" }, { name: "isFrozen", type: "bool" },
  ],
}] as const;
const BAL_ABI = [{
  type: "function", name: "getMerchantBalance", stateMutability: "view",
  inputs: [{ name: "merchant", type: "address" }],
  outputs: [
    { name: "pending", type: "uint256" }, { name: "available", type: "uint256" },
    { name: "totalDeposited", type: "uint256" }, { name: "isFrozen", type: "bool" },
  ],
}] as const;

/**
 * Full wallet bottom-sheet (slides up from the dashboard Wallet tile). A real
 * crypto-wallet UI on the thirdweb smart account:
 *   • Receive — the smart-account address + a scannable QR (we render it)
 *   • Send    — a form → routed through the smart account (gasless)
 *   • Buy     — opens thirdweb Pay (fiat→USDC) to fund the account with a card
 * Plus the merchant's on-chain profile (shop, payout, currency) and balance.
 */
export function WalletSheet({
  open, onClose, address, country, rate,
}: {
  open: boolean; onClose: () => void; address?: string; country: any; rate: any;
}) {
  const { t } = useT();
  const router = useRouter();
  const { sendTransaction } = useSmartAccount();
  const { logout } = useAuth();
  const activeWallet = useActiveWallet();
  const [tab, setTab] = useState<"home" | "receive" | "send" | "walletconnect" | "assets">("home");
  const [copied, setCopied] = useState(false);
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INFO_ABI, functionName: "getMerchantInfo",
    args: [address as `0x${string}`], query: { enabled: !!address && open, staleTime: STATIC_STALE_MS },
  });
  const { data: balance } = useReadContract({
    address: CONTRACT_ADDRESS, abi: BAL_ABI, functionName: "getMerchantBalance",
    args: [address as `0x${string}`], query: { enabled: !!address && open, refetchInterval: 20000 },
  });

  // info[0] is the encrypted payout blob — this sheet doesn't display it.
  const shopName = info?.[1] || "";
  const pending = balance?.[0] ?? 0n;
  const available = balance?.[1] ?? 0n;
  const availUsdc = Number(available) / 1e6;
  const availFiat = rate && country ? availUsdc * rate.rate : null;

  // The WALLET's own USDC — what Send can actually move. Distinct from the
  // terminal balance above, which sits INSIDE the integrator contract until
  // withdrawn; a gasless merchant's wallet usually holds ~0, so Send must
  // validate against this, not the headline figure.
  const { data: walletUsdcRaw } = useReadContract({
    address: USDC, abi: ERC20_BALANCE, functionName: "balanceOf",
    args: [address as `0x${string}`],
    query: { enabled: !!address && !!USDC && open, refetchInterval: 20000 },
  });
  const walletUsdc = walletUsdcRaw != null ? Number(walletUsdcRaw) / 1e6 : null;

  // Native ETH on Base (for gas). Read only while the Assets tab is open. Gas is
  // sponsored for merchant txs, so this is usually ~0 — shown for completeness.
  const { data: ethBal } = useBalance({
    address: address as `0x${string}`,
    query: { enabled: !!address && open && tab === "assets", refetchInterval: 30000 },
  });
  const ethAmount = ethBal ? Number(ethBal.value) / 1e18 : 0;

  // ALL ERC-20 tokens actually held on this smart account, discovered via
  // thirdweb Insight (not a hardcoded list) — so airdrops / any token the
  // merchant received show up too, each with its live balance. Fetched only
  // while the Assets tab is open. Native ETH is shown separately below; the
  // "In terminal" USDC is contract-custodied, not an on-address token, so it
  // stays its own row. Failures degrade silently to the known USDC/ETH rows.
  type OwnedTok = {
    tokenAddress: string; symbol: string; name: string;
    decimals: number; value: bigint; displayValue: string;
  };
  const [ownedTokens, setOwnedTokens] = useState<OwnedTok[] | null>(null);
  const [tokensErr, setTokensErr] = useState(false);
  useEffect(() => {
    if (!(open && tab === "assets" && address)) return;
    let cancelled = false;
    setTokensErr(false);
    Insight.getOwnedTokens({
      client: thirdwebClient,
      chains: [THIRDWEB_CHAIN],
      ownerAddress: address,
    })
      .then((toks) => {
        if (cancelled) return;
        // Drop dust / zero balances; sort largest-first by raw value.
        const list = (toks as OwnedTok[])
          .filter((t) => t.value > 0n)
          .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
        setOwnedTokens(list);
      })
      .catch(() => { if (!cancelled) { setTokensErr(true); setOwnedTokens(null); } });
    return () => { cancelled = true; };
  }, [open, tab, address]);

  // Is USDC already covered by the discovered-token list? If so, suppress the
  // static "In wallet" USDC row to avoid showing it twice.
  const usdcInOwned =
    !!ownedTokens && ownedTokens.some((t) => t.tokenAddress?.toLowerCase() === USDC.toLowerCase());

  function copyAddr() {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  }

  function buy() {
    if (!address) return;
    // On-ramp: point at thirdweb Pay (fiat→USDC) prefilled to fund THIS smart
    // account on the active chain. Opens in a new tab; the team can later swap
    // this for an in-app <PayEmbed> if they want a fully embedded flow.
    const chainId = ACTIVE_CHAIN.id;
    const url =
      `https://thirdweb.com/pay` +
      `?chainId=${chainId}` +
      (USDC ? `&tokenAddress=${USDC}` : "") +
      `&recipientAddress=${address}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function send() {
    setMsg("");
    if (!to.startsWith("0x") || to.length !== 42) return setMsg("Enter a valid wallet address.");
    const n = Number(amt);
    if (!(n > 0)) return setMsg("Enter an amount.");
    if (!USDC) return setMsg("USDC address not configured.");
    if (!sendTransaction) return setMsg("Wallet still connecting…");
    setBusy(true);
    try {
      const amount = parseUnits(amt, 6);
      // Send moves the WALLET's USDC. The headline balance lives in the terminal
      // contract — without this check every send against it just reverts with a
      // generic error, which reads as "the app is broken".
      if (walletUsdcRaw != null && amount > walletUsdcRaw) {
        setMsg(
          `Your wallet holds ${fmtUsdc(walletUsdcRaw)} USDC. Sales stay in the terminal until withdrawn — use Withdraw (keep as USDC) first.`
        );
        return;
      }
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER, functionName: "transfer",
        args: [to as `0x${string}`, amount],
      });
      await sendTransaction({ to: USDC, data });
      setMsg("✓ Sent");
      setTo(""); setAmt("");
      setTimeout(() => { setTab("home"); setMsg(""); }, 1200);
    } catch (e: any) {
      // Friendly text, never a raw viem/SDK string; a wallet decline → "Cancelled."
      setMsg(friendlyError(e, "Couldn't send. Please try again."));
    } finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />

        {/* header — avatar + address + "Smart Account" (wallet-app style) */}
        <div className="wsheet-head">
          <div className="wsheet-avatar">{(shopName || "M").slice(0, 1).toUpperCase()}</div>
          <div className="wsheet-id">
            <button className="wsheet-addr" onClick={copyAddr}>
              {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "…"}
              <span className="wsheet-copy">{copied ? "✓" : <Icon.Copy width="13" height="13" />}</span>
            </button>
            <div className="wsheet-type">Smart Account</div>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* HOME tab */}
        {tab === "home" && (
          <>
            {/* balance pill */}
            <div className="wsheet-bal">
              <span className="wsheet-bal-amt">${availUsdc.toFixed(2)}</span>
              <span className="wsheet-bal-sub">
                {availFiat != null ? `≈ ${fmtFiat(country, availFiat)}` : ""}
                {Number(pending) > 0 ? ` · ${fmtUsdc(pending)} ${t("tx.locked")}` : ""}
              </span>
            </div>

            {/* Send · Receive · Buy — outlined buttons like the sample */}
            <div className="wsheet-actions">
              <button className="wact" onClick={() => setTab("send")}>
                <Icon.Up width="18" height="18" /><span>{t("wallet.send")}</span>
              </button>
              <button className="wact primary" onClick={() => setTab("receive")}>
                <Icon.Down width="18" height="18" /><span>{t("wallet.receive")}</span>
              </button>
              <button className="wact" onClick={buy}>
                <Icon.Plus width="18" height="18" /><span>{t("wallet.buy")}</span>
              </button>
            </div>

            {/* network row */}
            <div className="wsheet-net">
              <span className="wnet-dot" />
              <span className="wnet-name">Base</span>
              <span className="wnet-bar" />
            </div>

            {/* menu list */}
            <nav className="wsheet-menu">
              <button className="wmenu-row" onClick={() => { onClose(); router.push("/transactions"); }}>
                <span className="wmenu-ico"><Icon.Repeat width="18" height="18" /></span>
                <span>{t("nav.transactions")}</span><span className="wmenu-car">›</span>
              </button>
              {address && (
                <button className="wmenu-row" onClick={() => setTab("assets")}>
                  <span className="wmenu-ico"><Icon.Wallet width="18" height="18" /></span>
                  <span>{t("wallet.viewAssets")}</span><span className="wmenu-car">›</span>
                </button>
              )}
              <button className="wmenu-row" onClick={() => setTab("walletconnect")}>
                <span className="wmenu-ico"><Icon.Link width="18" height="18" /></span>
                <span>{t("wallet.connectDapp")}</span><span className="wmenu-car">›</span>
              </button>
              <button className="wmenu-row" onClick={() => { onClose(); router.push("/settings"); }}>
                <span className="wmenu-ico"><Icon.Gear width="18" height="18" /></span>
                <span>{t("wallet.manage")}</span><span className="wmenu-car">›</span>
              </button>
              <button className="wmenu-row danger" onClick={() => { onClose(); clearLocalUserData(); logout().finally(() => router.replace("/login")); }}>
                <span className="wmenu-ico"><Icon.Back width="18" height="18" /></span>
                <span>{t("wallet.disconnect")}</span>
              </button>
            </nav>
          </>
        )}

        {/* RECEIVE tab */}
        {tab === "receive" && (
          <div className="wallet-pane">
            <button className="wallet-back" onClick={() => setTab("home")}><Icon.Back width="16" height="16" /> {t("wallet.receive")}</button>
            <div className="wallet-qr">
              {address && <QRCodeSVG value={address} size={172} bgColor="#ffffff" fgColor="#16151f" level="M" />}
            </div>
            <p className="wallet-hint">{t("wallet.receiveHint")}</p>
            <button className="wallet-addr-box" onClick={copyAddr}>
              {address}
              <span className="wa-copy">{copied ? "✓ " + t("wallet.copied") : t("wallet.copy")}</span>
            </button>
          </div>
        )}

        {/* ASSETS tab — in-app token list (no Basescan) */}
        {tab === "assets" && (
          <div className="wallet-pane">
            <button className="wallet-back" onClick={() => setTab("home")}><Icon.Back width="16" height="16" /> {t("wallet.viewAssets")}</button>
            <div className="asset-list">
              {/* ALL ERC-20s held on the smart account, discovered via thirdweb
                  Insight (largest first). Each is a real on-address token. */}
              {ownedTokens?.map((tk) => {
                const amt = Number(tk.displayValue);
                const isUsdc = tk.tokenAddress?.toLowerCase() === USDC.toLowerCase();
                return (
                  <div className="asset-row" key={tk.tokenAddress}>
                    <span className={`asset-badge ${isUsdc ? "usdc" : ""}`}>
                      {isUsdc ? "$" : (tk.symbol || "?").slice(0, 1).toUpperCase()}
                    </span>
                    <div className="asset-mid">
                      <div className="asset-name">{tk.symbol || tk.name || "Token"}</div>
                      <div className="asset-sub">In wallet · Base</div>
                    </div>
                    <div className="asset-right">
                      <div className="asset-amt">
                        {amt.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </div>
                      <div className="asset-fiat">
                        {isUsdc && rate && country ? "≈ " + fmtFiat(country, amt * rate.rate) : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* Quiet discovery hint — only while loading and nothing yet shown. */}
              {ownedTokens === null && !tokensErr && (
                <div className="asset-note">{t("wallet.loadingTokens") || "Loading tokens…"}</div>
              )}
              {/* Fallback USDC row: only when the token API hasn't (yet) returned
                  a USDC entry — keeps the wallet's spendable USDC visible even if
                  Insight is loading or errored. */}
              {!usdcInOwned && (
                <div className="asset-row">
                  <span className="asset-badge usdc">$</span>
                  <div className="asset-mid">
                    <div className="asset-name">USDC</div>
                    <div className="asset-sub">In wallet · Base</div>
                  </div>
                  <div className="asset-right">
                    <div className="asset-amt">{(walletUsdc ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                    <div className="asset-fiat">
                      {rate && country && walletUsdc != null ? "≈ " + fmtFiat(country, walletUsdc * rate.rate) : ""}
                    </div>
                  </div>
                </div>
              )}
              {/* Sales balance held by the terminal contract until withdrawn */}
              <div className="asset-row">
                <span className="asset-badge usdc">$</span>
                <div className="asset-mid">
                  <div className="asset-name">USDC</div>
                  <div className="asset-sub">In terminal · withdraw to move</div>
                </div>
                <div className="asset-right">
                  <div className="asset-amt">{availUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                  <div className="asset-fiat">
                    {availFiat != null ? "≈ " + fmtFiat(country, availFiat) : ""}
                  </div>
                </div>
              </div>
              {pending > 0n && (
                <div className="asset-note">
                  {fmtUsdc(pending)} USDC {t("wallet.pendingSettle") || "still settling"}
                </div>
              )}
              {/* Native ETH (gas) */}
              <div className="asset-row">
                <span className="asset-badge eth">Ξ</span>
                <div className="asset-mid">
                  <div className="asset-name">ETH</div>
                  <div className="asset-sub">{t("wallet.forGas") || "Network gas · Base"}</div>
                </div>
                <div className="asset-right">
                  <div className="asset-amt">{ethAmount.toLocaleString(undefined, { maximumFractionDigits: 5 })}</div>
                  <div className="asset-fiat">{ethAmount === 0 ? (t("wallet.gasSponsored") || "sponsored") : ""}</div>
                </div>
              </div>
            </div>
            <button className="wallet-addr-box" onClick={copyAddr} style={{ marginTop: 16 }}>
              {address}
              <span className="wa-copy">{copied ? "✓ " + t("wallet.copied") : t("wallet.copy")}</span>
            </button>
          </div>
        )}

        {/* SEND tab */}
        {tab === "send" && (
          <div className="wallet-pane">
            <button className="wallet-back" onClick={() => setTab("home")}><Icon.Back width="16" height="16" /> {t("wallet.send")} USDC</button>
            <label className="wallet-label">{t("wallet.toAddress")}</label>
            <input className="input" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
            <p className="wallet-hint" style={{ marginTop: 6 }}>{t("wallet.sendNetworkWarning")}</p>
            <label className="wallet-label" style={{ marginTop: 12 }}>{t("wallet.amount")} (USDC)</label>
            <input className="input" type="number" min="0" step="0.01" placeholder="0.00"
              value={amt} onChange={(e) => setAmt(e.target.value)} />
            {/* What Send can actually spend (the wallet's own USDC) vs the sales
                balance still inside the terminal — the #1 source of failed sends. */}
            <p className="muted tiny" style={{ margin: "8px 0 0", textAlign: "center" }}>
              In wallet: {walletUsdc != null ? walletUsdc.toFixed(2) : "…"} USDC
              {available > 0n ? ` · In terminal (withdraw first): ${fmtUsdc(available)} USDC` : ""}
            </p>
            {msg && <p className={msg.startsWith("✓") ? "success" : "error"} style={{ textAlign: "center" }}>{msg}</p>}
            <button className="btn" style={{ width: "100%", marginTop: 14 }} disabled={busy} onClick={send}>
              {busy ? t("wd.working") : `${t("wallet.send")} USDC`}
            </button>
          </div>
        )}

        {/* CONNECT TO A DAPP tab (WalletConnect) */}
        {tab === "walletconnect" && (
          <WalletConnectPanel wallet={activeWallet} onBack={() => setTab("home")} />
        )}
      </div>
    </div>
  );
}
