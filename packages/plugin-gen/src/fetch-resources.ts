// fetch-resources.ts - read published endpoints from the live marketplace (GET /resources)
// and map them to PluginResource. The fetcher is injectable so this is unit tested offline;
// the default is the global fetch. An optional enrich pass fills each endpoint's description
// from its agent card (best-effort, never throws).
import type { PluginResource } from "./types.js";
import { resourceFromIndexRow, type MarketplaceIndexRow } from "./adapters.js";

/** A minimal fetch shape (injectable; defaults to the global fetch). */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Read + map the public marketplace GET /resources index to PluginResource[]. */
export async function fetchResources(opts: {
  marketplaceIndexUrl: string;
  fetcher?: FetchLike;
}): Promise<PluginResource[]> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.marketplaceIndexUrl.replace(/\/+$/, "");
  const res = await fetcher(`${base}/resources`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (res.status !== 200) {
    throw new Error(`plugin-gen: marketplace ${base}/resources returned HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error(`plugin-gen: marketplace ${base}/resources did not return a JSON array`);
  }
  const rows = body as MarketplaceIndexRow[];
  // Only list active rows (a delisted resource should not become a plugin).
  return rows.filter((row) => row.active !== false).map(resourceFromIndexRow);
}

/**
 * Best-effort enrichment: for each resource with a cardUrl but a placeholder description,
 * fetch the agent card and adopt its `description`. Never throws; a failed fetch leaves the
 * resource unchanged. Returns a new array (inputs are not mutated).
 */
export async function enrichDescriptions(
  resources: PluginResource[],
  fetcher?: FetchLike,
): Promise<PluginResource[]> {
  const f = fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const out: PluginResource[] = [];
  for (const resource of resources) {
    const placeholder = resource.description === `The ${resource.slug} Utter endpoint.`;
    if (!resource.cardUrl || !placeholder) {
      out.push(resource);
      continue;
    }
    try {
      const res = await f(resource.cardUrl, { method: "GET", headers: { accept: "application/json" } });
      if (res.status === 200) {
        const card = (await res.json()) as Record<string, unknown>;
        const desc = card?.description;
        if (typeof desc === "string" && desc.trim().length > 0) {
          out.push({ ...resource, description: desc.trim() });
          continue;
        }
      }
    } catch {
      // best-effort: fall through to the unchanged resource
    }
    out.push(resource);
  }
  return out;
}
