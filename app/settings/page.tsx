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
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, currencyFromBytes32 } from "../../lib/contract";
import { toUserError, type UserError } from "../../lib/errors";
import { useGuardedSend } from "../../components/useGuardedSend";
import { useCopy } from "../../components/useCopy";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { ErrorPanel } from "../../components/ui/ErrorPanel";
import { LoadingState } from "../../components/ui/LoadingState";
import { SettlementNote } from "../../components/ui/SettlementNote";
import { STATIC_STALE_MS } from "../../lib/cache";
import {
  COUNTRIES, LANGUAGES, VE_BANKS, loadCountry, clearLocalUserData, fmtSymbolCode,
} from "../../lib/countries";
import { useTheme } from "../../components/theme";
import { useAppUpdate } from "../../components/AppUpdate";
import { useT } from "../../lib/i18n";
import { fill } from "../../lib/format";
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
  const copier = useCopy();
  const saver = useGuardedSend();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => { setCountry(loadCountry()); }, []);

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


  // ── Edit profile (shop name + sector) via updateProfile ──
  const [editing, setEditing] = useState(false);
  const [edShop, setEdShop] = useState("");
  const [edSector, setEdSector] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState("");            // validation text (ours)
  const [saveErr, setSaveErr] = useState<UserError | null>(null); // a failed/uncertain save

  function startEdit() {
    setEdShop(shopName); setEdSector(businessSector);
    setProfileMsg(""); setSaveErr(null); setSavedOk(false); setEditing(true);
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
    if (!sendTransaction) return setProfileMsg(t("set.walletConnecting"));
    setSaveErr(null);
    // Guarded: a double tap can't send two updates. The receipt wait has a
    // timeout and an unknown outcome is reported as such (never "failed", never
    // an invitation to press Save again blindly).
    const r = await saver.run(async () => {
      // The payout handle is no longer collected. updateProfile still takes the
      // field, so resend whatever is already stored (empty "0x" when none) — the
      // same empty value registration pushes.
      const encNew = (encPayout && encPayout !== "0x" ? encPayout : "0x") as `0x${string}`;
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI, functionName: "updateProfile",
        args: [encNew, edShop.trim(), stringToHex(edSector.trim(), { size: 32 })],
      });
      const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status === "reverted") throw new Error("updateProfile reverted");
    }, { context: "update-profile", fallbackKey: "set.saveFail", uncertainKey: "err.uncertainProfile", skipStepUp: true });

    if (r.reason === "ok") {
      setEditing(false); setSavedOk(true); refetchInfo();
      setTimeout(() => setSavedOk(false), 5000);
    } else if (r.reason === "error") {
      setSaveErr(r.error);
      if (r.error.uncertain) refetchInfo();
    }
  }

  function pickLang(code) { setLang(code); }
  function copyAddr() {
    if (address) copier.copy(address, "addr");
  }

  // Auth gate: never flash the settings/profile shell for a logged-out deep-link.
  if (!ready || !authenticated) return <Splash />;
  if (!country) return <><Nav back /><div className="screen"><LoadingState label={t("common.loading")} /></div></>;

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
              <label htmlFor="set-shop" className="set-k" style={{ display: "block", marginTop: 6 }}>{t("set.shopName")}</label>
              <input id="set-shop" className="input" value={edShop} autoComplete="organization" onChange={(e) => setEdShop(e.target.value)}
                placeholder={t("set.shopNamePlaceholder")} />
              <label htmlFor="set-sector" className="set-k" style={{ display: "block", marginTop: 10 }}>{t("set.sector")}</label>
              <input id="set-sector" className="input" value={edSector} onChange={(e) => setEdSector(e.target.value)}
                placeholder={t("set.sectorPlaceholder")} maxLength={31} />
              <p className="tiny" style={{ color: "var(--muted)", margin: "8px 0 0" }}>
                {t("set.currencyLocked").replace("{currency}", payCountry.code)}
              </p>
              {profileMsg && <p className="error" role="alert" style={{ marginTop: 6 }}>{profileMsg}</p>}
              <ErrorPanel error={saveErr} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn" style={{ flex: 1 }} disabled={saver.busy || (saveErr?.uncertain ?? false)} onClick={saveProfile}>
                  {saver.busy ? t("set.saving") : t("set.save")}
                </button>
                <button className="btn ghost" style={{ flex: 1 }} disabled={saver.busy}
                  onClick={() => { setEditing(false); setProfileMsg(""); setSaveErr(null); }}>{t("set.cancel")}</button>
              </div>
              {saver.busy && <p className="muted" style={{ textAlign: "center", fontSize: 12.5 }}>{t("ui.stillWorking")}</p>}
            </>
          ) : (
            <>
              {/* Shown in the READ view — where the merchant actually lands after a
                  successful save (it used to be set inside the edit form, which
                  closed in the same moment, so "Saved" was never seen). */}
              {savedOk && <div className="ui-ok" role="status">{t("set.saved")}</div>}
            </>
          )}

          <div className="set-item">
            <span className="set-k">{t("set.wallet")}</span>
            {address ? (
              <button className="set-addr" onClick={copyAddr}>
                {`${address.slice(0, 6)}…${address.slice(-4)}`}
                <span className="set-copy">{copier.copiedKey === "addr" ? `${t("ui.copied")} ✓` : copier.failedKey === "addr" ? t("ui.copyFailed") : "⧉"}</span>
              </button>
            ) : (
              <span className="set-v" style={{ color: "var(--muted)" }}>{t("set.connecting")}</span>
            )}
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

        <button className="btn ghost set-logout" onClick={() => setLogoutOpen(true)}>
          {t("set.logout")}
        </button>
        <ConfirmDialog
          open={logoutOpen}
          title={t("set.logoutTitle")}
          confirmLabel={t("set.logout")}
          onCancel={() => setLogoutOpen(false)}
          onConfirm={() => {
            // Wipe per-merchant local state BEFORE leaving so nothing leaks to the
            // next account on a shared device (relay key, pending sale, prefs).
            clearLocalUserData();
            logout().finally(() => router.replace("/login"));
          }}
        >
          <p>{t("set.logoutBody")}</p>
        </ConfirmDialog>
      </div>
    </>
  );
}
