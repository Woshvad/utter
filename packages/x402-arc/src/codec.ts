// PaymentPayload base64 codec (Pitfall 5 x402 v2 wire; ASVS V5 input validation).
//
// encodePayment(payload) -> JSON -> base64 string (the X-PAYMENT header value).
// decodePayment(header)  -> base64 decode -> JSON.parse -> VALIDATE every field
// (buyer is an address, resourceId/nonce are bytes32, maxAmount/validBefore are
// non-negative uint strings) BEFORE returning. Malformed base64/JSON or an
// out-of-bounds value THROWS - the decoder never returns a partial/coerced object
// (the X-PAYMENT payload is untrusted input crossing into the gate).
import { isAddress, type Hex } from "viem";

/** Arc Testnet CAIP-2 network id (chainId 5042002) - the only network we accept. */
const ARC_CAIP2_NETWORK = "eip155:5042002";

/** The payment schemes the codec accepts (escrow primary; exact flat fallback). */
const ACCEPTED_SCHEMES = new Set(["utter-escrow", "exact"]);

/** The buyer's signed DebitAuthorization message, as carried on the wire. */
export interface DebitAuthorizationMessage {
  /** The buyer (EIP-712 signer). */
  buyer: Hex;
  /** The resource being charged (bytes32). */
  resourceId: Hex;
  /** The signed spend cap, base units (decimal string - bigint on the wire). */
  maxAmount: string;
  /** The single-use replay nonce (bytes32) = the idemKey. */
  nonce: Hex;
  /** Unix-seconds expiry (decimal string). */
  validBefore: string;
}

/** The full payment payload base64-encoded into the X-PAYMENT header. */
export interface PaymentPayload {
  /** The pinned x402 wire version. */
  x402Version: number;
  /** The payment scheme. */
  scheme: string;
  /** The CAIP-2 network. */
  network: string;
  /** The buyer's signed authorization message. */
  authorization: DebitAuthorizationMessage;
  /** The EIP-712 signature over `authorization` (0x-hex). */
  signature: Hex;
}

/** True if `v` is a 0x-prefixed hex string of exactly `byteLen` bytes. */
function isHexBytes(v: unknown, byteLen: number): v is Hex {
  return (
    typeof v === "string" &&
    new RegExp(`^0x[0-9a-fA-F]{${byteLen * 2}}$`).test(v)
  );
}

/** True if `v` is a non-negative base-10 integer string (uint, no sign/decimal). */
function isUintString(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0) return false;
  if (!/^[0-9]+$/.test(v)) return false;
  // BigInt round-trips a valid uint string; reject anything else (e.g. "01" is fine,
  // "-1"/"1.0"/"" are rejected by the regex above).
  try {
    return BigInt(v) >= 0n;
  } catch {
    return false;
  }
}

/** Encode a PaymentPayload to a base64 header value. */
export function encodePayment(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/**
 * Decode and VALIDATE a base64 X-PAYMENT header into a typed PaymentPayload.
 *
 * @throws if the header is not valid base64, not JSON, or any field fails the
 *         address/bytes32/uint bounds check (ASVS V5 - reject, never coerce).
 */
export function decodePayment(header: string): PaymentPayload {
  if (typeof header !== "string" || header.length === 0) {
    throw new Error("decodePayment: empty or non-string header");
  }

  // Reject anything that is not strict base64 BEFORE decoding (Buffer is lenient).
  // Enforce: only base64 alphabet + at most 2 trailing `=`, length a multiple of 4,
  // and at least one non-pad char (a string like "==" or "====" is not valid base64).
  if (
    header.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(header) ||
    /^=+$/.test(header)
  ) {
    throw new Error("decodePayment: header is not valid base64");
  }

  const json = Buffer.from(header, "base64").toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("decodePayment: decoded payload is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("decodePayment: payload is not an object");
  }

  const p = parsed as Record<string, unknown>;

  if (typeof p.x402Version !== "number") {
    throw new Error("decodePayment: missing/invalid x402Version");
  }
  if (typeof p.scheme !== "string") {
    throw new Error("decodePayment: missing/invalid scheme");
  }
  // Defense in depth: reject a foreign scheme rather than relying solely on the
  // EIP-712 domain separator to fail signature recovery downstream.
  if (!ACCEPTED_SCHEMES.has(p.scheme)) {
    throw new Error("decodePayment: unsupported scheme");
  }
  if (typeof p.network !== "string") {
    throw new Error("decodePayment: missing/invalid network");
  }
  // The payload must claim the Arc CAIP-2 network; a cross-chain replay is rejected
  // here, not just by the domain separator (defense in depth, clear reason).
  if (p.network !== ARC_CAIP2_NETWORK) {
    throw new Error("decodePayment: unsupported network");
  }
  if (typeof p.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(p.signature)) {
    throw new Error("decodePayment: missing/invalid signature");
  }

  const auth = p.authorization;
  if (typeof auth !== "object" || auth === null) {
    throw new Error("decodePayment: missing authorization");
  }
  const a = auth as Record<string, unknown>;

  if (typeof a.buyer !== "string" || !isAddress(a.buyer)) {
    throw new Error("decodePayment: authorization.buyer is not a valid address");
  }
  if (!isHexBytes(a.resourceId, 32)) {
    throw new Error("decodePayment: authorization.resourceId is not bytes32");
  }
  if (!isHexBytes(a.nonce, 32)) {
    throw new Error("decodePayment: authorization.nonce is not bytes32");
  }
  if (!isUintString(a.maxAmount)) {
    throw new Error("decodePayment: authorization.maxAmount is not a uint string");
  }
  if (!isUintString(a.validBefore)) {
    throw new Error("decodePayment: authorization.validBefore is not a uint string");
  }

  return {
    x402Version: p.x402Version,
    scheme: p.scheme,
    network: p.network,
    authorization: {
      buyer: a.buyer,
      resourceId: a.resourceId,
      maxAmount: a.maxAmount,
      nonce: a.nonce,
      validBefore: a.validBefore,
    },
    signature: p.signature as Hex,
  };
}
