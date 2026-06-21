// config.ts - the wagmi v2 config for Utter Studio (STU-06), per 06-RESEARCH Pattern 2.
//
// The chain is the SINGLE arcTestnet object from @utter/chain - there is NO second
// chain definition and NO 5042002 / decimals literal here; arcTestnet.id IS the
// chain id. wagmi resolves the workspace viem 2.52.2 (the single-pin invariant);
// viem stays a type-only devDep so no second copy is introduced (T-06-VIEM).
//
// `ssr: true` is load-bearing: RR v7 renders the shell on the server, so without it
// the wallet hooks would hydrate with a different value than the server rendered and
// React would warn / flash (Pitfall 6 / T-06-HYDRATION). The mounted-guard in the
// wallet UI is the second half of that mitigation.
import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "@utter/chain";

/**
 * The wagmi config on the existing arcTestnet chain. The injected connector covers
 * the browser-wallet (EIP-1193) case; the transport is the chain's default HTTP RPC
 * (overridable upstream via @utter/chain's ARC_RPC_URL handling at the public-client
 * layer - the wallet write path uses the wallet's own provider).
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: { [arcTestnet.id]: http() },
  ssr: true,
});

export type WagmiConfig = typeof wagmiConfig;
