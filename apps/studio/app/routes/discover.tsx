// discover.tsx - the STU-03/04 marketplace browse screen (reads the MKT-02 index
// THROUGH the adapter).
//
// Read-through discipline (T-06-REDERIVE): the loader maps the URL query string to a
// FilterCriteria (the @utter/marketplace query shape) and calls
// selectAdapter(process.env).listMarketplace(criteria) - which delegates to the SAME
// pure filterResources the live index uses. The frontend NEVER recomputes a price,
// reputation, or bond; the cards render the projected values straight through.
//
// Money discipline: the decimals used to PARSE the price/bond filter inputs (entered as
// decimal USDC) come from a RUNTIME read through the adapter (getEscrowBalance().
// decimals) - there is NO 1e6/6 literal in this file's amount path. The criteria money
// fields are bigint base units; the free-text ?q= search is a slug/category contains
// match applied AFTER the read-through filter (it never touches money).
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import type { FilterCriteria } from "@utter/marketplace";
import { selectAdapter } from "../adapter/select.js";
import type { ResourceCardData } from "../adapter/types.js";
import { CardGrid } from "../components/discover/CardGrid.js";
import { CategoryChips } from "../components/discover/CategoryChips.js";
import { FilterPanel, type FilterPanelValues } from "../components/discover/FilterPanel.js";
import { SortControl, parseSort, sortCards, type SortOrder } from "../components/discover/SortControl.js";

/** Parse a decimal-USDC string to base-unit bigint using a RUNTIME decimals (no literal). */
function parseUsdcToBaseUnits(value: string, decimals: number): bigint | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const [whole, frac = ""] = trimmed.split(".");
  // Scale by 10 ** decimals built from the runtime read; pad/truncate the fraction.
  const scale = 10n ** BigInt(decimals);
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const wholePart = BigInt(whole || "0") * scale;
  const fracPart = decimals > 0 ? BigInt(fracPadded || "0") : 0n;
  return wholePart + fracPart;
}

/** Parse a plain non-negative integer string to bigint, or undefined when absent/bad. */
function parseIntCriteria(value: string | null): bigint | undefined {
  if (value === null) return undefined;
  const t = value.trim();
  if (t === "" || !/^\d+$/.test(t)) return undefined;
  return BigInt(t);
}

/** Parse a 0..1 float string (uptime), or undefined when absent/bad. */
function parseFloatCriteria(value: string | null): number | undefined {
  if (value === null) return undefined;
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** The serialized loader payload the screen renders. */
export interface DiscoverData {
  cards: ResourceCardData[];
  decimals: number;
  /** The FilterCriteria the loader built (for the 1:1 field-map assertions + UI state). */
  criteria: FilterCriteria;
  /** The free-text query (drives the no-results copy + the search box value). */
  query: string;
  /** The active sort order. */
  sort: SortOrder;
  /** The distinct categories present (drives the CategoryChips). */
  categories: string[];
}

/**
 * Map the URL query string to a FilterCriteria, list THROUGH the adapter, then apply the
 * sort + free-text query (both pure, money-free). Money filter inputs are entered as
 * decimal USDC and parsed with a runtime decimals read; the criteria money fields are
 * base-unit bigint.
 */
export async function loader({ request }: LoaderFunctionArgs): Promise<DiscoverData> {
  const url = new URL(request.url);
  const sp = url.searchParams;
  const adapter = selectAdapter(process.env);

  // Runtime money scale (no 6/1e6 literal): read decimals through the adapter once, then
  // use it to parse the price/bond filter inputs into base units.
  const zeroAddress = "0x0000000000000000000000000000000000000000" as const;
  const { decimals } = await adapter.getEscrowBalance(zeroAddress);

  // 1:1 field map: each URL param maps to exactly one FilterCriteria field. Price/bond
  // are entered as decimal USDC (the *Usdc suffix); raw base-unit params are also honored.
  const minBaseUsdc = sp.get("minBasePriceUsdc");
  const maxBaseUsdc = sp.get("maxBasePriceUsdc");
  const minBondUsdc = sp.get("minBondUsdc");

  const criteria: FilterCriteria = {};
  const category = sp.get("category");
  if (category) criteria.category = category;
  const active = sp.get("active");
  if (active === "true") criteria.active = true;
  else if (active === "false") criteria.active = false;
  const minReputation = parseIntCriteria(sp.get("minReputation"));
  if (minReputation !== undefined) criteria.minReputation = minReputation;
  const minUptime = parseFloatCriteria(sp.get("minUptime"));
  if (minUptime !== undefined) criteria.minUptime = minUptime;
  // bond: prefer the decimal-USDC field, else a raw base-unit field.
  const minBond =
    (minBondUsdc !== null ? parseUsdcToBaseUnits(minBondUsdc, decimals) : undefined) ??
    parseIntCriteria(sp.get("minBond"));
  if (minBond !== undefined) criteria.minBond = minBond;
  // price: decimal-USDC fields first, else raw base-unit fields.
  const minBasePrice =
    (minBaseUsdc !== null ? parseUsdcToBaseUnits(minBaseUsdc, decimals) : undefined) ??
    parseIntCriteria(sp.get("minBasePrice"));
  if (minBasePrice !== undefined) criteria.minBasePrice = minBasePrice;
  const maxBasePrice =
    (maxBaseUsdc !== null ? parseUsdcToBaseUnits(maxBaseUsdc, decimals) : undefined) ??
    parseIntCriteria(sp.get("maxBasePrice"));
  if (maxBasePrice !== undefined) criteria.maxBasePrice = maxBasePrice;

  // Read THROUGH the adapter (filterResources). Never recompute a price/reputation/bond.
  let cards = await adapter.listMarketplace(criteria);

  // The distinct categories present (from the FULL listing, so the chips are stable) -
  // a second unfiltered read so chips reflect the catalogue, not the filtered subset.
  const all = await adapter.listMarketplace({});
  const categories = Array.from(new Set(all.map((c) => c.category))).sort();

  // Free-text query: a slug/category contains match, applied AFTER the read-through
  // filter. It never touches money - it is a discovery convenience over projected text.
  const query = (sp.get("q") ?? "").trim();
  if (query) {
    const q = query.toLowerCase();
    cards = cards.filter((c) => c.slug.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  }

  // Sort (pure ordering over the projected values; never recomputes money).
  const sort = parseSort(sp.get("sort"));
  cards = sortCards(cards, sort);

  return { cards, decimals, criteria, query, sort, categories };
}

/** Build a discover URL preserving the current params with one key overridden/removed. */
function withParam(
  base: URLSearchParams,
  key: string,
  value: string | undefined,
): string {
  const next = new URLSearchParams(base);
  if (value === undefined || value === "") next.delete(key);
  else next.set(key, value);
  const qs = next.toString();
  return qs ? `?${qs}` : "?";
}

export default function DiscoverRoute(): React.ReactElement {
  const { cards, decimals, criteria, query, sort, categories } = useLoaderData<typeof loader>();

  // Reconstruct the current params so chips/sort links preserve the rest of the state.
  const params = React.useMemo(() => {
    const sp = new URLSearchParams();
    if (criteria.category) sp.set("category", criteria.category);
    if (query) sp.set("q", query);
    if (sort) sp.set("sort", sort);
    return sp;
  }, [criteria.category, query, sort]);

  const filterValues: FilterPanelValues = {
    category: criteria.category,
    q: query,
    sort,
    active: criteria.active === true ? "true" : undefined,
    minReputation: criteria.minReputation !== undefined ? criteria.minReputation.toString() : undefined,
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-lg p-xl">
      {/* lead neutral + blue per the color discipline (no red/yellow chrome here) */}
      <header className="flex flex-col gap-xs">
        <h1 className="text-display font-display lowercase text-ink">discover</h1>
        <p className="text-body text-ink-muted lowercase">
          browse live, agent-payable apis. pay per call in usdc.
        </p>
      </header>

      <CategoryChips
        categories={categories}
        active={criteria.category}
        hrefFor={(c) => withParam(params, "category", c)}
      />

      <div className="flex flex-col gap-lg lg:flex-row">
        <aside className="lg:w-72 lg:shrink-0">
          <FilterPanel values={filterValues} />
        </aside>

        <section className="flex flex-1 flex-col gap-md">
          <div className="flex items-center justify-between">
            <span className="font-mono text-caption-mono text-ink-faint tabular-nums lowercase">
              {`${cards.length} ${cards.length === 1 ? "resource" : "resources"}`}
            </span>
            <SortControl active={sort} hrefFor={(s) => withParam(params, "sort", s)} />
          </div>

          <CardGrid
            cards={cards}
            decimals={decimals}
            query={query}
            hrefFor={(card) => `/resources/${card.resourceId}`}
          />
        </section>
      </div>
    </div>
  );
}
