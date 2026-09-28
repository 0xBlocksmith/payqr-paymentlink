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
const nextConfig = {
  reactStrictMode: true,
  // The app now typechecks clean (npm run typecheck passes), so let the build
  // ENFORCE types — a future bad thirdweb/viem API call fails the build instead
  // of silently shipping. ESLint is still skipped (no lint config wired up).
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
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
  // Baseline security headers on every route. These are the safe, high-value
  // ones that don't risk breaking the wallet/RPC/subgraph connections. A full
  // Content-Security-Policy is intentionally NOT set here yet: this PWA talks to
  // thirdweb, Alchemy RPC, the p2p subgraph, and flag CDNs, and an over-tight
  // connect-src/script-src would silently break wallet init — it needs a tuned,
  // tested policy (ideally nonce-based for the inline theme script). Tracked as
  // a follow-up; clickjacking + sniffing + referrer leakage are covered below.
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
