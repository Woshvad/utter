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
import {
  validateComposeSpec,
  type ComposeFieldErrors,
} from "../validation/compose.js";
import { Composer } from "../components/build/Composer.js";
import { BuildStream } from "../components/build/BuildStream.js";
import { CardPreview } from "../components/detail/CardPreview.js";
import { OpenApiPreview } from "../components/detail/OpenApiPreview.js";

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

/** The action result the screen renders: either field errors or the created ids. */
export type CreateActionData =
  | { ok: false; errors: ComposeFieldErrors }
  | { ok: true; resourceId: string; eventsUrl: string };

export async function action({ request }: ActionFunctionArgs): Promise<CreateActionData> {
  // Access gate (CR-01 / T-06-PRIVESC): an unauthenticated request must NOT reach
  // adapter.createResource. requireCreator throws redirect(/auth) for a document
  // navigation or a 401 for a data/fetch request, so anon can never mint a resource.
  await requireCreator(request);

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

  const { resourceId, eventsUrl } = await adapter.createResource(validation.spec);
  return { ok: true, resourceId, eventsUrl };
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

  // The prompt the creator submitted (mirrored back from the navigation form data
  // while submitting; preview-only, never re-derives money or security state).
  const submittedPrompt =
    typeof navigation.formData?.get("prompt") === "string"
      ? (navigation.formData.get("prompt") as string)
      : undefined;
  const previewName = slugFromPrompt(submittedPrompt);

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
              liveName={previewName}
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

      {/* right preview aside - appears once a build has started (comp 344-360) */}
      {built ? (
        <aside className="w-[360px] flex-none border-l border-hairline bg-canvas p-[24px]">
          <div className="mb-[14px] font-mono text-[11px] tracking-[0.06em] text-ink-faint">
            AGENT CARD
          </div>
          <div className="mb-[20px]">
            <CardPreview name={previewName} desc="scores tweet sentiment, -1..1" />
          </div>
          <div className="mb-[14px] font-mono text-[11px] tracking-[0.06em] text-ink-faint">
            OPENAPI
          </div>
          <OpenApiPreview snippet="POST /v1/score
  body:
    text: string
  200:
    score: number  // -1..1
    label: string
    confidence: number" />
        </aside>
      ) : null}
    </div>
  );
}
