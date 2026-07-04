// create.tsx - the STU-01 compose route (action + screen). This is the entry of the
// signature utter -> live sequence (D-STU-01: prompt, pricing model, bond amount,
// payout address).
//
// The `action`:
//   1. reads the form,
//   2. runs validateComposeSpec FIRST (the V5 control) - rejects malformed input
//      with field errors BEFORE the adapter, so no partial resource is created
//      (T-06-INPUTVAL, reject-before-create),
//   3. on success calls selectAdapter(process.env).createResource(spec) and returns
//      { resourceId, eventsUrl } so the browser opens the SSE EventSource (the
//      Task-1 route) and the BuildStream takes over.
//
// Money discipline: the decimals used to parse the bond/price come from a RUNTIME
// read through the adapter (getEscrowBalance().decimals), never a 1e6/6 literal.
//
// The screen renders the comp's two-column create layout (Design/Utter.dc.html
// 240-361) INSIDE the app shell <main>: a centered composer column on the left, and
// a right preview aside (agent card + openapi) that appears once a build has started.
import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import { selectAdapter } from "../adapter/select.js";
import { requireCreator } from "../auth/requireCreator.server.js";
import { createGate } from "../limits/create-gate.server.js";
import { clientIpKey } from "../limits/client-ip.server.js";
import { TooManyBuildsError } from "../limits/build-slots.server.js";
import {
  validateComposeSpec,
  type ComposeFieldErrors,
} from "../validation/compose.js";
import { Composer } from "../components/build/Composer.js";
import { BuildStream } from "../components/build/BuildStream.js";
import { CardPreview } from "../components/detail/CardPreview.js";

/** The loader payload: an optional prefill prompt read from ?prompt= (the iterate bar). */
export interface CreateLoaderData {
  initialPrompt: string | null;
}

/**
 * Read an optional prefill prompt from the query string. This is deliberately NOT gated:
 * the create page is already open to everyone; only the action that mints a resource is
 * gated by requireCreator. The iterate bar on the live moment links here with ?prompt=.
 */
export async function loader({ request }: LoaderFunctionArgs): Promise<CreateLoaderData> {
  const initialPrompt = new URL(request.url).searchParams.get("prompt");
  return { initialPrompt };
}

/** The action result the screen renders: either field errors or the created resource
 *  plus the REAL values the live moment renders (no fabricated price/bond/name). */
export type CreateActionData =
  | { ok: false; errors: ComposeFieldErrors }
  | {
      ok: true;
      resourceId: string;
      eventsUrl: string;
      /** The prompt-derived preview slug (the live-moment headline + card name). */
      name: string;
      /** The creator's prompt - the honest agent-card description. */
      prompt: string;
      /** The creator's entered per-call price in base units (rendered via UsdcAmount). */
      priceBaseUnits: bigint;
      /** The creator's entered bond in base units (shown only when > 0). */
      bondBaseUnits: bigint;
      /** Runtime USDC decimals for the money renders (no 1e6/6 literal). */
      decimals: number;
    };

/**
 * The deny split. ONLY a request carrying an `Authorization: Bearer` header is
 * treated as a programmatic caller and gets a REAL 429 Response (JSON body +
 * Retry-After). Everything else - every browser form post - gets the inline
 * action-data errors shape so the composer renders the message instead of the root
 * error boundary.
 *
 * WHY NOT an Accept heuristic: React Router v7 single-fetch form submissions send
 * `Accept: * /*` (no text/html), so `!accept.includes("text/html")` misclassified
 * EVERY hydrated-browser create as programmatic and threw the 429 into the app-wide
 * error boundary ("something broke") for honest rate-limited creators - defeating
 * the entire point of the inline deny copy. A Bearer header is a positive, reliable
 * programmatic signal; session-cookie browser posts never carry one.
 */
function denyCreate(
  request: Request,
  reason: string,
  retryAfterMs: number,
  friendly: string,
): CreateActionData {
  const hasBearer = (request.headers.get("Authorization") ?? "").startsWith("Bearer ");
  if (hasBearer) {
    throw new Response(JSON.stringify({ error: "rate_limited", reason, retryAfterMs }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    });
  }
  return { ok: false, errors: { prompt: friendly } };
}

export async function action({ request }: ActionFunctionArgs): Promise<CreateActionData> {
  // Access gate (CR-01 / T-06-PRIVESC): an unauthenticated request must NOT reach
  // adapter.createResource. requireCreator throws redirect(/auth) for a document
  // navigation or a 401 for a data/fetch request, so anon can never mint a resource.
  const creator = await requireCreator(request);

  // Admission gate, IMMEDIATELY after auth and BEFORE the getEscrowBalance chain
  // read below: a denied request must not pay an Arc RPC round trip.
  const verdict = createGate().check(creator, clientIpKey(request));
  if (!verdict.allowed) {
    const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
    return denyCreate(
      request,
      verdict.reason,
      verdict.retryAfterMs,
      `too many creates right now (${verdict.reason}), try again in about ${seconds}s`,
    );
  }

  const adapter = selectAdapter(process.env);

  // Runtime money scale: read decimals through the adapter (no 6/1e6 literal). The
  // fixture returns deterministic decimals; the live path reads decimals() on-chain.
  const { decimals } = await adapter.getEscrowBalance(
    "0x0000000000000000000000000000000000000000",
  );

  const form = await request.formData();
  const validation = validateComposeSpec(
    {
      prompt: form.get("prompt"),
      pricingModel: form.get("pricingModel"),
      basePrice: form.get("basePrice"),
      bond: form.get("bond"),
      payout: form.get("payout"),
    },
    decimals,
  );

  // Reject-before-create: bad input never reaches the adapter (T-06-INPUTVAL).
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  // createResource runs the four-gate validator and throws BEFORE any publish on a gate
  // failure, so nothing partial is created. A throw (an unbuildable prompt in live mode)
  // surfaces an inline prompt field error rather than the something-broke screen.
  try {
    const { resourceId, eventsUrl } = await adapter.createResource(validation.spec);
    // Return the REAL values the live moment renders: the creator's entered price + bond
    // (base units, via the same runtime decimals) and the prompt-derived name + the prompt
    // itself as the honest card description. No fabricated price/bond/name downstream.
    return {
      ok: true,
      resourceId,
      eventsUrl,
      name: slugFromPrompt(validation.spec.prompt),
      prompt: validation.spec.prompt,
      priceBaseUnits: validation.spec.basePrice,
      bondBaseUnits: validation.spec.bond,
      decimals,
    };
  } catch (err) {
    // Build-slot saturation is a capacity condition, not a generation failure: it
    // gets the same deny split as a rate limit, never the could-not-generate copy.
    if (err instanceof TooManyBuildsError) {
      return denyCreate(
        request,
        "build_capacity",
        60_000,
        "studio is at build capacity, try again in a few minutes",
      );
    }
    return {
      ok: false,
      errors: {
        prompt: "could not generate a valid endpoint from that prompt, try rephrasing",
      },
    };
  }
}

/** A short, slug-like name derived from a free-text prompt (preview-only label). */
function slugFromPrompt(prompt: string | undefined): string {
  const cleaned = (prompt ?? "").toLowerCase().trim();
  if (cleaned.length === 0) return "your-endpoint";
  const slug = cleaned
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .slice(0, 2)
    .join("-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "your-endpoint";
}

// Lazy import keeps the route module loadable in a pure-action unit test without the
// component tree; the screen is the comp's two-column create layout.
export default function CreateRoute(): React.ReactElement {
  const data = useActionData<typeof action>();
  const { initialPrompt } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const built = data && data.ok ? data : null;
  const errors = data && !data.ok ? data.errors : undefined;

  const idle = !built;

  return (
    <div className="flex min-h-[calc(100vh-64px)]">
      {/* left column - composer / build stream */}
      <div className="flex min-w-0 flex-1 flex-col items-center px-[32px] pb-[80px] pt-[56px]">
        <div className="w-full max-w-[680px]">
          {idle ? (
            <div className="mb-[36px] text-center">
              {/* triad-shape row (circle / square / triangle) */}
              <div className="mb-[22px] inline-flex items-center gap-[10px]">
                <span
                  aria-hidden="true"
                  className="rounded-full"
                  style={{ width: 14, height: 14, background: "var(--red)" }}
                />
                <span
                  aria-hidden="true"
                  style={{ width: 12, height: 12, background: "var(--blue)" }}
                />
                <span
                  aria-hidden="true"
                  style={{
                    width: 0,
                    height: 0,
                    borderLeft: "7px solid transparent",
                    borderRight: "7px solid transparent",
                    borderBottom: "12px solid var(--yellow)",
                  }}
                />
              </div>
              <h1 className="mb-[10px] text-[36px] font-semibold tracking-[-0.03em] text-ink">
                utter a sentence.
              </h1>
              <p className="m-0 text-[16px] text-ink-muted">
                describe the endpoint. i&apos;ll write, deploy, verify and list it.
              </p>
            </div>
          ) : null}

          {built ? (
            <BuildStream
              eventsUrl={built.eventsUrl}
              resourceId={built.resourceId}
              liveName={built.name}
              priceBaseUnits={built.priceBaseUnits}
              bondBaseUnits={built.bondBaseUnits}
              decimals={built.decimals}
            />
          ) : (
            <Composer
              errors={errors}
              submitting={submitting}
              initialPrompt={initialPrompt ?? undefined}
            />
          )}
        </div>
      </div>

      {/* right preview aside - appears once a build has started (comp 344-360). The card
          shows the REAL slug + the creator's own prompt as the description; the OpenAPI is
          generated server-side during the build, so we link to the resource page (where the
          real spec is served) rather than showing a fabricated sample snippet. */}
      {built ? (
        <aside className="w-[360px] flex-none border-l border-hairline bg-canvas p-[24px]">
          <div className="mb-[14px] font-mono text-[11px] tracking-[0.06em] text-ink-faint">
            AGENT CARD
          </div>
          <div className="mb-[20px]">
            <CardPreview name={built.name} desc={built.prompt} />
          </div>
          <div className="mb-[14px] font-mono text-[11px] tracking-[0.06em] text-ink-faint">
            OPENAPI
          </div>
          <p className="m-0 border border-hairline bg-raised p-[14px] font-mono text-[11.5px] leading-[1.6] text-ink-muted">
            the generated openapi spec is served on your{" "}
            <a href={`/resources/${built.resourceId}`} className="text-blue hover:underline">
              resource page
            </a>{" "}
            once the build finishes.
          </p>
        </aside>
      ) : null}
    </div>
  );
}
