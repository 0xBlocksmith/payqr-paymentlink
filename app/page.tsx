"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../components/useAuth";
import { prefsSet } from "../lib/countries";
import { Splash } from "../components/Splash";

/**
 * Routing gate:
 *   not authenticated   -> /login
 *   no prefs yet        -> /login (currency+language are chosen there)
 *   else                -> /dashboard
 *
 * Currency + language are picked on the login page itself, so there's no
 * separate /select step. Registration is requested lazily: an unregistered
 * account is sent to /onboarding when it taps "Accept Payment" on the dashboard.
 *
 * (A "new account → /onboarding right after login" redirect was tried and is
 * switched off for now; the gate below is the original behaviour.)
 */
export default function Home() {
  const router = useRouter();
  const { ready, authenticated } = useAuth();

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) { router.replace("/login"); return; }
    if (!prefsSet()) { router.replace("/login"); return; }
    router.replace("/dashboard");
  }, [ready, authenticated, router]);

  return <Splash />;
}
