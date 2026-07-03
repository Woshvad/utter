// keys.tsx - the STU-05 API-key route (creator-gated mint + list). Closes WR-02:
// the mint flow is now reachable end to end behind requireCreator.
//
//   loader  -> requireCreator, then list the creator's MASKED key references (never
//              raw, never the stored hash body) so ApiKeyPanel can render "existing".
//   action  -> requireCreator, then apiKeyStore.mintFor(creator). The RAW key is
//              returned to the panel EXACTLY ONCE (shown-once reveal); only the hash
//              was persisted by the store. The raw never reaches a log line.
//
// Programmatic (non-SIWE) auth for the bearer-key surface lives in
// auth/apiKeyStore.server.ts (requireApiKeyCreator); this route is the SIWE-gated
// mint/list half.
import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useSubmit } from "react-router";
import { requireCreator } from "../auth/requireCreator.server.js";
import { apiKeyStore } from "../auth/apiKeyStore.server.js";
import { ApiKeyCapError } from "../auth/apikey.server.js";
import { FixedWindowLimiter, parsePositiveInt } from "../limits/fixed-window.server.js";
import { clientIpKey } from "../limits/client-ip.server.js";
import { ApiKeyPanel } from "../components/auth/ApiKeyPanel.js";

/** The loader payload: the creator's masked key references (never raw, never hash). */
export interface KeysLoaderData {
  /** Masked references (a "utk_••••" + short hash tail) for each persisted key. */
  existing: string[];
}

/** Mask a stored hash to a non-reversible reference: the utk_ prefix + a short tail. */
function maskHash(hash: string): string {
  return `utk_••••${hash.slice(-4)}`;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<KeysLoaderData> {
  const creator = await requireCreator(request);
  const hashes = await apiKeyStore.listHashes(creator);
  return { existing: hashes.map(maskHash) };
}

/** The action payload: the shown-once raw key, or the surfaced mint-cap message. */
export interface KeysActionData {
  /** The freshly-minted raw key, revealed ONCE. Never persisted, never logged. */
  mintedRaw: string | null;
  /** The per-creator cap / rate-limit message when minting was refused (no raw 500). */
  error: string | null;
}

/**
 * The mint admission limiters (module singletons, lazy so env is read at first use).
 * A mint does a SYNCHRONOUS full-file rewrite of the on-disk key store (O(n) in the
 * total key count), so an unthrottled mint loop both grows the store without bound
 * AND blocks the single studio event loop. requireCreator does not stop this: SIWE
 * wallets are free (any locally generated key signs, no gas), so an attacker mints
 * across unlimited fresh creator identities. The per-IP window is the real bound,
 * with a global backstop against source-address rotation (a routed IPv6 /56-/48
 * yields many /64 buckets).
 */
let mintLimiter: FixedWindowLimiter | undefined;
let mintGlobalLimiter: FixedWindowLimiter | undefined;

function limiter(): FixedWindowLimiter {
  if (!mintLimiter) {
    mintLimiter = new FixedWindowLimiter({
      limit: parsePositiveInt(process.env.KEYS_MINT_LIMIT_PER_IP_PER_MIN, 10, "KEYS_MINT_LIMIT_PER_IP_PER_MIN"),
      windowMs: 60_000,
    });
  }
  return mintLimiter;
}

function globalLimiter(): FixedWindowLimiter {
  if (!mintGlobalLimiter) {
    mintGlobalLimiter = new FixedWindowLimiter({
      limit: parsePositiveInt(process.env.KEYS_MINT_LIMIT_GLOBAL_PER_MIN, 60, "KEYS_MINT_LIMIT_GLOBAL_PER_MIN"),
      windowMs: 60_000,
    });
  }
  return mintGlobalLimiter;
}

export async function action({ request }: ActionFunctionArgs): Promise<KeysActionData> {
  // Access gate (CR-01): minting a key is creator-only.
  const creator = await requireCreator(request);

  // Admission BEFORE the mint's synchronous disk write: peek the per-IP and global
  // windows, commit both only when both allow (a denied request increments neither),
  // and surface a deny as the same inline message the per-creator cap uses (the panel
  // renders `error`; no raw 500, no error-boundary crash for the browser).
  const l = limiter();
  const g = globalLimiter();
  const ipKey = clientIpKey(request);
  const ipVerdict = l.peek(ipKey);
  const globalVerdict = g.peek("global");
  if (!ipVerdict.allowed || !globalVerdict.allowed) {
    const retryAfterMs = !ipVerdict.allowed ? ipVerdict.retryAfterMs : globalVerdict.retryAfterMs;
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return {
      mintedRaw: null,
      error: `too many key mints right now, try again in about ${seconds}s`,
    };
  }
  l.commit(ipKey);
  g.commit("global");

  // Mint: the store persists only the hash; `raw` is returned for the one-time reveal.
  // The per-creator cap surfaces as an inline message, never a raw 500.
  try {
    const { raw } = await apiKeyStore.mintFor(creator);
    return { mintedRaw: raw, error: null };
  } catch (err) {
    if (err instanceof ApiKeyCapError) {
      return { mintedRaw: null, error: err.message };
    }
    throw err;
  }
}

export default function KeysRoute(): React.ReactElement {
  const { existing } = useLoaderData<typeof loader>();
  const minted = useActionData<typeof action>();
  const submit = useSubmit();

  const onMint = React.useCallback(() => {
    submit(null, { method: "post" });
  }, [submit]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-lg p-xl">
      <h1 className="text-display font-display lowercase text-ink">api keys</h1>
      {minted?.error ? (
        <p data-testid="keys-error" className="m-0 font-mono text-[13px] text-red lowercase">
          {minted.error}
        </p>
      ) : null}
      <ApiKeyPanel mintedRaw={minted?.mintedRaw ?? null} existing={existing} onMint={onMint} />
    </div>
  );
}
