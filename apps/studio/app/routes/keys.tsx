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

/** The action payload: the shown-once raw key for the just-minted key. */
export interface KeysActionData {
  /** The freshly-minted raw key, revealed ONCE. Never persisted, never logged. */
  mintedRaw: string;
}

export async function action({ request }: ActionFunctionArgs): Promise<KeysActionData> {
  // Access gate (CR-01): minting a key is creator-only.
  const creator = await requireCreator(request);
  // Mint: the store persists only the hash; `raw` is returned for the one-time reveal.
  const { raw } = await apiKeyStore.mintFor(creator);
  return { mintedRaw: raw };
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
      <ApiKeyPanel mintedRaw={minted?.mintedRaw ?? null} existing={existing} onMint={onMint} />
    </div>
  );
}
