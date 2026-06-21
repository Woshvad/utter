// AddArcTestnet.tsx - the one-click "Add Arc Testnet" control (STU-06, D-STU-06).
//
// chainId + nativeCurrency/rpc/explorer metadata come ONLY from the arcTestnet chain
// object in @utter/chain - there is NO 5042002 literal and NO decimals literal in the
// render path (T-06-DECIMALS). The primary path is wagmi's useSwitchChain, which
// prompts wallet_addEthereumChain for an unknown chain using the chain object's
// metadata; the raw wallet_addEthereumChain request is the fallback (06-RESEARCH Open
// Question 2 / Assumption A4) for connectors whose switchChain does not auto-add.
//
// The hex chainId for the raw EIP-3085 request is derived from arcTestnet.id via
// toHex (a numeric -> 0x conversion), NOT a hand-written 0x4cef52 literal - the id
// still flows from the single chain source.
import * as React from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { arcTestnet } from "@utter/chain";

/** A minimal EIP-1193 provider surface (request). */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Build the EIP-3085 wallet_addEthereumChain param from the arcTestnet object. */
function buildAddChainParam(): Record<string, unknown> {
  // chainId as hex, derived from the chain object's numeric id (not a literal).
  const chainIdHex = `0x${arcTestnet.id.toString(16)}`;
  return {
    chainId: chainIdHex,
    chainName: arcTestnet.name,
    nativeCurrency: {
      name: arcTestnet.nativeCurrency.name,
      symbol: arcTestnet.nativeCurrency.symbol,
      // decimals is the chain object's NATIVE-GAS decimals (the chain's own field),
      // sourced from arcTestnet, never a hand-written literal.
      decimals: arcTestnet.nativeCurrency.decimals,
    },
    rpcUrls: [...arcTestnet.rpcUrls.default.http],
    blockExplorerUrls: arcTestnet.blockExplorers
      ? [arcTestnet.blockExplorers.default.url]
      : [],
  };
}

export interface AddArcTestnetProps {
  /**
   * Optional injected provider for the raw fallback (and for tests). When absent the
   * component reads the connector's provider via wagmi at click time.
   */
  provider?: Eip1193Provider;
  /** Optional callback after a successful add/switch (e.g. to refresh balance). */
  onAdded?: () => void;
  className?: string;
}

export function AddArcTestnet({
  provider,
  onAdded,
  className,
}: AddArcTestnetProps): React.ReactElement {
  const { switchChain, isPending } = useSwitchChain();
  const { connector } = useAccount();
  const [error, setError] = React.useState<string | null>(null);

  const onClick = React.useCallback(async () => {
    setError(null);
    try {
      // Primary: wagmi switchChain prompts wallet_addEthereumChain for an unknown
      // chain using the arcTestnet metadata. chainId flows from the chain object.
      await switchChain({ chainId: arcTestnet.id });
      onAdded?.();
    } catch {
      // Fallback: raw EIP-3085 request via the connector/injected provider. Some
      // connectors do not auto-add an unknown chain on switch.
      try {
        const prov =
          provider ?? ((await connector?.getProvider?.()) as Eip1193Provider | undefined);
        if (!prov) throw new Error("no wallet provider");
        await prov.request({
          method: "wallet_addEthereumChain",
          params: [buildAddChainParam()],
        });
        onAdded?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not add arc testnet");
      }
    }
  }, [switchChain, connector, provider, onAdded]);

  return (
    <div className={className}>
      <button
        type="button"
        data-testid="add-arc-testnet"
        onClick={() => void onClick()}
        disabled={isPending}
        className="inline-flex items-center gap-xs border border-blue px-md py-xs text-label font-display font-semibold text-blue outline-none focus-visible:ring-2 focus-visible:ring-blue lowercase disabled:opacity-50"
      >
        add arc testnet
      </button>
      {error ? (
        <span data-testid="add-arc-error" role="alert" className="ml-xs text-caption-mono font-mono text-red">
          {error}
        </span>
      ) : null}
    </div>
  );
}
