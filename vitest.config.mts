import { defineConfig } from "vitest/config";

// Unit tests for the pure and fetch-driven helpers. Everything external (the
// relayer, the subgraph) is stubbed per test, and the settings below are fixed
// test values, so a developer's own .env never changes a result.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    env: {
      NEXT_PUBLIC_CHAIN: "baseSepolia",
      NEXT_PUBLIC_RELAYER_WORKER_URL: "https://relayer.test/",
      NEXT_PUBLIC_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
      NEXT_PUBLIC_LINK_ROUTER_ADDRESS: "0x2222222222222222222222222222222222222222",
      NEXT_PUBLIC_SUBGRAPH_URL: "https://subgraph.test/graphql",
      NEXT_PUBLIC_PREV_CONTRACT_ADDRESSES: "",
      NEXT_PUBLIC_PREV_CONTRACT_ADDRESS: "",
    },
  },
});
