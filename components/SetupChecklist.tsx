"use client";

import Link from "next/link";
import { useT } from "../lib/i18n";
import { computeSetup, type SetupSignals, type SetupStepId } from "../lib/setup";
import { SettlementNote } from "./ui/SettlementNote";
import { Icon } from "./Icons";

/**
 * The first-run guide on the dashboard. Replaces "land on an empty dashboard and
 * guess". It shows ONLY what is not done yet, highlights the single next action,
 * puts the settlement period in front of the merchant at the step where it
 * matters, and goes away on its own once everything is complete (or when the
 * merchant dismisses it).
 */
export function SetupChecklist({
  signals, currency, onOpenTour, onDismiss,
}: {
  signals: SetupSignals;
  currency: string | null | undefined;
  onOpenTour: () => void;
  onDismiss: () => void;
}) {
  const { t } = useT();
  const { steps, doneCount, total, next, complete } = computeSetup(signals);

  const action = (id: SetupStepId) => {
    switch (id) {
      case "learn": return <button className="btn small ghost" onClick={onOpenTour}>{t("setup.learn.cta")}</button>;
      case "register": return <Link className="btn small" href="/onboarding">{t("setup.register.cta")}</Link>;
      case "payout": return <Link className="btn small" href="/settings">{t("setup.payout.cta")}</Link>;
      case "first": return (
        <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="btn small" href="/qr">{t("setup.first.qr")}</Link>
          <Link className="btn small ghost" href="/payment-links/create">{t("setup.first.link")}</Link>
        </span>
      );
      case "track": return <Link className="btn small ghost" href="/transactions">{t("setup.track.cta")}</Link>;
    }
  };

  return (
    <section className="setup" aria-labelledby="setup-h">
      <div className="setup-head">
        <div>
          <h2 id="setup-h" className="setup-title">{complete ? t("setup.doneTitle") : t("setup.title")}</h2>
          <div className="muted setup-sub">
            {complete ? t("setup.doneSub") : `${doneCount}/${total} · ${t("setup.sub")}`}
          </div>
        </div>
        <button className="setup-x" onClick={onDismiss} aria-label={t("ui.dismiss")}>
          <Icon.Close width="16" height="16" />
        </button>
      </div>
      <div className="setup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount}>
        <span style={{ width: `${(doneCount / total) * 100}%` }} />
      </div>

      {!complete && (
        <ol className="setup-list">
          {steps.map((s) => {
            const isNext = s.id === next;
            return (
              <li key={s.id} className={`setup-item${s.done ? " done" : ""}${isNext ? " next" : ""}`}>
                <span className="setup-tick" aria-hidden="true">{s.done ? "✓" : ""}</span>
                <div className="setup-body">
                  <div className="setup-name">{t(`setup.${s.id}.title`)}</div>
                  {isNext && (
                    <>
                      <div className="muted setup-desc">{t(`setup.${s.id}.desc`)}</div>
                      {/* Settlement is explained where it belongs: the "how it
                          works" step, with this merchant's REAL period. */}
                      {s.id === "learn" && <SettlementNote currency={currency} variant="card" className="setup-sn" />}
                      <div className="setup-act">{action(s.id)}</div>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
