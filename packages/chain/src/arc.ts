// Arc Testnet chain object + public client factory (CHAIN-02).
// Source: Utter-SPEC.md §6 (Network table), verified live this session against
// https://docs.arc.io/arc/references/connect-to-arc and the live RPC
// (eth_chainId -> 0x4cef52 = 5042002).
import { createPublicClient, defineChain, http } from "viem";

/**
 * The Arc Testnet Viem chain object — the single source of truth for chain id,
 * RPC/WS endpoints, explorer, and the Multicall3 address.
 *
 * IMPORTANT: `nativeCurrency.decimals` is 18 because it describes the NATIVE GAS
 * token (USDC as 18-decimal native value). This number is the GAS lens ONLY and
 * MUST NEVER be reused for ERC-20 USDC amount math — the ERC-20 interface is
 * 6-decimal and that value must be read from `decimals()` at runtime
 * (the decimals trap; see SPEC §6 + `usdc.ts`/`readUsdcBalance`).
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, // native GAS only
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

/**
 * Build a Viem public client bound to Arc Testnet.
 *
 * The RPC URL is overridable so consumers can point at an alternate provider
 * (Blockdaemon/dRPC/QuickNode) via `ARC_RPC_URL` when the public endpoint
 * rate-limits (RESEARCH Pitfall 4). Falls back to the chain's default HTTP RPC.
 */
export function createArcPublicClient(rpcUrl?: string) {
  // Only honor an override that is actually a non-empty string. A blank or
  // whitespace-only ARC_RPC_URL falls back to the chain default rather than
  // silently building a client that fails opaquely at first call.
  const trimmed = rpcUrl?.trim();
  const url = trimmed && trimmed.length > 0 ? trimmed : arcTestnet.rpcUrls.default.http[0];
  return createPublicClient({
    chain: arcTestnet,
    transport: http(url),
  });
}
