import type { Metadata } from "next";

// The page itself is a client component, so its metadata lives here. It is the
// same for every link on purpose: a link's shop and amount are read from the
// chain in the browser, and a share preview must not depend on (or leak) them.
const SITE = (process.env.NEXT_PUBLIC_PAY_BASE_URL || "https://app.payqr.pro").replace(/\/$/, "");

const TITLE = "Pay securely with PayQR";
const DESCRIPTION = "A peer-to-peer (P2P) payment link, powered by PayQR and p2p.me.";
const IMAGE = "/og-payment-link.png";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "PayQR",
  // A payment link is for whoever it was sent to, not for search results.
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    siteName: "PayQR",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: IMAGE, width: 1200, height: 630, alt: "PayQR payment link" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [IMAGE],
  },
};

export default function PayLayout({ children }: { children: React.ReactNode }) {
  return children;
}
