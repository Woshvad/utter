# Live Pay Runbook (studio X-PAYMENT transport)

The studio is now CODE-READY for live per-call payment. The client-side x402 transport
(`apps/studio/app/wallet/submit-payment.ts`, `liveSubmitPayment`) signs an escrow CAP in the
connected wallet, encodes it to an `X-PAYMENT` header, and POSTs it to the deployed resource.
The resource's gate calls the facilitator server-side (reserve, run, validate, settle).

A true end-to-end on-chain payment still needs operator infrastructure. This runbook lists
exactly what to provision. Until it is in place, live mode is fail-loud
(`RequiresLivePaymentError`) and never fakes a network call.

## What the transport already does

- Builds `POST ${resourceUrl}/call` with `{ "Content-Type": "application/json", "X-PAYMENT":
  <signed cap header> }` and a body equal to the same request that triggered the 402.
- Decodes the `X-PAYMENT-RESPONSE` settlement receipt in the browser (base64 JSON) and reads
  the settled base-unit `amount` decimal string into a bigint debit.
- Treats any non-200 (402 verify-fail, 502 settlement/validation, 504 timeout) as NOT paid.
- Sends NO `X-IDEM-KEY` header on the live wire; the idemKey rides inside the X-PAYMENT
  payload as `authorization.nonce` (exactly-once is enforced by the facilitator + the
  recorded-header retry in `usePayPerCall`, never a re-sign).

The run route defaults to `/call` (the buyer-sdk / marketplace canonical). `liveSubmitPayment`
accepts an optional `path` override if a resource exposes a different run route.

## Operator provisioning checklist

1. **Studio in live mode with real cards.** Set `STUDIO_DATA_ADAPTER=live` so the screen
   derives `payMode === "live"`. The resource detail must project a real `cardUrl` of the form
   `https://<slug>.resources.<domain>/.well-known/agent-card.json` so `resourceUrlFromCard`
   yields a real resource origin (`https://<slug>.resources.<domain>`). An empty/placeholder
   cardUrl keeps the submitter fail-loud.

2. **A reachable facilitator with a funded relayer.** Provision `FACILITATOR_URL` pointing at
   the deployed facilitator, and fund its relayer (the escrow-admin signer) with native gas on
   Arc Testnet (chainId `5042002`) so it can submit the on-chain `reserve` + `settle`
   transactions. Never hardcode the money scale; the facilitator reads `decimals()`.

3. **The resource deployed behind the wildcard-TLS resources host.** Deploy the generated
   resource so it is reachable at `https://<slug>.resources.<domain>` and exposes the run route
   (default `/call`; note the override knob above if your resource differs). The host must
   terminate the `*.resources.<domain>` wildcard certificate.

4. **A funded buyer escrow balance.** The connected wallet must have deposited USDC into the
   escrow contract. The browser signs a CAP only; the facilitator debits `min(computed, cap)`
   from the buyer's escrow balance after the response passes the gate. A buyer with no escrow
   balance will get a non-200 (NOT paid) on settle.

5. **The gVisor / Firecracker sandbox host for the handler.** The security model forbids running
   generated handlers outside an isolation boundary (plain Docker is NOT a boundary). The
   resource's handler must run inside the gVisor/Firecracker sandbox with default-deny egress
   through the data-proxy, no secrets in the container, and resource/timeout/size caps. See the
   infrastructure runbook at `infrastructure/RUNBOOK.md` for provisioning the isolation host and
   nested-virt requirements.

## Manual end-to-end test

Once the above is provisioned:

1. Open the studio resource detail for a live-deployed resource.
2. Connect the buyer wallet (the wallet that funded the escrow).
3. Click **run**. With no payment yet, the call returns a 402 and the PaywallSheet mounts.
4. Click **pay**. The wallet pops up to sign the escrow CAP authorization (no key in the app).
5. Expect an HTTP 200 from `https://<slug>.resources.<domain>/call`, an `X-PAYMENT-RESPONSE`
   settlement receipt header, and an on-chain `Debited` split event for `min(computed, cap)`.
   The playground response pane streams the handler body and the metered value shows the
   settled debit.

The on-chain settle protocol itself is already proven against Arc Testnet; see
`contracts/DEPLOYMENTS.md` for the deployed escrow addresses and the proven money-path
reference.

## Money-path invariants (do not regress)

- The browser only submits a SIGNED CAP. Never run a handler against an unreserved
  authorization; the facilitator reserves before the handler runs.
- Exactly-once: a retry re-submits the SAME `X-PAYMENT` header (never a re-sign). The transport
  is a thin forwarder.
- Never log the `X-PAYMENT` header, the signature, the settlement receipt, or the buyer address.
- No money or chain-scale literal in the transport; the debit comes from the receipt decimal
  string, and `decimals()` is read at runtime.
