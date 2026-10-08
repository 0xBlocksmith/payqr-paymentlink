"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "../../components/useAuth";
import { useReadContract, usePublicClient } from "wagmi";
import { encodeFunctionData, stringToHex, hexToString } from "viem";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Splash } from "../../components/Splash";
import { useSmartAccount } from "../../components/useSmartAccount";
import { APP_VERSION } from "../../lib/version";
import { useRelayIdentity } from "../../components/useRelayIdentity";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, friendlyError, currencyFromBytes32 } from "../../lib/contract";
import { encryptPayout, decryptPayout, PAYOUT_PLACEHOLDER } from "../../lib/payoutCrypto";
import { STATIC_STALE_MS } from "../../lib/cache";
import {
  COUNTRIES, LANGUAGES, VE_BANKS, loadCountry, clearLocalUserData, fmtSymbolCode,
} from "../../lib/countries";
import { useTheme } from "../../components/theme";
import { useAppUpdate } from "../../components/AppUpdate";
import { useT } from "../../lib/i18n";
import { EXPLORER_URL } from "../../lib/chain";

const THEMES = [
  { id: "light", labelKey: "set.light", Ico: Icon.Sun },
  { id: "dark", labelKey: "set.dark", Ico: Icon.Moon },
  { id: "system", labelKey: "set.system", Ico: Icon.Help },
];

const SCAN = EXPLORER_URL;

export default function Settings() {
  const router = useRouter();
  const { logout, email } = useAuth();
  const { ready, authenticated } = useMerchant(); // page guard (auth + prefs)
  const { address, sendTransaction } = useSmartAccount(); // same source the account menu uses
  const publicClient = usePublicClient();
  const { theme, setTheme } = useTheme();
  const { updateReady, checking, checkNow, applyUpdate } = useAppUpdate();
  const { t, lang, setLang } = useT();
  // Show a brief "up to date ✓" confirmation after a manual check that finds
  // nothing new (checking flips true→false with no update surfaced).
  const [checkedClean, setCheckedClean] = useState(false);
  const wasChecking = useRef(false);
  useEffect(() => {
    if (wasChecking.current && !checking && !updateReady) {
      setCheckedClean(true);
      const id = setTimeout(() => setCheckedClean(false), 2500);
      return () => clearTimeout(id);
    }
    wasChecking.current = checking;
  }, [checking, updateReady]);
  const [country, setCountry] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setCountry(loadCountry()); }, []);

  const { getIdentity } = useRelayIdentity();
  const { data: info, refetch: refetchInfo } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });
  const encPayout = (info?.[0] as string) || ""; // on-chain ciphertext blob (bytes)
  const shopName = info?.[1] || "";
  // getMerchantInfo[5] — bytes32, decoded for display. Empty for a merchant who
  // registered before the sector existed, which reads as an empty input rather
  // than an error.
  const businessSector = info?.[5] ? hexToString(info[5] as `0x${string}`, { size: 32 }) : "";
  // The payout handle belongs to the REGISTERED (on-chain, immutable) currency —
  // not the freely-switchable UI country above. Validate/label the profile edit
  // against it, or an INR merchant who tapped "Brazil" in the country section
  // would be asked for a "PIX key" and could save a non-UPI handle on-chain.
  const regCode = currencyFromBytes32(info?.[2] as string);
  const payCountry = COUNTRIES.find((c) => c.code === regCode) || country;

  // Decrypt the payout handle client-side for display. null = can't decrypt on
  // this device (different/absent relay key) — the UI then shows a neutral
  // "•••• (saved)" instead of the raw ciphertext.
  const [payoutId, setPayoutId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!encPayout || encPayout === "0x") { if (alive) setPayoutId(null); return; }
      try {
        const id = await getIdentity();
        const plain = await decryptPayout(encPayout, id);
        // The onboarding sentinel round-trips like a real handle — treat it as
        // "not set yet", never display it as the merchant's saved payout ID.
        if (alive) setPayoutId(plain === PAYOUT_PLACEHOLDER ? null : plain);
      } catch { if (alive) setPayoutId(null); }
    })();
    return () => { alive = false; };
  }, [encPayout, getIdentity]);

  // ── Edit profile (shop name + payout handle) via updateProfile ──
  const [editing, setEditing] = useState(false);
  const [edShop, setEdShop] = useState("");
  const [edPayout, setEdPayout] = useState("");
  const [edSector, setEdSector] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState("");

  // Pago Móvil is three fields packed as "phone|Cédula/RIF|bank code".
  const pm = [...edPayout.split("|"), "", "", ""].slice(0, 3);
  function setPm(i: number, v: string) {
    const next = [...pm];
    next[i] = v.replace(/\|/g, "").trim();
    setEdPayout(next.join("|"));
  }
  function startEdit() {
    setEdShop(shopName); setEdPayout(payoutId || ""); setEdSector(businessSector);
    setProfileMsg(""); setEditing(true);
  }
  async function saveProfile() {
    setProfileMsg("");
    if (!edShop.trim()) return setProfileMsg(t("set.errShopName"));
    // 128 BYTES on-chain (FieldTooLong) — see onboarding.
    if (new TextEncoder().encode(edShop.trim()).length > 128) return setProfileMsg(t("set.errShopNameLong"));
    // Sent on every updateProfile, so it must be present or the call reverts —
    // and a merchant who registered before the field existed has none stored.
    if (!edSector.trim()) return setProfileMsg(t("set.errSectorRequired"));
    // bytes32 holds 31 BYTES, not characters — a label with accented or
    // non-Latin characters is longer than it looks.
    if (new TextEncoder().encode(edSector.trim()).length > 31)
      return setProfileMsg(t("set.errSectorLong"));
    if (!edPayout.trim()) return setProfileMsg(t("set.errPayoutRequired").replace("{label}", payCountry.payoutLabel));
    if (payCountry.validatePayout && !payCountry.validatePayout(edPayout.trim())) {
      return setProfileMsg(t("set.errPayoutInvalid").replace("{label}", payCountry.payoutLabel).replace("{example}", payCountry.payoutPlaceholder));
    }
    if (!sendTransaction) return setProfileMsg(t("set.walletConnecting"));
    setSavingProfile(true);
    try {
      // Encrypt the new handle to the merchant's own relay key before it goes
      // on-chain (contract stores opaque `bytes`, never plaintext).
      const identity = await getIdentity();
      const encNew = await encryptPayout(edPayout.trim(), identity);
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI, functionName: "updateProfile",
        args: [encNew, edShop.trim(), stringToHex(edSector.trim(), { size: 32 })],
      });
      const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error(t("set.saveRevert"));
      setProfileMsg(t("set.saved")); setEditing(false); refetchInfo();
    } catch (err) {
      // friendlyError → "Cancelled." on a wallet decline, a plain sentence on a
      // revert — never a raw viem/SDK string.
      setProfileMsg(friendlyError(err, t("set.saveFail")));
    } finally { setSavingProfile(false); }
  }

  function pickLang(code) { setLang(code); }
  function copyAddr() {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  }

  // Auth gate: never flash the settings/profile shell for a logged-out deep-link.
  if (!ready || !authenticated) return <Splash />;
  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p></div></>;

  return (
    <>
      <Nav back />
      <div className="screen">
        <h1 style={{ textAlign: "center", marginBottom: 14 }}>{t("set.title")}</h1>

        {/* profile card */}
        <div className="set-card">
          <div className="set-avatar">{(shopName || email || "M").slice(0, 1).toUpperCase()}</div>
          <div className="set-id">
            <div className="set-shop">{shopName || t("set.yourShop")}</div>
            {email && <div className="set-email">{email}</div>}
          </div>
        </div>

        {/* shop details (on-chain) — editable */}
        <div className="set-group">
          <div className="set-glabel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{t("set.shop")}</span>
            {!editing && (
              <button className="set-edit" onClick={startEdit}>{t("set.edit")}</button>
            )}
          </div>

          {editing ? (
            <>
              <label className="set-k" style={{ display: "block", marginTop: 6 }}>{t("set.shopName")}</label>
              <input className="input" value={edShop} onChange={(e) => setEdShop(e.target.value)}
                placeholder={t("set.shopNamePlaceholder")} />
              <label className="set-k" style={{ display: "block", marginTop: 10 }}>{t("set.sector")}</label>
              <input className="input" value={edSector} onChange={(e) => setEdSector(e.target.value)}
                placeholder={t("set.sectorPlaceholder")} maxLength={31} />
              <label className="set-k" style={{ display: "block", marginTop: 10 }}>{payCountry.payoutLabel}</label>
              {payCountry.code === "VEN" ? (
                <>
                  <input className="input" inputMode="tel" placeholder="Teléfono: 04141234567"
                    value={pm[0]} onChange={(e) => setPm(0, e.target.value)} />
                  <input className="input" style={{ marginTop: 8 }} placeholder="Cédula o RIF: V12345678"
                    value={pm[1]} onChange={(e) => setPm(1, e.target.value)} />
                  <select className="input" style={{ marginTop: 8 }}
                    value={VE_BANKS.some((b) => b.code === pm[2]) ? pm[2] : ""}
                    onChange={(e) => setPm(2, e.target.value)}>
                    <option value="">Banco…</option>
                    {VE_BANKS.map((b) => <option key={b.code} value={b.code}>{b.code} · {b.name}</option>)}
                  </select>
                </>
              ) : (
                <input className="input" value={edPayout} onChange={(e) => setEdPayout(e.target.value)}
                  placeholder={payCountry.payoutPlaceholder} />
              )}
              <p className="tiny" style={{ color: "var(--muted)", margin: "8px 0 0" }}>
                {t("set.currencyLocked").replace("{currency}", payCountry.code)}
              </p>
              {profileMsg && <p className={profileMsg.includes("✓") ? "success" : "error"} style={{ marginTop: 6 }}>{profileMsg}</p>}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn" style={{ flex: 1 }} disabled={savingProfile} onClick={saveProfile}>
                  {savingProfile ? t("set.saving") : t("set.save")}
                </button>
                <button className="btn ghost" style={{ flex: 1 }} disabled={savingProfile}
                  onClick={() => { setEditing(false); setProfileMsg(""); }}>{t("set.cancel")}</button>
              </div>
            </>
          ) : (
            <>
              <div className="set-item">
                <span className="set-k">{t("set.shopName")}</span>
                <span className="set-v">{shopName || "—"}</span>
              </div>
              <div className="set-item">
                <span className="set-k">{payCountry.payoutLabel}</span>
                {/* payoutId is decrypted client-side. A saved blob we can't decrypt
                    on this device shows a neutral "saved" marker, never ciphertext. */}
                <span className="set-v">
                  {payoutId || (encPayout && encPayout !== "0x" ? t("set.payoutSaved") : "—")}
                </span>
              </div>
            </>
          )}

          <div className="set-item">
            <span className="set-k">{t("set.wallet")}</span>
            {address ? (
              <button className="set-addr" onClick={copyAddr}>
                {`${address.slice(0, 6)}…${address.slice(-4)}`}
                <span className="set-copy">{copied ? "copied ✓" : "⧉"}</span>
              </button>
            ) : (
              <span className="set-v" style={{ color: "var(--muted)" }}>{t("set.connecting")}</span>
            )}
          </div>
          {address && (
            <a className="set-link" href={`${SCAN}/address/${address}`} target="_blank" rel="noopener noreferrer">
              {t("set.viewOnScan")}
            </a>
          )}
        </div>

        {/* country — the merchant's registered country only. It is locked on-chain
            at registration, so there is nothing to pick. */}
        <div className="set-group">
          <div className="set-glabel">{t("set.country")}</div>
          <div className="set-row sel" style={{ cursor: "default" }}>
            <span className="set-flag">{payCountry.flag}</span>
            <span className="set-rt">{payCountry.name}<small>{payCountry.fiat} · {fmtSymbolCode(payCountry)}</small></span>
          </div>
        </div>

        {/* language */}
        <div className="set-group">
          <div className="set-glabel">{t("set.language")}</div>
          <div className="lang-row">
            {LANGUAGES.map((l) => (
              <button key={l.code} className={`lang-chip ${lang === l.code ? "sel" : ""}`} onClick={() => pickLang(l.code)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {/* appearance / theme */}
        <div className="set-group">
          <div className="set-glabel">{t("set.appearance")}</div>
          <div className="theme-row" style={{ padding: "4px 0 12px" }}>
            {THEMES.map((opt) => {
              const Ico = opt.Ico;
              return (
                <button key={opt.id} className={`theme-opt ${theme === opt.id ? "sel" : ""}`} onClick={() => setTheme(opt.id)}>
                  <span className="ti"><Ico width="20" height="20" /></span>
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        {/* App / OTA updates */}
        <div className="set-group">
          <div className="set-glabel">{t("set.app")}</div>
          {updateReady ? (
            <button className="set-update-row ready" onClick={applyUpdate}>
              <span className="set-ico"><Icon.Repeat width="18" height="18" /></span>
              <span className="set-update-txt">{t("ota.updateReady")}</span>
              <span className="set-update-cta">{t("ota.refresh")} ↻</span>
            </button>
          ) : (
            <button className="set-update-row" disabled={checking} onClick={checkNow}>
              <span className={`set-ico ${checking ? "spin" : ""}`}><Icon.Repeat width="18" height="18" /></span>
              <span className="set-update-txt">
                {checking ? t("ota.checking") : checkedClean ? t("ota.upToDate") : t("ota.checkUpdates")}
              </span>
              <span className="set-update-ver">{APP_VERSION}</span>
            </button>
          )}
        </div>

        <button
          className="btn ghost set-logout"
          onClick={() => {
            // Wipe per-merchant local state BEFORE leaving so nothing leaks to the
            // next account on a shared device (relay key, pending sale, prefs).
            clearLocalUserData();
            logout().finally(() => router.replace("/login"));
          }}
        >
          {t("set.logout")}
        </button>
        <p className="tiny" style={{ textAlign: "center", color: "var(--muted)", margin: "12px 0 0" }}>
          PayQR {APP_VERSION} · Gas-free · Settles in USDC
        </p>
      </div>

      {/* <Link>, not <a href> — a raw anchor full-reloads the PWA on every tap. */}
      <div className="bottombar">
        <Link className="btn" href="/dashboard" style={{ flex: 1, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Icon.Plus /> {t("common.back")}
        </Link>
      </div>
    </>
  );
}
