import { defineConfig } from "vitest/config";

// Unit tests for the pure and fetch-driven helpers. Everything external (the
// relayer, the subgraph) is stubbed per test, and the settings below are fixed
// test values, so a developer's own .env never changes a result.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Vitest's default is 5 s per test, which is not enough here.
    // routeLinkCircle's tests import lib/customerOrder, and that first import
    // pulls the viem/thirdweb/SDK module graph through the transform pipeline:
    // 1.4 s for the whole file when it runs alone, but 7-13 s for a single
    // test when the suite's files are competing for the same CPU. So the file
    // passed on its own and failed in company — a test that is only ever
    // flaky on a loaded machine, which is to say on CI. Nothing here waits on
    // a network or a timer, so a generous ceiling costs a passing run
    // nothing; it only stops the slow import being read as a failure.
    testTimeout: 30_000,
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
