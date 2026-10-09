"use client";

import { useCallback } from "react";
import { PaymentHistoryWithSupport } from "@p2pdotme/widgets/support";
import { Nav } from "../../components/Nav";
import { useSmartAccount } from "../../components/useSmartAccount";
import { useCheckoutSigner } from "../../components/useCheckoutSigner";
import { useSupportSigner } from "../../components/OrderDisputeManager";
import { useMerchantProxies } from "../../components/useMerchantProxies";
import { ALL_CONTRACT_ADDRESSES } from "../../lib/contract";
import { useT } from "../../lib/i18n";
import { ACTIVE_CHAIN, RPC_URL } from "../../lib/chain";
import { DIAMOND_ADDRESS, SUBGRAPH_URL, SUPPORT_BRIDGE_URL, SUPPORT_ORIGIN_APP, USDC_ADDRESS } from "../../lib/p2p";

// The library's own history-with-support widget — no custom dispute UI.
export default function Disputes() {
  const { t } = useT();
  const { ready, address } = useSmartAccount();
  const { signer } = useCheckoutSigner();
  const supportSigner = useSupportSigner();
  // Payment-link sales are recorded under the merchant's PROXY on each PayQR
  // integrator, not the smart account, so the widget must also load those.
  const { proxies } = useMerchantProxies(address as `0x${string}` | undefined);
  const resolveExtraAddresses = useCallback(
    async () => (proxies ?? []) as `0x${string}`[],
    [proxies]
  );

  return (
    <>
      <Nav back />
      <div className="screen">
        <h1 style={{ textAlign: "center", marginBottom: 14 }}>{t("nav.disputes")}</h1>
        {!ready || !signer || !supportSigner || !proxies ? (
          <p className="muted" style={{ textAlign: "center" }}>Loading…</p>
        ) : !SUPPORT_BRIDGE_URL ? (
          <p className="muted" style={{ textAlign: "center" }}>Support isn’t available yet.</p>
        ) : (
          <PaymentHistoryWithSupport
            signer={signer}
            subgraphUrl={SUBGRAPH_URL}
            usdcAddress={USDC_ADDRESS as `0x${string}`}
            chainId={ACTIVE_CHAIN.id}
            diamondAddress={(DIAMOND_ADDRESS || undefined) as `0x${string}` | undefined}
            rpcUrl={RPC_URL || undefined}
            filter="all"
            limit={100}
            integrators={ALL_CONTRACT_ADDRESSES}
            resolveExtraAddresses={resolveExtraAddresses}
            support={{
              signer: supportSigner,
              txSigner: signer,
              originApp: SUPPORT_ORIGIN_APP,
              bridgeUrl: SUPPORT_BRIDGE_URL,
              diamondAddress: (DIAMOND_ADDRESS || undefined) as `0x${string}` | undefined,
              rpcUrl: RPC_URL || undefined,
              chainId: ACTIVE_CHAIN.id,
              chatEnabled: true,
            }}
          />
        )}
      </div>
    </>
  );
}
