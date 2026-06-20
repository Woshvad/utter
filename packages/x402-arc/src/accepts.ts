// buildAccepts - the 402 `accepts` body builder (PAY-01, RESEARCH Code Ex §1).
//
// Pins x402Version:2 and the CAIP-2 network `eip155:5042002` everywhere. The
// escrow entry is Utter's custom `utter-escrow` scheme (a documented v2 superset)
// carrying the SPEC field names: `maxAmountRequired` (the signed cap), `pricing`,
// and `extra.eip712` (the LOCKED UtterEscrow/1 domain). An optional `exact` entry
// conforms to standard x402 v2 (`amount`/`payTo`/`extra:{name,version}`) so a
// generic x402 client can pay the flat path. All addresses (USDC, PAYMENT_ESCROW)
// are imported from @utter/chain - never re-literal'd here.
import type { Hex } from "viem";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";

/** The pinned x402 wire version (Open Question 1: v2 + CAIP-2 everywhere). */
export const X402_VERSION = 2 as const;

/** Arc Testnet as a CAIP-2 network identifier (chainId 5042002). */
export const ARC_CAIP2_NETWORK = "eip155:5042002" as const;

/** The LOCKED escrow EIP-712 domain (matches PaymentEscrow.sol byte-for-byte). */
export const ESCROW_EIP712_DOMAIN = {
  name: "UtterEscrow",
  version: "1",
  chainId: 5042002,
  verifyingContract: PAYMENT_ESCROW,
} as const;

/** The confirmed Arc USDC EIP-3009 domain name/version (for the exact entry). */
export const USDC_EIP712_DOMAIN = {
  name: "USDC",
  version: "2",
} as const;

/** Per-resource metered pricing. Terms are decimal strings in USDC base units. */
export interface Pricing {
  /** Pricing model discriminator. Metered is the escrow path. */
  model: "metered";
  /** Flat base charge per call (base units, decimal string). */
  base: string;
  /** Per-KiB size charge (base units, decimal string). */
  perKB: string;
  /** Per-compute-unit charge; 1 unit = 100ms wall-clock (base units, decimal string). */
  computeMultiplier: string;
  /** Optional MAX_RESPONSE_BYTES cap on the size term (bytes). */
  maxResponseBytes?: number;
  /**
   * Optional flat charge for a declared (bad-buyer-input) error under the `priced`
   * error policy (base units, decimal string). The gate charges
   * `min(errorPrice, cap)` - NEVER the full cap. Absent or "0" means a priced
   * declared error is FREE (release, no debit). The signed cap is the hard ceiling.
   */
  errorPrice?: string;
}

/** The locked EIP-712 domain carried in the escrow entry's `extra.eip712`. */
export interface EscrowEip712 {
  name: "UtterEscrow";
  version: "1";
  chainId: 5042002;
  verifyingContract: Hex;
}

/** A single advertised payment option in the 402 body. */
export interface AcceptsEntry {
  /** Payment scheme: the custom `utter-escrow` or standard `exact`. */
  scheme: "utter-escrow" | "exact";
  /** CAIP-2 network. */
  network: typeof ARC_CAIP2_NETWORK;
  /** The settlement asset (USDC). */
  asset: Hex;
  /** The escrow contract (escrow scheme only). */
  escrow?: Hex;
  /** The signed spend cap, base units string (escrow scheme; SPEC field name). */
  maxAmountRequired?: string;
  /** The flat amount, base units string (exact scheme; standard x402 v2 field). */
  amount?: string;
  /** The recipient: the resourceId (escrow) or the splitter/payee (exact). */
  payTo: Hex;
  /** Max handler runtime the buyer accepts before timeout. */
  maxTimeoutSeconds?: number;
  /** Metered pricing (escrow scheme only). */
  pricing?: Pricing;
  /** Scheme-specific extra. Escrow carries `{eip712}`; exact carries `{name,version}`. */
  extra?: { eip712: EscrowEip712 } | { name: "USDC"; version: "2" };
}

/** The full 402 `Payment Required` body. */
export interface AcceptsBody {
  /** The pinned x402 wire version. */
  x402Version: typeof X402_VERSION;
  /** A human-readable reason the request was challenged. */
  error: string;
  /** The advertised payment options (escrow first; optional exact fallback). */
  accepts: AcceptsEntry[];
}

/** Options for the optional standard-x402-v2 `exact` fallback entry. */
export interface ExactOption {
  /** The flat amount in USDC base units (bigint). */
  amount: bigint;
  /** The payee (e.g. the PaymentSplitter or creator). */
  payTo: Hex;
}

/** Options for {@link buildAccepts}. */
export interface BuildAcceptsOpts {
  /** The signed spend cap in USDC base units (bigint). */
  cap: bigint;
  /** The per-resource metered pricing. */
  pricing: Pricing;
  /** The resource being charged (bytes32 Hex) - the escrow `payTo`. */
  resourceId: Hex;
  /** Max handler runtime the buyer accepts (seconds). */
  maxTimeoutSeconds: number;
  /** A human-readable challenge reason. */
  error?: string;
  /** When provided, append a standard-x402-v2 `exact` fallback entry. */
  exact?: ExactOption;
}

/**
 * Build the 402 `accepts` body advertising the escrow scheme (and, optionally,
 * the standard `exact` flat fallback).
 */
export function buildAccepts(opts: BuildAcceptsOpts): AcceptsBody {
  const escrowEntry: AcceptsEntry = {
    scheme: "utter-escrow",
    network: ARC_CAIP2_NETWORK,
    maxAmountRequired: opts.cap.toString(),
    asset: USDC,
    escrow: PAYMENT_ESCROW,
    payTo: opts.resourceId,
    maxTimeoutSeconds: opts.maxTimeoutSeconds,
    pricing: opts.pricing,
    extra: { eip712: { ...ESCROW_EIP712_DOMAIN } },
  };

  const accepts: AcceptsEntry[] = [escrowEntry];

  if (opts.exact) {
    accepts.push({
      scheme: "exact",
      network: ARC_CAIP2_NETWORK,
      asset: USDC,
      amount: opts.exact.amount.toString(),
      payTo: opts.exact.payTo,
      extra: { ...USDC_EIP712_DOMAIN },
    });
  }

  return {
    x402Version: X402_VERSION,
    error: opts.error ?? "X-PAYMENT header is required",
    accepts,
  };
}
