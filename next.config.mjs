import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants.js";

/**
 * Refuse to BUILD (or run dev) with settings that would silently run the app
 * against the wrong chain or the testnet. NEXT_PUBLIC_* values are baked into
 * the bundle at build time, so this is the one moment they can be checked
 * before real users see the result. Not run at `next start`, where the build's
 * values are already fixed and the env may legitimately be absent.
 */
function checkEnv() {
  const env = (k) => (process.env[k] ?? "").trim();
  const problems = [];
  const chain = env("NEXT_PUBLIC_CHAIN");
  if (!["", "base", "baseSepolia"].includes(chain)) {
    problems.push(`NEXT_PUBLIC_CHAIN must be "base" or "baseSepolia" (got "${chain}")`);
  }
  const mainnet = chain === "base";
  const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(v);
  const ADDRESS_VARS = [
    "NEXT_PUBLIC_CONTRACT_ADDRESS",
    "NEXT_PUBLIC_CLIENT_ADDRESS",
    "NEXT_PUBLIC_LINK_ROUTER_ADDRESS",
    "NEXT_PUBLIC_DIAMOND_ADDRESS",
    "NEXT_PUBLIC_USDC_ADDRESS",
    "NEXT_PUBLIC_ACCOUNT_FACTORY",
  ];
  for (const k of ADDRESS_VARS) {
    const v = env(k);
    if (v && !isAddr(v)) problems.push(`${k} is not a 0x address`);
  }
  for (const k of ["NEXT_PUBLIC_PREV_CONTRACT_ADDRESSES", "NEXT_PUBLIC_PREV_CONTRACT_ADDRESS"]) {
    for (const v of env(k).split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!isAddr(v)) problems.push(`${k} contains a non-address: ${v}`);
    }
  }
  for (const k of ["NEXT_PUBLIC_RPC_URL", "NEXT_PUBLIC_SUBGRAPH_URL", "NEXT_PUBLIC_RELAYER_WORKER_URL", "NEXT_PUBLIC_PAY_BASE_URL"]) {
    const v = env(k);
    if (v && !/^https?:\/\//.test(v)) problems.push(`${k} is not an http(s) URL`);
  }
  if (mainnet) {
    for (const k of [
      "NEXT_PUBLIC_THIRDWEB_CLIENT_ID",
      "NEXT_PUBLIC_ACCOUNT_FACTORY",
      "NEXT_PUBLIC_CONTRACT_ADDRESS",
      "NEXT_PUBLIC_CLIENT_ADDRESS",
      "NEXT_PUBLIC_DIAMOND_ADDRESS",
      "NEXT_PUBLIC_USDC_ADDRESS",
      "NEXT_PUBLIC_RPC_URL",
      "NEXT_PUBLIC_SUBGRAPH_URL",
    ]) {
      if (!env(k)) problems.push(`${k} is required on mainnet`);
    }
    // Base mainnet USDC. A leftover testnet token address points at nothing on
    // mainnet, and an ERC-20 transfer to it does not revert — sends would
    // report success while no money moved.
    const usdc = env("NEXT_PUBLIC_USDC_ADDRESS").toLowerCase();
    if (usdc && usdc !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") {
      problems.push("NEXT_PUBLIC_USDC_ADDRESS must be Base mainnet USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    }
    if (/sepolia/i.test(env("NEXT_PUBLIC_RPC_URL"))) problems.push("NEXT_PUBLIC_RPC_URL looks like a Sepolia RPC");
    if (env("NEXT_PUBLIC_SUBGRAPH_URL").includes("/1745491/event-indexer/v0.0.6")) {
      problems.push("NEXT_PUBLIC_SUBGRAPH_URL is the testnet subgraph");
    }
    // Known Base Sepolia deployments. None of them exists on mainnet.
    const TESTNET = [
      "0x4c4223dd", "0xd273e0de", "0x8991b470", "0xeb0bb8e3", "0x4095fe4f",
      "0x2edcf5e9", "0x10a08aa7", "0x916ad638", "0xc6d71e75", "0x911942e2", "0xf865c81b",
    ];
    for (const k of [...ADDRESS_VARS, "NEXT_PUBLIC_PREV_CONTRACT_ADDRESSES", "NEXT_PUBLIC_PREV_CONTRACT_ADDRESS"]) {
      const v = env(k).toLowerCase();
      if (TESTNET.some((t) => v.includes(t))) problems.push(`${k} contains a Base Sepolia (testnet) address`);
    }
  }
  if (problems.length) {
    throw new Error(`Refusing to build PayQR — fix these settings:\n  - ${problems.join("\n  - ")}`);
  }
}

/** @type {import('next').NextConfig} */
/** The origin of a configured service URL, or "" when unset or malformed. */
function originOf(url) {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

/** Where report-only violations are POSTed — app/api/csp-report/route.ts. */
const CSP_REPORT_PATH = "/api/csp-report";

/** The full policy, from this deployment's own services (see headers()). */
function reportOnlyCsp() {
  const services = [
    process.env.NEXT_PUBLIC_RELAYER_WORKER_URL,
    process.env.NEXT_PUBLIC_RPC_URL,
    process.env.NEXT_PUBLIC_SUBGRAPH_URL,
    process.env.NEXT_PUBLIC_FRAUD_ENGINE_API_URL,
    process.env.NEXT_PUBLIC_SUPPORT_BRIDGE_URL,
  ]
    .map(originOf)
    .filter(Boolean);
  const ecosystem = originOf(process.env.NEXT_PUBLIC_ECOSYSTEM_URL) || "https://p2p.store";
  const connect = [
    "'self'",
    ...services,
    "https://*.thirdweb.com",
    "wss://*.thirdweb.com",
    "https://*.walletconnect.com",
    "wss://*.walletconnect.com",
    "https://*.walletconnect.org",
    "wss://*.walletconnect.org",
    "https://*.seon.io",
    "https://*.fpjs.io",
    "https://*.base.org",
  ];
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://*.thirdweb.com https://*.seon.io",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    "img-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `frame-src 'self' https://*.thirdweb.com ${ecosystem}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Report-only is worth nothing if the reports only reach a console nobody
    // has open (review item 5). report-uri is what Chrome and Safari still
    // send today; report-to is the Reporting API successor, named by the
    // Reporting-Endpoints header below. Both named, so neither browser is
    // silent.
    `report-uri ${CSP_REPORT_PATH}`,
    "report-to csp-endpoint",
  ].join("; ");
}

const nextConfig = {
  reactStrictMode: true,
  // The app now typechecks clean (npm run typecheck passes), so let the build
  // ENFORCE types — a future bad thirdweb/viem API call fails the build instead
  // of silently shipping. ESLint is still skipped (no lint config wired up).
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // The app uses no next/image, but Next.js still serves its image optimizer at
  // /_next/image — and on 14.x that endpoint carries open advisories, two of
  // them critical (remote code execution with AVIF, denial of service), fixed
  // only in 15.5.x. Turning optimization off takes the endpoint out of play
  // with no visible change. Revisit on the Next 15 upgrade.
  images: { unoptimized: true },
  // Tree-shake barrel imports from the heavy wallet/UI deps so a page only pulls
  // the icons/helpers it actually uses instead of the whole package — cuts the
  // dev cold-compile module count and shrinks the production first-load bundle.
  experimental: {
    optimizePackageImports: [
      "thirdweb",
      "wagmi",
      "viem",
      "@tanstack/react-query",
      "qrcode.react",
    ],
  },
  // Baseline security headers on every route.
  //
  // CONTENT SECURITY POLICY, IN TWO PARTS (review M7). Customer and merchant
  // signing keys live in localStorage on this origin, so a policy that limits
  // where script may send data matters. But this app talks to thirdweb, the RPC,
  // the relayer, the subgraph, the fraud engine (with SEON and fingerprinting)
  // and WalletConnect, and an over-tight connect-src or script-src silently
  // breaks wallet login or a payment. So:
  //   • ENFORCED: only the directives that cannot break a flow — no plugins, no
  //     framing by other sites, no foreign <base>, forms post only here.
  //   • REPORT-ONLY: the full policy, built from this deployment's own
  //     services. Browsers log what it WOULD block, without blocking, and now
  //     also POST each violation to /api/csp-report so the deployment's logs
  //     show what real customer traffic hits. Run a full flow (login, create a
  //     link, pay, withdraw), read the reports, add any host they name, then
  //     move the policy to Content-Security-Policy.
  //
  // script-src still allows 'unsafe-inline', and that is the one directive
  // this cannot tighten from here: Next.js inlines its own bootstrap and flight
  // data on every page, so dropping it needs per-request nonces from
  // middleware (with 'strict-dynamic' for thirdweb's and SEON's loaders) —
  // a change that must be made and flow-tested on its own, not folded into
  // this one. Left as a follow-up, as the review has it.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
          },
          { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp() },
          // Names the group `report-to` above points at.
          { key: "Reporting-Endpoints", value: `csp-endpoint="${CSP_REPORT_PATH}"` },
        ],
      },
    ];
  },
  webpack: (config) => {
    // Stub optional deps that transitive wallet libs (wagmi/walletconnect/pino)
    // reference only in code paths this app never hits — so the browser build
    // doesn't emit "Module not found" noise for them.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
      // pino (via walletconnect, pulled in by thirdweb) optionally requires
      // pino-pretty for pretty-printing; it's dev-only logging we never use.
      "pino-pretty": false,
    };
    return config;
  },
};

export default function config(phase) {
  if (phase === PHASE_PRODUCTION_BUILD || phase === PHASE_DEVELOPMENT_SERVER) checkEnv();
  return nextConfig;
}
