// Composer - the STU-01 compose shell (the "utter a sentence" moment). A large calm
// input, a pricing toggle (flat / metered), price + bond steppers in mono USDC, a
// payout address field, and the triangle `utter it` submit. It POSTs to the /create
// action (Composer is presentational; validation + adapter.createResource happen
// server-side in the action - the security control is server-side, not here).
//
// Money inputs are entered as a decimal USDC string; the action parses them to
// base-unit bigints (no 1e6/6 literal in this component - it carries no money math).
import * as React from "react";
import { Form } from "react-router";
import { Input } from "../primitives/Input";
import { Toggle } from "../primitives/Toggle";

export interface ComposerProps {
  /** Field-level errors keyed by field name (from the action on a rejected submit). */
  errors?: Partial<Record<"prompt" | "basePrice" | "bond" | "payout", string>>;
  /** Whether a submit is in flight (disables the control). */
  submitting?: boolean;
}

export function Composer({ errors, submitting }: ComposerProps): React.ReactElement {
  const [metered, setMetered] = React.useState(false);

  return (
    <Form
      method="post"
      data-testid="composer"
      className="flex flex-col gap-md"
      aria-label="compose a resource"
    >
      {/* the large calm prompt input (multi-line; Input is single-line so use a
          matching hard-edged textarea) */}
      <div className="flex flex-col gap-2xs">
        <textarea
          name="prompt"
          rows={3}
          placeholder="utter a sentence…"
          aria-label="prompt"
          className={[
            "block w-full bg-raised text-ink placeholder:text-ink-faint",
            "px-sm py-sm text-ui font-display",
            "border border-hairline outline-none",
            "focus-visible:ring-2 focus-visible:ring-blue",
          ].join(" ")}
        />
        {errors?.prompt ? (
          <ErrorLine field="prompt" message={errors.prompt} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-lg">
        {/* pricing model toggle: flat / metered (square knob) */}
        <div className="flex flex-col gap-2xs">
          <span className="text-label font-display text-ink-muted lowercase">pricing</span>
          <Toggle
            pressed={metered}
            onPressedChange={setMetered}
            label={metered ? "metered" : "flat"}
          />
          {/* the server reads the model from this hidden field (toggle drives it) */}
          <input type="hidden" name="pricingModel" value={metered ? "metered" : "flat"} />
        </div>

        {/* price stepper (mono USDC) */}
        <div className="flex flex-col gap-2xs">
          <label htmlFor="basePrice" className="text-label font-display text-ink-muted lowercase">
            price / call (usdc)
          </label>
          <Input
            id="basePrice"
            name="basePrice"
            inputMode="decimal"
            placeholder="0.010000"
            className="font-mono"
          />
          {errors?.basePrice ? (
            <ErrorLine field="basePrice" message={errors.basePrice} />
          ) : null}
        </div>

        {/* bond amount (mono USDC) */}
        <div className="flex flex-col gap-2xs">
          <label htmlFor="bond" className="text-label font-display text-ink-muted lowercase">
            bond (usdc)
          </label>
          <Input
            id="bond"
            name="bond"
            inputMode="decimal"
            placeholder="5.000000"
            className="font-mono"
          />
          {errors?.bond ? <ErrorLine field="bond" message={errors.bond} /> : null}
        </div>
      </div>

      {/* payout address */}
      <div className="flex flex-col gap-2xs">
        <label htmlFor="payout" className="text-label font-display text-ink-muted lowercase">
          payout address
        </label>
        <Input
          id="payout"
          name="payout"
          placeholder="0x…"
          className="font-mono"
          aria-label="payout address"
        />
        {errors?.payout ? <ErrorLine field="payout" message={errors.payout} /> : null}
      </div>

      {/* triangle `utter it` submit */}
      <div>
        <button
          type="submit"
          data-testid="composer-submit"
          disabled={submitting}
          className={[
            "inline-flex items-center gap-xs",
            "border border-red bg-red px-md py-sm",
            "text-label font-display lowercase text-paper-ink",
            "outline-none focus-visible:ring-2 focus-visible:ring-red",
            "disabled:opacity-50",
          ].join(" ")}
        >
          <span
            aria-hidden="true"
            style={{
              width: 0,
              height: 0,
              borderTop: "6px solid transparent",
              borderBottom: "6px solid transparent",
              borderLeft: "10px solid var(--paper-ink)",
            }}
          />
          utter it
        </button>
      </div>
    </Form>
  );
}

function ErrorLine({ field, message }: { field: string; message: string }): React.ReactElement {
  return (
    <span
      data-testid={`composer-error-${field}`}
      role="alert"
      className="flex items-center gap-2xs font-mono text-caption-mono lowercase"
      style={{ color: "var(--red)" }}
    >
      {/* red triangle - error is shape + color, never color alone */}
      <span
        aria-hidden="true"
        style={{
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderBottom: "9px solid var(--red)",
        }}
      />
      {message}
    </span>
  );
}
