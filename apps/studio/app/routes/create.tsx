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
import * as React from "react";
import type { ActionFunctionArgs } from "react-router";
import { useActionData, useNavigation } from "react-router";
import { selectAdapter } from "../adapter/select.js";
import { requireCreator } from "../auth/requireCreator.server.js";
import {
  validateComposeSpec,
  type ComposeFieldErrors,
} from "../validation/compose.js";
import { Composer } from "../components/build/Composer.js";
import { BuildStream } from "../components/build/BuildStream.js";

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

// Lazy import keeps the route module loadable in a pure-action unit test without the
// component tree; the screen is a thin Composer + (post-submit) BuildStream.
export default function CreateRoute(): React.ReactElement {
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const built = data && data.ok ? data : null;
  const errors = data && !data.ok ? data.errors : undefined;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-lg p-xl">
      <h1 className="text-display font-display lowercase text-ink">utter a sentence</h1>
      {built ? (
        <BuildStream eventsUrl={built.eventsUrl} />
      ) : (
        <Composer errors={errors} submitting={submitting} />
      )}
    </div>
  );
}
