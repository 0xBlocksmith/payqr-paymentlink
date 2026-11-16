"use client";

import { usePathname } from "next/navigation";

/** Re-mounted on every navigation, so each screen eases in. Opacity + a small
 *  rise only, and no fill-mode: once finished no transform is left on the
 *  wrapper (a lingering transform would trap position:fixed sheets/modals). */
export default function Template({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return <div key={path} className="page-in">{children}</div>;
}
