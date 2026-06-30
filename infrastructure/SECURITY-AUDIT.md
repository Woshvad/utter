# Utter security audit (consolidated)

Date: 2026-06-30
Scope: full repository, post PR #1 through PR #21. Focus per SPEC section 19: the
money path, sandbox isolation, on-chain surfaces, secrets, supply chain, and the
web-app (OWASP) surfaces.
Status: testnet code, production-bound. Arc Testnet, chainId 5042002.

This audit was run as a multi-agent find then adversarially-verify sweep. Every
candidate finding was independently re-checked against the code before being
admitted here, so the list below is confirmed issues, not raw model output. The
audit itself changed no code; the remediation that followed is recorded below.

## Remediation status (2026-06-30): ALL CONFIRMED FINDINGS FIXED + MERGED

Every confirmed finding plus the latent treasury hardening was fixed on its own
branch, tested, adversarially reviewed, and merged to master (tip `34945fe`). Each
fix kept the money path, escrow gate, sandbox isolation, and contracts byte-unchanged,
added no new dependency, and changed no `.sol` file.

| Finding | Severity | PR | Fix |
|---------|----------|----|-----|
| H1 data-proxy SSRF via redirect | HIGH | #22 | `redirect: "manual"`; a 3xx is relayed, never auto-followed |
| H4 buyer-sdk payTo not bound | HIGH | #23 | `CardPayToMismatch` binds discovered `payTo` to the intended resourceId |
| M2 buyer budget unbounded default | MEDIUM | #23 | stderr warning at MCP boot when a cap dimension is unbounded |
| H4-twin marketplace payTo not bound | HIGH (latent) | #24 | publish asserts `card.x402.payTo === resourceId` before persist |
| L1 marketplace `BigInt()` 500 | LOW | #24 | query params validated against `^[0-9]+$` -> 400 |
| H2 reserved-slug clobber | HIGH | #25 | `RESERVED_SLUGS` denylist in `validateSlug` + studio `deriveSlug` fallback |
| H3 studio dashboard IDOR | HIGH | #26 | loader scoped to the authed creator; zero-owned-resources residual leak also closed |
| M1 staking slash liveness | MEDIUM | #27 | slash split into record/execute over the dispute window; refund idempotency store required |
| Latent treasury (FX/CCTP) | latent | #28 | swap slippage bound + decimals-equality assert + CCTP replay dedup |

Post-merge sweep on master was green: data-proxy 113, buyer-sdk 63, marketplace 118,
deployer 240, staking 45, treasury 36, chain 23, studio 417 (1 skip).

Not remediated by choice: the two CONTESTED LOW facilitator spend-cap accounting
items (L2, L3 below) remain as documented behavior. They are opt-in, default-off,
self-healing, and never cause fund loss; their fix is an optional calibration change.

## How to read this

- A finding is CONFIRMED when two independent verifiers (or one verifier plus a
  direct re-read recorded here) traced the exploit against the code and could not
  refute it.
- CONTESTED means one verifier confirmed it and one downgraded it; these are real
  code properties whose severity depends on configuration. They are kept for
  transparency and listed at their lower assessed severity.
- REFUTED findings (16 of them) were dismissed with reasons and are summarized at
  the end so the negative results are auditable rather than silent.
- LATENT means the code property is real but lives in unwired Phase-8 scaffolding
  with no production caller today. These are pre-wiring hardening items, not
  reachable vulnerabilities.

## Coverage

Fourteen scoped targets were audited. Three finders produced a degenerate output
on the first run and two on the second (oversized structured output); each was
re-run, and the two largest (studio, buyer-sdk) were finished as direct prose
audits with self-refutation. Final coverage:

| Target | Covered | Result |
|--------|---------|--------|
| PaymentEscrow + PaymentSplitter (Solidity) | yes | sound |
| Registry / Vault / Identity / Reputation / Validation (Solidity) | yes | sound; design-tradeoff nits only |
| Facilitator money path (verify / settle / release / relayer) | yes | sound; 2 opt-in spend-cap nits |
| x402-arc + chain (codec / metering / EIP-712 / decimals) | yes | sound |
| Sandbox isolation (gVisor / firewall / prepublish / caps) | yes | sound; scan is heuristic by design |
| Data-proxy egress broker | yes | 1 HIGH (SSRF via redirect) |
| Deployer + orchestrator + infrastructure | yes | 1 HIGH (slug overwrite) |
| Marketplace app | yes | 1 LOW + 1 latent payTo gap |
| Studio app (auth / IDOR / secrets) | yes | 1 HIGH (cross-tenant disclosure) |
| Secrets + supply chain | yes | sound |
| Off-chain staking drivers | yes | 1 MEDIUM (slash liveness) |
| Treasury (FX / CCTP) | yes | latent only (unwired) |
| Buyer SDK + MCP | yes | 1 HIGH (payTo) + 1 MEDIUM (budget) |
| Cross-service trust + key custody + core TOCTOU | yes | sound |

## Executive summary

No critical findings. The core money path held up under independent review: the
escrow response gate, reserve-before-run, exactly-once settle, metered ceiling
(debit = min(computed, cap)), on-chain single-use nonce and replay protection, the
70/30 split, and the runtime-decimals discipline are all correctly enforced, with
the on-chain `usedNonce` plus balance underflow as the final backstop behind the
off-chain layer.

Four HIGH findings are confirmed. None is direct theft from the platform escrow:
two are availability/integrity of the control plane, one is cross-tenant read
disclosure, and one is bounded payment misdirection on the buyer side. There is a
cross-cutting theme worth fixing as one piece: the buyer's payment recipient
(`payTo` / `resourceId`) is not bound to the resource the buyer intended to pay.

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | HIGH | Data-proxy follows HTTP redirects, bypassing every SSRF/allowlist guard | `packages/data-proxy/src/proxy.ts:337` |
| 2 | HIGH | Creator-chosen slug overwrites operator Traefik router files (control-plane DoS) | `services/deployer/src/orchestrate.ts:558`, `traefik-config.ts:87` |
| 3 | HIGH | Studio dashboard leaks every creator's revenue and settlement hashes | `apps/studio/app/routes/dashboard.tsx:83` |
| 4 | HIGH | Buyer SDK does not bind a discovered card's `payTo` to the intended resource | `packages/buyer-sdk/src/discover.ts:119` |
| 5 | MEDIUM | Off-chain slash submits authorize+slash back-to-back; every live slash reverts | `packages/staking/src/slash.ts:138` |
| 6 | MEDIUM | Buyer budget caps default to unbounded (denial-of-wallet amplifier) | `packages/buyer-sdk/src/mcp/budget.ts:32` |
| 7 | LOW | Marketplace `BigInt()` on an unvalidated query param throws a 500 | `apps/marketplace/src/server.ts:252` |

Plus two CONTESTED (assessed LOW) spend-cap accounting items and one LATENT
marketplace `payTo` gap (the seller-side twin of #4), described inline.

---

## HIGH findings

### H1. Data-proxy follows HTTP redirects, bypassing every SSRF/allowlist guard

- Location: `packages/data-proxy/src/proxy.ts:337-350`; pin context `packages/data-proxy/src/pin-dispatcher.ts:86-96`
- Category: SSRF / isolation (SPEC section 19 default-deny egress)
- Status: CONFIRMED (2 of 2 verifiers, neither could refute)

The outbound forward in `/proxy` builds its fetch init with method, headers, body,
and signal but never sets `redirect: "manual"` or `"error"`, so the platform
default `redirect: "follow"` applies. Every SSRF guard in the route (the synchronous
allowlist plus block-set check, the host-equality check, the resolve-and-recheck of
every A/AAAA record, and the optional socket pin) runs only against the first-hop
URL. When an allowlisted upstream returns a 3xx, `fetch` transparently follows the
`Location` with fresh DNS and a fresh connection, and none of those checks re-run.
The socket pin that would partially mitigate is inactive by default because `undici`
is intentionally not a dependency of this package, so `defaultPinningDispatcherFactory`
returns undefined and the forward runs unpinned.

The data-proxy's own outbound position is not behind the sandbox egress firewall
(that firewall constrains the untrusted container netns, a different process), so a
redirect to `http://169.254.169.254/` (cloud metadata), loopback, or an RFC1918
host reaches its target from the trusted proxy. The injected upstream
`Authorization: Bearer` rides the redirect, and the redirect-target response is
relayed back to the untrusted caller.

Exploit: a creator allowlists an upstream they control (or a compromised
allowlisted upstream). The sandboxed container calls `/proxy` with a valid scoped
token; all first-hop guards pass; the upstream answers `302 Location:
http://169.254.169.254/latest/meta-data/iam/security-credentials/`; the proxy
follows it and returns the metadata response (IAM credentials) to the container.

Fix: set `redirect: "manual"` (or `"error"`) in the forward init. If redirects must
be supported, handle 3xx explicitly with a hop cap and re-run the full guard chain
(allowlist, normalize-and-check, resolve-and-check, host-equality, re-pin) on each
`Location`. Do not rely on the undici pin as the redirect defense, since it is not a
dependency and is inactive by default. Add a regression test that an upstream 302 to
`169.254.169.254` and to `127.0.0.1` is not followed.

### H2. Creator-chosen slug can overwrite operator Traefik router files

- Location: `services/deployer/src/orchestrate.ts:558-578` (write), `services/deployer/src/traefik-config.ts:87-96` (validateSlug), `apps/studio/app/adapter/live.ts:101-109` (deriveSlug)
- Category: config injection / availability / integrity
- Status: CONFIRMED (2 of 2 verifiers)

`validateSlug` enforces only the character class `^[a-z0-9-]+$` with no reserved-name
denylist. `writeTraefikDynamicFile` writes the per-resource router to
`<dynamicDir>/<slug>.yml`, and the default dynamic dir resolves to
`infrastructure/traefik/dynamic`, the same directory that holds the operator's
hand-maintained `studio.yml` and `marketplace.yml` (the `Host(app.utter.technology)`
and `Host(marketplace.utter.technology)` routers). Those files even document in
comments that `studio` and `marketplace` must not be used as a slug, but nothing
enforces it. The studio derives the deploy slug directly from the creator's
free-text prompt (lowercase, non-alphanumerics to hyphens) with no reserved check,
then POSTs it as the trusted slug. The M5 slug-uniqueness store only dedups resource
deployment records by resourceId; it does not know about operator file names.

Exploit: an unprivileged creator submits the prompt "marketplace price feed".
`deriveSlug` returns `marketplace`. The studio POSTs it; bearer auth and the bundle
gate pass; `validateSlug("marketplace")` passes; the deploy atomically renames
`marketplace.yml` over the operator file. Traefik's file provider hot-reloads;
`Host(marketplace.utter.technology)` stops resolving, breaking agent discovery.
Repeating with "studio ..." takes down the operator dashboard at app.utter.technology.

This is a control-plane denial of service and an integrity violation of
operator-managed config, triggered by untrusted input through the normal create
flow. It is HIGH rather than critical because it does not touch the money path and
requires the live operator-provisioned deploy chain to be armed.

Fix: add an explicit reserved-slug denylist (at minimum `studio`, `marketplace`, and
any other operator dynamic-file basename) rejected at the deployer boundary in
`validateSlug` and in the studio `deriveSlug`, so it fails closed in both places.
Better still, namespace generated router files (for example `resource-<slug>.yml`) or
write them to a separate watched directory so they can never collide with operator
files.

### H3. Studio dashboard leaks every creator's revenue and settlement hashes

- Location: `apps/studio/app/routes/dashboard.tsx:83` (address discarded), `:119-146` (platform-wide aggregation), `:169-174` (totals)
- Category: authorization / IDOR / cross-tenant disclosure
- Status: CONFIRMED (studio audit + direct re-read recorded here)

The dashboard loader calls `await requireCreator(request)` but discards the returned
address; it gates anonymous versus authenticated and scopes nothing to the specific
creator (the in-code comment confirms the mental model was anon-versus-authenticated
only). It then calls `adapter.listMarketplace({})` with an empty filter, which
returns every resource platform-wide (the marketplace `FilterCriteria` has no
owner field), and for each card reads `adapter.getRevenue(card.resourceId)`,
summing `creatorShare` and `calls` and collecting `receipts` (on-chain settle/refund
tx hashes and idemKeys). The same data feeds the totals and the PayoutHistory
"money in" ledger.

Exploit: any creator who completes the free SIWE login opens `/dashboard`. In live
mode (`STUDIO_DATA_ADAPTER=live`) the earnings, total calls, per-resource revenue
rows, and the settlement ledger render the entire platform's data, not the viewer's
own. A competitor reads every other creator's revenue, call volume, and settlement
transaction hashes.

This is read-side disclosure, not theft: fund movement (withdraw, bond reclaim,
deposit) is signed in the user's own wallet and enforced on-chain by `msg.sender`,
so the studio holds no spending authority. Impact requires the operator-gated live
adapter; the default fixture backend serves a fixed demo dataset, which is why this
is HIGH and not critical.

Fix: scope the aggregation to resources owned by the authenticated creator. Because
`ResourceCardData` has no `creator` field, this needs the same per-card owner check
that `creators.$address.tsx` already performs via `getResourceDetail`, compared
case-insensitively against the address `requireCreator` returns (currently thrown
away). The PayoutHistory "money in" side inherits the fix automatically.

### H4. Buyer SDK does not bind a discovered card's payTo to the intended resource

- Location: `packages/buyer-sdk/src/discover.ts:119-135`, signed at `packages/buyer-sdk/src/client.ts:271-289`; index path `packages/buyer-sdk/src/mcp/live-discovery.ts:154`
- Category: money-path / payment misdirection
- Status: CONFIRMED (buyer-sdk audit + corroborated by the pass-1 marketplace verifiers, who independently noted the identical behavior in the same code)

`discover` validates the card-supplied `payTo` only as a well-formed bytes32; it
never checks that `payTo` equals the `resourceId` the caller asked to pay.
`client.pay` then signs the DebitAuthorization with `resourceId: cardInputs.payTo`
taken straight from the card. On-chain, `PaymentEscrow.debit` does
`registry.getResource(resourceId)` and routes the buyer's funds to whatever
creator/treasury that `resourceId` maps to. The two pinned fields (escrow, asset)
are correctly forced to the canonical constants, which blocks redirecting to a fake
escrow, but `payTo`/`resourceId` is the recipient selector and it is fully
attacker-chosen within the canonical escrow.

Exploit: an attacker registers their own real, active resource `R_attacker` whose
split points at them, then serves a poisoned agent card for a desirable-looking
endpoint where everything validates but `x402.payTo = R_attacker`. The buyer's agent
discovers it (by `cardUrl`, or a malicious row in a discovery source), the card
passes `validateAgentCard` and the escrow/asset pin, and `pay` signs a debit for
`R_attacker`. The escrow debits the buyer's reserved cap and credits the attacker.
The buyer paid the attacker for a call they believed was going to a different
creator.

This is theft-by-misdirection of a bounded amount (the per-call signed cap still
limits the loss, and funds land in the platform escrow, not an arbitrary EOA), which
is why it is HIGH and not critical. There is a design nuance: in the pure `cardUrl`
path the card defines the resource being paid, so there is no independent resourceId
to compare against. The clean fix is in the `{ resourceId }` discovery path.

Fix: in the `{ resourceId }` path, assert `payTo` equals `ref.resourceId`
(case-insensitive bytes32 compare) and refuse to pay on mismatch. In the `{ cardUrl }`
path, return the resolved `payTo` to the caller and require the MCP/endpoint-tool
layer to bind it to the resource the agent actually selected, rather than trusting
whatever the fetched card asserts. See the payTo-binding theme below.

---

## MEDIUM findings

### M1. Off-chain slash submits authorize then slash back-to-back; every live slash reverts

- Location: `packages/staking/src/slash.ts:138-161`; contract coupling `contracts/src/ResourceRegistry.sol:233-271`, `contracts/src/StakingVault.sol:180-193`
- Category: correctness / money-path liveness
- Status: CONFIRMED (2 of 2 verifiers)

`slash.ts` documents `slashAuthorization` as an advisory indexer event with no shared
on-chain state, and `triggerSlash` calls `slashAuthorization` then `StakingVault.slash`
in one synchronous sequence. The deployed contracts contradict that: the registry
records a `PendingSlash` with `executableAt = now + SLASH_DISPUTE_WINDOW` (1 day), and
`StakingVault.slash` calls `consumeSlashAuthorization`, which reverts `SlashWindowActive`
while `block.timestamp < executableAt`. Because the authorization was recorded moments
earlier in the same call, the window cannot have elapsed, so the second write always
reverts on a live chain. The unit tests use a mock admin that never reverts, so the
suite stays green while the live slash path is non-functional.

Impact: a genuinely malfunctioning resource's bond can never be slashed via this
driver, leaving the insurance pool unfunded and the takedown loop ineffective, plus a
dangling pending authorization. This is a liveness break, not loss of funds; the
on-chain dispute window itself correctly enforces the safety invariant. The stale
NatSpec also actively misleads maintainers into thinking the two contracts are
decoupled.

Fix: split `triggerSlash` into a record step and a separate execute step invoked only
after `SLASH_DISPUTE_WINDOW` elapses, gating the execute on a `getPendingSlash` read
confirming `executableAt <= now` and the amount matches. Update the `slash.ts` NatSpec
to describe the real on-chain coupling, and add a test using a stub that reverts
`SlashWindowActive` when the window has not elapsed.

### M2. Buyer budget caps default to unbounded (denial-of-wallet amplifier)

- Location: `packages/buyer-sdk/src/mcp/budget.ts:32-37,134-152`; ceiling default `packages/buyer-sdk/src/client.ts:174-175`
- Category: denial-of-wallet / configuration safety
- Status: CONFIRMED (buyer-sdk audit, self-refuted)

`readBudgetCapsFromEnv` returns undefined for any unset or blank
`MCP_PER_TOOL_CAP_BASE_UNITS` / `MCP_PER_DAY_CAP_BASE_UNITS`, and `reserve` skips a
dimension entirely when its cap is undefined. The buyer per-call ceiling
`maxCapTokens` likewise defaults to null (unbounded). So in the default configuration
there is no soft cap at all: the only bound on a single call is whatever the card
advertises as `pricing.max`, limited only by the deposit sanity ceiling (1,000,000
whole tokens) and the escrow balance.

Impact: an operator who deposits USDC and runs the MCP server with defaults lets a
hostile or compromised discovered card set a large `pricing.max`; the budget guard
admits it and `pay` signs it. This compounds H4: a steered debit can also be a large
one. The per-call signed cap is a real hard bound, but it is taken from the card when
no buyer ceiling exists, so it does not protect against a hostile card.

Fix: ship safe non-infinite defaults (a conservative per-tool and per-day cap and a
default `BUYER_MAX_CAP_TOKENS`) requiring explicit opt-out, or at minimum emit a
stderr warning at boot when any cap dimension is unbounded.

---

## LOW findings

### L1. Marketplace BigInt() on an unvalidated query param throws a 500

- Location: `apps/marketplace/src/server.ts:251-254`
- Status: CONFIRMED (2 of 2 verifiers)

The public, unauthenticated `GET /resources` passes `minBond` and `maxBasePrice`
straight into `BigInt(...)` with no validation and no surrounding try/catch, and the
app registers no global error handler. `GET /resources?minBond=abc` throws a
`SyntaxError` and returns a generic 500 instead of a clean 400. Per-request only, no
data exposure, no process crash.

Fix: validate the query strings against `^[0-9]+$` before `BigInt()` and return 400 on
a malformed value, mirroring the base-unit-integer guards already used in the buyer
readers.

### L2 (CONTESTED, assessed LOW). Spend-cap hold never refunded on release

- Location: `services/facilitator/src/app.ts:300-364`, `services/facilitator/src/spend-cap-gate.ts:84-115`
- Status: CONTESTED (one verifier real-LOW, one not-a-bug)

When the optional per-payer spend cap is armed, `/verify` records a hold at the full
signed cap, but only the reserve-rejected path refunds it. A malfunction, timeout,
declared error, or settle failure drives `/release`, which never refunds the hold, so
a buyer charged 0 on-chain still has their rolling-24h cap consumed at the full cap.
After enough no-charge failures the buyer is denied `over_cap` on legitimate calls.
Both verifiers agree this is opt-in (default off), self-healing (the hold ages out of
the 24h window), and has no fund loss; the disagreement is whether the cap should
track authorized exposure or settled spend. Reported at LOW.

Fix (optional): refund the hold on every non-charge terminal outcome, and reconcile it
down to the actual `min(computed, cap)` debit on success.

### L3 (CONTESTED, assessed LOW). Spend-cap hold counts the signed cap, not the metered debit

- Location: `services/facilitator/src/app.ts:304`, never reconciled at settle
- Status: CONTESTED (one verifier real-LOW, one not-a-bug)

The hold is recorded at the buyer's signed cap, which for metered pricing is a
worst-case ceiling far above the actual debit, and is never adjusted down at settle.
The rolling-24h window therefore accumulates signed caps rather than real USDC spend,
so a buyer signing generous caps is denied far below their intended USDC budget. Opt-in,
default off, no on-chain over-charge (the contract ceiling holds). Reported at LOW. Same
fix as L2.

---

## The payTo-binding theme (fix as one piece)

Two findings share a root cause: the buyer's on-chain payment recipient
(`resourceId`, selected via the card's `payTo`) is not bound to the resource the buyer
intended to pay. The escrow and asset are pinned to canonical constants everywhere, but
the recipient selector is not.

- Buyer side (H4, reachable): `packages/buyer-sdk/src/discover.ts` accepts any
  well-formed `payTo` from a discovered card and signs it.
- Seller side (LATENT): the marketplace publish pipeline persists the supplied card
  under `req.resourceId` without asserting `card.x402.payTo === req.resourceId`
  (`apps/marketplace/src/publish.ts`, `card-route.ts`), and the strict buyer reader in
  `apps/marketplace/src/test-endpoint.ts` pins escrow/asset but only shape-checks
  `payTo`. This is latent today because the only publisher is the trusted studio, which
  always sets `payTo = resourceId`; it becomes reachable the moment a second publisher
  path exists.

Recommended single fix: bind `payTo` to the resource at every trust boundary. Reject a
card whose `payTo` does not equal the resourceId it is published or discovered under,
in the publish pipeline, in the buyer `{ resourceId }` discovery path, and in any
endpoint-test reader. Where a pure `cardUrl` flow has no independent resourceId, surface
the resolved `payTo` to the caller for explicit confirmation rather than trusting it.

---

## Latent hardening (unwired Phase-8 scaffolding)

These are real code properties in `packages/treasury` and `packages/staking` that have
no production caller today (confirmed by repo-wide grep). They are not reachable now;
fix them before wiring these modules into a live money path.

- Treasury EURC payout has no min-out / slippage bound and does not reconcile the live
  swap return against the quote (`packages/treasury/src/payout-router.ts:91-100`). The
  live adapter currently throws, and the mock is identity, so unreachable today.
- The USDC to EURC base-unit identity transform assumes both tokens are 6dp and does not
  read and compare `decimals()` of both at runtime (`payout-router.ts`,
  `stablefx-adapter.ts`). Add an explicit `decimals(USDC) == decimals(EURC)` assertion
  before any base-unit identity payout. This is the 6dp/18dp class of bug the spec warns
  about, latent here only because both tokens are pinned 6dp on testnet.
- CCTP escrow credit has no per-message nonce, dedup, or persisted idempotency, and
  `assertSignedAttestation` checks only hex shape, not the Iris signature
  (`packages/treasury/src/cctp-funder.ts:180-239`). On-chain MessageTransmitter replay
  protection plus the `mintedAmount <= burn` guard contain double-credit today, and the
  module is unwired; add attestation verification and idempotency before going live.
- `executeRefund` defaults to a fresh in-memory idempotency store and `StakingVault.refund`
  has no on-chain replay guard, so a production caller that forgets to inject the durable
  store would have no cross-process replay protection on insurance-pool refunds
  (`packages/staking/src/refund.ts`). Unwired today; make the durable store mandatory in
  the production wiring.

---

## Confirmed sound (evidence-backed negatives)

The audit positively verified these, so the small finding count is a result, not a gap.

Money path and contracts:
- Escrow response gate debits only after a success classification and releases plus
  strikes on malfunction/timeout/settle-failure; declared-error versus malfunction is
  distinguished (`packages/x402-arc/src/gate.ts`).
- Reserve-before-run: `/verify` recovers signer equals buyer, checks resource match,
  expiry, available balance, and a free nonce, then reserves before the handler runs
  (`services/facilitator/src/verify.ts`).
- Exactly-once: result-cache short-circuit plus on-chain `NonceUsed` rebuild plus
  persist-before-respond plus a reserve-precedes-settle 409 guard
  (`services/facilitator/src/settle.ts`, `app.ts`).
- Metered ceiling: `min(computed, cap)` with `MAX_RESPONSE_BYTES` on the size term, and
  the contract re-enforces `amount <= maxAmount` (`packages/x402-arc/src/metering.ts`,
  `contracts/src/PaymentEscrow.sol`).
- PaymentEscrow: ReentrancyGuard plus strict CEI on deposit/withdraw/debit, single-use
  on-chain nonce, withdraw strictly `msg.sender`-scoped pull payment, OZ ECDSA
  (malleability-safe), EIP-712 domain binds chainId plus verifying contract, split
  conserved exactly and fuzz-tested.
- Access control: SLASHER vs TREASURY_ADMIN vs REGISTRY_ADMIN role split, single-use
  `PendingSlash` consumed once over a 1-day dispute window with exact-amount match,
  `SlashExceedsBond` / `OverRefund` bounds, 7-day withdraw cooldown that still permits
  slash (no withdraw-to-dodge), and a 2-step non-brickable DEFAULT_ADMIN via
  AccessControlDefaultAdminRules.
- Decimals: every USDC amount path reads `decimals()` at runtime; no `1e6`/`6`/`18`
  money literal in any in-scope money math.

Isolation and secrets:
- Untrusted code runs under runsc/gVisor with read-only rootfs, CapDrop ALL, no CapAdd,
  no-new-privileges, never privileged or host-net, empty env, and network none; the
  data-proxy is the sole egress and the host-side firewall is default-drop. The
  prepublish import/secret scan is a documented heuristic, not the boundary (the
  boundary is gVisor plus the firewall plus the runtime egress probe).
- Service env into the untrusted container is a closed allowlist plus a secret
  name/value-shape/entropy denylist; no secret is injected into the resource container.
- Secrets live only in gitignored and dockerignored `.env.local`; the four first-party
  Dockerfiles install `--frozen-lockfile` with no build-arg secrets; the logger redacts
  via a deny-by-default field allowlist; no private keys, mnemonics, or auth secrets are
  in tracked files; only `VITE_WALLETCONNECT_PROJECT_ID` (a public id) reaches the client.
- Production config fails closed: `resolveAuthConfig`, `resolveFacilitatorStores`,
  `resolveBuyerLock`, `resolvePayerScreen`, and the studio `SESSION_SECRET` resolver all
  throw without their required secret in production.
- Cross-service secrets are distinct with least privilege; the relayer key is escrow
  debit-only; register/pause is REGISTRY_ADMIN; slash is SLASHER coupled through the
  vault. The off-chain layer cannot author money values (the split is read on-chain from
  `registry.getResource`).

Studio and buyer:
- Studio session cookie is httpOnly, secure, sameSite lax with rotation-capable HMAC
  secrets; SIWE uses a server-issued single-use nonce bound to the session; the auth POST
  has a same-origin check; no `dangerouslySetInnerHTML`/`eval`; API keys are CSPRNG,
  stored hashed, constant-time compared, shown once; `requireResourceOwner` enforces
  per-resource ownership with a case-insensitive 403.
- Buyer key stays in the client closure, is never returned or logged; all diagnostics go
  to stderr and dotenv is loaded quiet so the stdio JSON-RPC channel is not corrupted;
  reserve-before-pay has no TOCTOU; nonce is 32-byte CSPRNG reused as the idemKey with
  GET-by-idemKey recovery and no re-sign; runtime decimals throughout.

---

## Considered and refuted (summary)

Sixteen candidate findings were dismissed after verification. The notable ones:

- Sub-cent batch settlement cross-buyer charging: unreachable; `batchSettler` is never
  constructed in production, the batch path needs operator-authored `buildBatchPayment`.
- Hardcoded EIP-712 chainId literals: maintainability nit; all literals equal the live
  chain id on testnet and the only divergence path is a future operator migration error.
- `decodePayment` not pinning `x402Version`: harmless; the field is not signed and changes
  no trust decision.
- Quota counter monotonic; dev credential fixtures; in-memory revenue ledger: all
  fail-closed or unwired, no reachable harm.
- Takedown leaves a delisted resource in the discovery index: discovery is display-only;
  the on-chain `pause` (which reverts `debit` with `ResourceInactive`) is the real
  enforcement boundary, so no buyer can be charged for a taken-down resource.
- Unbounded `GET /resources` (pagination TODO), keyword moderation bypass (documented
  design with operator takedown), no per-creator publish authz (single trusted
  control-plane), no CI frozen-lockfile gate (the Dockerfile is the gate): all
  defense-in-depth or by-design, not reachable.
- Contracts: sticky `bondOwner` (deliberate anti-seizure), off-chain N-strikes (no oracle
  possible; contained by role split plus dispute window), permissionless identity mint (no
  fund impact; the split is REGISTRY_ADMIN-gated): documented tradeoffs.
- Sandbox import-scan bypass and unbounded log read: the scan is a heuristic behind gVisor
  plus the firewall, and `logs()` has no production caller.
- Treasury/staking/CCTP exactly-once and over-credit items: real properties but unwired
  (see Latent hardening).
- Non-expiring sidecar token, single shared marketplace bearer, per-process verify lock:
  intentional/fail-closed-in-prod; the on-chain debit is the backstop.

---

## Limitations

- This audit is static and read-only. It did not run on-chain transactions, build or
  deploy images, or exercise the live gVisor host or a live model call; those are
  operator-side and remain the operator's responsibility per the existing
  `PAYOUT.md` / `MAINNET.md` runbooks.
- Two finders hit the structured-output size cap and were completed as direct prose
  audits; the studio HIGH (H3) was additionally re-verified by direct code read recorded
  in this document.
- Findings reflect the code at this commit. The two HIGH availability findings (H1, H2)
  and H4 are reachable only when the corresponding live path is armed (data-proxy with a
  per-resource allowlist, the operator deploy chain, and the live buyer/studio adapters).

## Suggested remediation order

1. H1 data-proxy redirect (one-line `redirect: "manual"` plus per-hop guards plus a test).
2. H4 plus the marketplace twin as the single payTo-binding fix.
3. H2 reserved-slug denylist or namespaced router files.
4. H3 scope the studio dashboard loader to the authenticated creator.
5. M1 split slash into record/execute phases and fix the NatSpec.
6. M2 safe budget defaults or a boot warning; L1 query validation.
7. Latent hardening before any treasury/staking module is wired live.
