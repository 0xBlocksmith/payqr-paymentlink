"use client";

import { useEffect, useState, createContext, useContext } from "react";

const KEY = "payqr.theme"; // "light" | "dark" | "system"
// Light is the default look. A user's explicit dark/system choice is saved
// to localStorage and still wins.
const DEFAULT = "light";

type ThemeValue = {
  theme: string;
  resolved: string;
  setTheme: (t: string) => void;
};
const ThemeCtx = createContext<ThemeValue>({
  theme: DEFAULT,
  resolved: DEFAULT,
  setTheme: () => {},
});

function systemPrefersDark() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

// Status bar (theme-color) matches the app's own resolved theme, not the OS's.
const BG_LIGHT = "#ffffff";
const BG_DARK = "#0a0e16";

// A page with its own full-bleed background (login, onboarding) can ask the
// system bars to match it, per theme: `top` is the status-bar colour, `bottom`
// the colour behind the gesture / navigation bar (the <html> background).
type Chrome = { top: { light: string; dark: string }; bottom: { light: string; dark: string } };
let chrome: Chrome | null = null;

function setThemeColorMeta(resolved) {
  if (typeof document === "undefined") return;
  const dark = resolved === "dark";
  const root = document.documentElement;
  if (chrome) root.style.backgroundColor = dark ? chrome.bottom.dark : chrome.bottom.light;
  else root.style.removeProperty("background-color");
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", chrome ? (dark ? chrome.top.dark : chrome.top.light) : dark ? BG_DARK : BG_LIGHT);
}

function apply(resolved) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
  setThemeColorMeta(resolved);
}

/** Inline script (runs before paint) to set the theme and avoid a flash. */
export const themeInitScript = `
(function(){try{
  var t = localStorage.getItem('${KEY}') || '${DEFAULT}';
  var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var resolved = dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolved);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', resolved === 'dark' ? '${BG_DARK}' : '${BG_LIGHT}');
}catch(e){}})();
`;

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(DEFAULT);
  const [resolved, setResolved] = useState(DEFAULT);
  const [loaded, setLoaded] = useState(false);

  // Load saved preference on mount.
  useEffect(() => {
    let saved = DEFAULT;
    try { saved = localStorage.getItem(KEY) || DEFAULT; } catch {}
    setThemeState(saved);
    setLoaded(true);
  }, []);

  // Resolve + apply whenever theme (or system pref) changes.
  useEffect(() => {
    // Until the saved choice is read, `theme` is just the default — applying it
    // would flash the status bar / theme-color to light before dark takes over.
    if (!loaded) return;
    const compute = () => {
      const r = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
      setResolved(r);
      apply(r);
    };
    compute();
    if (theme === "system" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener?.("change", compute);
      return () => mq.removeEventListener?.("change", compute);
    }
  }, [theme, loaded]);

  function setTheme(t) {
    setThemeState(t);
    try { localStorage.setItem(KEY, t); } catch {}
  }

  return (
    <ThemeCtx.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeCtx.Provider>
  );
}

/** Make the status bar and the bottom gesture bar follow THIS page's background
 *  (and the current theme) while it is mounted; restored on leave. */
export function usePageChrome(c: Chrome) {
  const { resolved } = useTheme();
  useEffect(() => {
    chrome = c;
    setThemeColorMeta(resolved);
    return () => { chrome = null; setThemeColorMeta(resolved); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);
}

export function useTheme() {
  return useContext(ThemeCtx);
}
