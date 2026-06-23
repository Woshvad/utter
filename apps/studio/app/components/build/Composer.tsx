// Composer - the STU-01 compose shell (the "utter a sentence" moment). A single
// raised box: a large calm 18px textarea, then a controls row with the segmented
// flat / metered pricing toggle, a [- value +] price stepper, a bond chip, and the
// white-triangle `utter` submit. Example chips below fill the textarea on click.
// It POSTs to the /create action (Composer is presentational; validation + adapter.
// createResource happen server-side in the action - the security control is
// server-side, not here).
//
// Money inputs are entered as a decimal USDC string; the action parses them to
// base-unit bigints (no 1e6/6 literal in this component - it carries no money math).
// The pricing model, price, and bond are posted via hidden inputs the controls
// drive; payout has no visible field in the comp, so it is posted as a hidden input
// defaulted to the creator/fixture address so validateComposeSpec still gets a Hex.
import * as React from "react";
import { Form } from "react-router";

export interface ComposerProps {
  /** Field-level errors keyed by field name (from the action on a rejected submit). */
  errors?: Partial<Record<"prompt" | "basePrice" | "bond" | "payout", string>>;
  /** Whether a submit is in flight (disables the control). */
  submitting?: boolean;
  /** Optional prefill prompt (from the loader's ?prompt=, e.g. the iterate bar). */
  initialPrompt?: string;
}

/** Default payout when no connected address is available (fixture creator). */
const DEFAULT_PAYOUT = "0x1111111111111111111111111111111111111111";

/** The three comp example prompts that fill the textarea on click (data 940-944). */
const EXAMPLES = [
  "score the sentiment of a tweet from -1 to 1",
  "convert any currency to usd at live fx rates",
  "extract structured fields from an invoice pdf",
];

/** Price stepper bounds + step, in decimal USDC (posted as a decimal string). */
const PRICE_MIN = 0.0001;
const PRICE_STEP = 0.0001;
const DEFAULT_BOND = 5;

export function Composer({ errors, submitting, initialPrompt }: ComposerProps): React.ReactElement {
  const [prompt, setPrompt] = React.useState(initialPrompt ?? "");
  const [metered, setMetered] = React.useState(false);
  // Price held in state as a decimal number; posted as a 6-dp decimal string. No
  // money math / scale literal here - the action parses with runtime decimals.
  const [price, setPrice] = React.useState(0.01);

  const pricingModel = metered ? "metered" : "flat";
  const priceStr = price.toFixed(6);
  const priceFmt =
    pricingModel === "flat"
      ? `$${price.toFixed(4)} / call`
      : `≤ $${price.toFixed(4)} metered`;
  const bondFmt = `$${DEFAULT_BOND.toFixed(0)}`;

  return (
    <Form
      method="post"
      data-testid="composer"
      aria-label="compose a resource"
      className="flex flex-col"
    >
      {/* the raised composer box: textarea + controls row */}
      <div className="border border-hairline bg-raised">
        <textarea
          name="prompt"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="utter a sentence…  e.g. score the sentiment of a tweet from -1 to 1 and return json"
          aria-label="prompt"
          className="block w-full border-0 bg-transparent p-[20px] text-[18px] leading-[1.45] tracking-[-0.01em] text-ink outline-none placeholder:text-ink-faint"
        />

        <div className="flex flex-wrap items-center gap-[8px] border-t border-hairline p-[12px_14px]">
          {/* segmented flat / metered toggle (active = blue-filled) */}
          <div className="flex border border-hairline" role="group" aria-label="pricing model">
            <button
              type="button"
              aria-pressed={!metered}
              onClick={() => setMetered(false)}
              className={[
                "cursor-pointer px-[14px] py-[9px] font-mono text-[13px]",
                !metered ? "bg-blue text-white" : "bg-transparent text-ink-muted",
              ].join(" ")}
            >
              flat
            </button>
            <button
              type="button"
              aria-pressed={metered}
              onClick={() => setMetered(true)}
              className={[
                "cursor-pointer px-[14px] py-[9px] font-mono text-[13px]",
                metered ? "bg-blue text-white" : "bg-transparent text-ink-muted",
              ].join(" ")}
            >
              metered
            </button>
          </div>

          {/* price stepper [- value +] */}
          <div className="flex items-center border border-hairline">
            <button
              type="button"
              aria-label="decrease price"
              onClick={() => setPrice((p) => Math.max(PRICE_MIN, +(p - PRICE_STEP).toFixed(6)))}
              className="cursor-pointer border-r border-hairline px-[12px] py-[8px] font-mono text-ink-muted"
            >
              −
            </button>
            <span
              data-testid="composer-price"
              className="min-w-[108px] px-[12px] py-[8px] text-center font-mono text-[13px] text-yellow"
            >
              {priceFmt}
            </span>
            <button
              type="button"
              aria-label="increase price"
              onClick={() => setPrice((p) => +(p + PRICE_STEP).toFixed(6))}
              className="cursor-pointer border-l border-hairline px-[12px] py-[8px] font-mono text-ink-muted"
            >
              +
            </button>
          </div>

          {/* bond chip (static default; posted via hidden input) */}
          <div className="flex items-center gap-[8px] border border-hairline px-[12px] py-[8px]">
            <span className="font-mono text-[12px] text-ink-faint">bond</span>
            <span data-testid="composer-bond" className="font-mono text-[13px] text-ink">
              {bondFmt}
            </span>
          </div>

          <div className="flex-1" />

          {/* white-triangle `utter` submit */}
          <button
            type="submit"
            data-testid="composer-submit"
            disabled={submitting}
            className="flex items-center gap-[9px] border-0 bg-red px-[20px] py-[11px] text-[14px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-red disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              style={{
                width: 0,
                height: 0,
                borderTop: "6px solid transparent",
                borderBottom: "6px solid transparent",
                borderLeft: "10px solid #fff",
              }}
            />
            utter
          </button>
        </div>
      </div>

      {/* hidden fields the controls drive (the action validates these server-side) */}
      <input type="hidden" name="pricingModel" value={pricingModel} />
      <input type="hidden" name="basePrice" value={priceStr} />
      <input type="hidden" name="bond" value={DEFAULT_BOND.toFixed(6)} />
      {/* payout has no visible field in the comp - default to the fixture creator so
          validateComposeSpec still receives a valid Hex and createResource works. */}
      <input type="hidden" name="payout" value={DEFAULT_PAYOUT} />

      {/* field-level errors (restyled red-triangle lines) */}
      {errors?.prompt ? <ErrorLine field="prompt" message={errors.prompt} /> : null}
      {errors?.basePrice ? <ErrorLine field="basePrice" message={errors.basePrice} /> : null}
      {errors?.bond ? <ErrorLine field="bond" message={errors.bond} /> : null}
      {errors?.payout ? <ErrorLine field="payout" message={errors.payout} /> : null}

      {/* example chips - fill the textarea on click */}
      <div className="mt-[18px] flex flex-wrap gap-[8px]">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            data-testid="composer-example"
            onClick={() => setPrompt(ex)}
            className="cursor-pointer border border-hairline px-[13px] py-[9px] font-mono text-[13px] text-ink-muted"
          >
            {ex}
          </button>
        ))}
      </div>
    </Form>
  );
}

function ErrorLine({ field, message }: { field: string; message: string }): React.ReactElement {
  return (
    <span
      data-testid={`composer-error-${field}`}
      role="alert"
      className="mt-[10px] flex items-center gap-2xs font-mono text-caption-mono lowercase"
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
