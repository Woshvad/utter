// pin-dispatcher.ts: socket-pinning dispatcher seam (M7, DNS-rebind TOCTOU close).
//
// THE WINDOW (CR-02 residual): the proxy resolves the upstream host, re-checks
// every A/AAAA address against the SSRF block set, then connects. Between the
// final recheck and the actual TCP connect a malicious record can flip to a
// blocked IP (a classic DNS-rebind TOCTOU). The block-set rechecks narrow the
// window but cannot close it, because the connect itself re-resolves the name.
//
// THE CLOSE: pin the forward connection to an IP we ALREADY validated. We hand the
// forward `fetch` an undici dispatcher whose `connect.lookup` returns ONLY the
// validated IP(s) for the target host, so the TCP connect goes to a checked
// address and the connect-time re-resolution is bypassed entirely. The dispatcher
// connects BY IP but keeps the original hostname as the TLS servername + the Host
// header, so HTTPS certificate validation (SNI) is unaffected: we constrain the
// connect TARGET, never the TLS identity. This is purely ADDITIVE: the validation
// ordering above is unchanged; the pin only restricts the connect to an IP the
// proxy already approved.
//
// DEPENDENCY POSTURE (load-bearing for "no new top-level dep"): constructing a
// real undici `Agent` requires the `undici` package. Node bundles undici for the
// global `fetch`, but does NOT expose it as an importable module, and it is not in
// @utter/data-proxy's dependency tree. So the DEFAULT factory attempts a dynamic,
// OPTIONAL import of `undici`; when undici is unavailable it returns `undefined`
// (no dispatcher) and the forward proceeds WITHOUT a pin, i.e. exactly today's
// behavior, with the block-set rechecks still in force. The pin is fully wired and
// fully tested via the INJECTED factory seam (`pinningDispatcherFactory`); the
// real-undici default activates the moment `undici` is a resolvable dependency,
// with no proxy-code change. See SUMMARY for why `undici` was not added here.

/** A validated, block-checked address the proxy may pin the connect to. */
export interface PinnedAddress {
  /** The resolved IP literal (already passed the SSRF block-set recheck). */
  address: string;
  /** The IP family (4 = A record, 6 = AAAA record). */
  family: 4 | 6;
}

/**
 * Build a connect-pinning dispatcher for `host` constrained to `addresses`, or
 * return `undefined` when no pinning transport is available (the forward then
 * proceeds without a pin, preserving today's behavior).
 *
 * The returned value, when present, is passed straight through as the `dispatcher`
 * property on the forward `fetch` init (an undici extension Node's global `fetch`
 * honors). It is typed `unknown` so this module carries NO compile-time dependency
 * on undici's types; the runtime shape is an undici `Dispatcher`.
 */
export type PinningDispatcherFactory = (
  host: string,
  addresses: readonly PinnedAddress[],
) => Promise<unknown | undefined>;

/**
 * The default pinning-dispatcher factory.
 *
 * Attempts an OPTIONAL dynamic import of `undici` and, if present, builds an
 * `Agent` whose `connect.lookup` short-circuits DNS to return ONLY the validated
 * IP for `host`. The TLS servername is left to undici's default (the original
 * hostname), so SNI / certificate validation still verifies against the real host
 * name even though the socket connects by IP. When `undici` cannot be imported (no
 * dependency present), returns `undefined` so the forward proceeds without a pin.
 *
 * NEVER logs the host, addresses, or any request material.
 */
export const defaultPinningDispatcherFactory: PinningDispatcherFactory = async (
  host,
  addresses,
) => {
  if (addresses.length === 0) return undefined;
  // The runtime shape of undici's module. Typed minimally + locally so this file
  // carries NO compile-time dependency on undici's type declarations (which are not
  // present until `undici` is added as a real dependency). The dynamic specifier is
  // hidden behind a variable so the type checker does not try to resolve it.
  type UndiciAgentCtor = new (opts: {
    connect: {
      lookup: (
        host: string,
        opts: unknown,
        cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
      ) => void;
    };
  }) => unknown;
  type UndiciModule = { Agent?: UndiciAgentCtor };

  let undici: UndiciModule | undefined;
  try {
    // Optional: only resolves when `undici` is a real dependency of this package.
    // The data-proxy intentionally does not add it as a top-level dep; until it
    // does, this import fails and we fall back to no-pin (today's behavior). The
    // specifier is a variable so tsc does not attempt to type-resolve it.
    const specifier = "undici";
    undici = (await import(/* @vite-ignore */ specifier)) as UndiciModule;
  } catch {
    return undefined;
  }
  if (!undici?.Agent) return undefined;
  const Agent = undici.Agent;

  const targetHost = host.toLowerCase().replace(/\.$/, "");
  // Pin to the first validated address; undici's lookup callback yields one
  // address. Keep the resolved family so undici opens the right socket type.
  const pinned = addresses[0]!;

  return new Agent({
    connect: {
      // Pin the connect target to the already-validated IP for THIS host only.
      // Returning the IP here means undici connects to it directly and never
      // re-resolves the name (the rebind window is closed). For any other host
      // (there should be none on this single-shot dispatcher) we surface an
      // error rather than fall back to a live DNS lookup.
      lookup: (
        lookupHost: string,
        _opts: unknown,
        cb: (
          err: NodeJS.ErrnoException | null,
          address: string,
          family: number,
        ) => void,
      ) => {
        if (lookupHost.toLowerCase().replace(/\.$/, "") !== targetHost) {
          cb(new Error("pin_host_mismatch"), "", 0);
          return;
        }
        cb(null, pinned.address, pinned.family);
      },
    },
  });
};
