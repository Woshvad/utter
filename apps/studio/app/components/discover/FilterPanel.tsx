// FilterPanel - the discover filter form. Every field maps 1:1 to a FilterCriteria
// field (the @utter/marketplace query shape): price range, verified/active, has-bond.
//
// The panel is a GET <Form> so submitting re-reads the criteria from the URL query
// string (the read-through browse model the loader parses). Money inputs are entered
// as decimal USDC and parsed to base units by the loader from a RUNTIME decimals read -
// the panel itself carries NO 1e6/6 literal; it only forwards the raw string fields.
import * as React from "react";
import { Form } from "react-router";

/** The raw (string) filter field values the panel is initialised with. */
export interface FilterPanelValues {
  category?: string;
  minBasePrice?: string;
  maxBasePrice?: string;
  minReputation?: string;
  minBond?: string;
  minUptime?: string;
  /** "true" when the verified/active filter is on. */
  active?: string;
  /** The current free-text search query (preserved across submits). */
  q?: string;
  /** The current sort (preserved across submits). */
  sort?: string;
}

export interface FilterPanelProps {
  values: FilterPanelValues;
}

export function FilterPanel({ values }: FilterPanelProps): React.ReactElement {
  return (
    <Form
      method="get"
      data-testid="filter-panel"
      aria-label="filter resources"
      className="flex flex-col gap-md border border-hairline bg-raised p-md"
    >
      {/* preserve the active sort + category across a filter submit */}
      {values.sort ? <input type="hidden" name="sort" value={values.sort} /> : null}
      {values.category ? <input type="hidden" name="category" value={values.category} /> : null}

      <label className="flex flex-col gap-2xs">
        <span className="font-display text-label text-ink-muted lowercase">search</span>
        <input
          type="text"
          name="q"
          defaultValue={values.q ?? ""}
          placeholder="weather, summarize, ..."
          className="border border-hairline bg-canvas px-sm py-2xs font-mono text-body text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
        />
      </label>

      <fieldset className="flex flex-col gap-2xs">
        <legend className="font-display text-label text-ink-muted lowercase">price range (usdc)</legend>
        <div className="flex items-center gap-xs">
          <input
            type="text"
            inputMode="decimal"
            name="minBasePriceUsdc"
            defaultValue={values.minBasePrice ?? ""}
            placeholder="min"
            aria-label="minimum price"
            className="w-24 border border-hairline bg-canvas px-sm py-2xs font-mono text-body text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
          />
          <span aria-hidden="true" className="text-ink-faint">–</span>
          <input
            type="text"
            inputMode="decimal"
            name="maxBasePriceUsdc"
            defaultValue={values.maxBasePrice ?? ""}
            placeholder="max"
            aria-label="maximum price"
            className="w-24 border border-hairline bg-canvas px-sm py-2xs font-mono text-body text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
          />
        </div>
      </fieldset>

      <label className="flex flex-col gap-2xs">
        <span className="font-display text-label text-ink-muted lowercase">min reputation</span>
        <input
          type="text"
          inputMode="numeric"
          name="minReputation"
          defaultValue={values.minReputation ?? ""}
          placeholder="0"
          className="w-24 border border-hairline bg-canvas px-sm py-2xs font-mono text-body text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
        />
      </label>

      <label className="flex flex-col gap-2xs">
        <span className="font-display text-label text-ink-muted lowercase">min bond (usdc)</span>
        <input
          type="text"
          inputMode="decimal"
          name="minBondUsdc"
          defaultValue={values.minBond ?? ""}
          placeholder="0"
          className="w-24 border border-hairline bg-canvas px-sm py-2xs font-mono text-body text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
        />
      </label>

      <label className="flex items-center gap-xs">
        <input
          type="checkbox"
          name="active"
          value="true"
          defaultChecked={values.active === "true"}
          className="h-4 w-4 accent-blue"
        />
        <span className="font-display text-label text-ink-muted lowercase">verified + listed only</span>
      </label>

      <button
        type="submit"
        className="min-h-[44px] border border-blue bg-blue px-md py-2xs font-display text-label text-paper lowercase outline-none focus-visible:ring-2 focus-visible:ring-blue"
      >
        apply filters
      </button>
    </Form>
  );
}
