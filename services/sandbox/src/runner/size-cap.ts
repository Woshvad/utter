// size-cap.ts - the HARD request/response size cap (SBX-04 SIZE clause).
//
// This is the SBX-04 size clause: a HARD limit on the ACTUAL bytes crossing the
// runner I/O boundary. It REJECTS an oversize request body BEFORE the untrusted
// handler runs (request-ingress), and REJECTS an oversize response body at the
// response-egress boundary.
//
// !!! DISTINCT FROM THE PHASE-2 METERING PRICING CLAMP !!!
// `packages/x402-arc/src/metering.ts` `computeMeteredAmount` clamps only the
// BILLED size *term* (`Math.min(bodyBytes, maxResponseBytes)`) so an oversize
// body cannot inflate the CHARGE - it does NOT reject or truncate the bytes
// served. THIS module is the opposite: it bounds the bytes themselves (a 413 /
// 502 hard reject), independent of pricing. The two are intentionally separate
// concerns and must not be conflated (RESEARCH Anti-Pattern + Pitfall):
//   - metering clamp  -> affects the CHARGE, not the bytes
//   - size cap (here) -> affects the BYTES, not the charge
// metering.ts is NOT modified by this module.
//
// Chosen response mode: REJECT (not truncate). A truncated body would corrupt
// the handler's contract (a partial JSON document is worse than a clear error),
// and the buyer must learn the response was over-limit rather than silently
// receive a clipped payload. `enforceResponseSizeCap` therefore THROWS a 502-
// shaped SizeCapError on an oversize response; an at/under-limit body passes
// through unchanged. (The mode is asserted in size-cap.test.ts.)

/** The default request cap (bytes) - mirrors `.env.example` MAX_REQUEST_BYTES. */
export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
/** The default response cap (bytes) - mirrors `.env.example` MAX_RESPONSE_BYTES. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

/** The 413/502-shaped reason a size cap trips. */
export type SizeCapReason = "request_too_large" | "response_too_large";

/** A hard size-cap rejection. Carries a 413/502-shaped payload for the gate. */
export class SizeCapError extends Error {
  /** 413 for an oversize request, 502 for an oversize response. */
  readonly status: 413 | 502;
  /** Machine-readable reason. */
  readonly reason: SizeCapReason;
  /** The cap that was exceeded (bytes). */
  readonly limit: number;
  /** The actual size that tripped it (bytes). */
  readonly actual: number;

  constructor(reason: SizeCapReason, limit: number, actual: number) {
    super(`${reason}: ${actual} bytes exceeds the ${limit}-byte cap`);
    this.name = "SizeCapError";
    this.status = reason === "request_too_large" ? 413 : 502;
    this.reason = reason;
    this.limit = limit;
    this.actual = actual;
  }
}

/** Byte length of a body (string measured as utf8; Buffer/Uint8Array by length). */
export function byteLengthOf(body: string | Uint8Array): number {
  return typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
}

/** Read MAX_REQUEST_BYTES from env (defaulted). */
export function maxRequestBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = env["MAX_REQUEST_BYTES"];
  return v ? Number.parseInt(v, 10) : DEFAULT_MAX_REQUEST_BYTES;
}

/** Read MAX_RESPONSE_BYTES from env (defaulted). */
export function maxResponseBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = env["MAX_RESPONSE_BYTES"];
  return v ? Number.parseInt(v, 10) : DEFAULT_MAX_RESPONSE_BYTES;
}

/**
 * HARD-reject an oversize REQUEST body BEFORE the untrusted handler runs. Throws
 * `SizeCapError` (413/`request_too_large`) when the body exceeds `maxBytes`;
 * returns the body unchanged when at/under the limit.
 *
 * @param body     the request body (string measured utf8, or raw bytes)
 * @param maxBytes the cap (defaults to MAX_REQUEST_BYTES)
 */
export function enforceRequestSizeCap<T extends string | Uint8Array>(
  body: T,
  maxBytes: number = maxRequestBytesFromEnv(),
): T {
  const size = byteLengthOf(body);
  if (size > maxBytes) {
    throw new SizeCapError("request_too_large", maxBytes, size);
  }
  return body;
}

/**
 * HARD-reject an oversize RESPONSE body at the runner's egress boundary. Mode:
 * REJECT (see the module header for why truncation is not used). Throws
 * `SizeCapError` (502/`response_too_large`) when the body exceeds `maxBytes`;
 * returns the body unchanged when at/under the limit.
 *
 * @param body     the response body (string measured utf8, or raw bytes)
 * @param maxBytes the cap (defaults to MAX_RESPONSE_BYTES)
 */
export function enforceResponseSizeCap<T extends string | Uint8Array>(
  body: T,
  maxBytes: number = maxResponseBytesFromEnv(),
): T {
  const size = byteLengthOf(body);
  if (size > maxBytes) {
    throw new SizeCapError("response_too_large", maxBytes, size);
  }
  return body;
}
