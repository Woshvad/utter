# Utter

## What This Is

Utter is a no-code platform that turns a plain-English prompt into a *live, paid API that AI agents pay to use per call in USDC*, built natively on **Arc**, Circle's stablecoin L1. A creator describes an endpoint; Utter generates the code, deploys it in an isolated sandbox, verifies it works, gives it an on-chain ERC-8004 identity, lists it in a marketplace with an A2A agent card, and other AI agents discover and pay for it per call. The creator earns the majority of every call. Zero servers, zero billing setup.

It is the **supply side of the agent economy**: x402 solved *how* agents pay; Utter is a factory for *what they buy*. One-liner: *you utter a sentence; you get a paid API.*

Audience: (A) creators/vibe-coders who want a priced URL in under two minutes, (B) agent operators whose agents deposit USDC once and then discover + pay per call with no API keys or humans, and (C) the platform operator (the builder) who earns a cut of every call.

## Core Value

A creator describes an API in one sentence and gets a live endpoint that AI agents autonomously pay for per call in USDC — with payment debited **only after the response passes validation** (the escrow response gate). If everything else fails, the prompt-to-paid-API loop with safe on-chain settlement must work.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — greenfield. Ship to validate.)

### Active

<!-- Current scope. Full spec, all phases 0-8. Hypotheses until shipped. -->

- [ ] Chain foundation: connect a wallet and read USDC on Arc Testnet via Viem (`packages/chain`)
- [ ] On-chain contracts: `PaymentEscrow`, `PaymentSplitter`, `ResourceRegistry`, `StakingVault` deployed + Foundry-tested
- [ ] Payment layer: `packages/x402-arc` (escrow scheme primary, `exact`/EIP-3009 flat fallback, optional Permit2) + self-hosted facilitator (`/verify` reserve, `/release`, `/settle` debit, relayer nonce pool)
- [ ] Escrow response gate: reserve → run → validate → debit ≤ cap; malfunction/timeout never debits and records a strike
- [ ] Metered pricing: `debit(min(computed, signedCap))`; charge ≤ buyer-signed cap
- [ ] Idempotency / exactly-once: idempotent `/settle`, persisted `(idemKey → result)`, `GET /results/:idemKey` retrieval without re-pay
- [ ] Sandbox isolation: gVisor/Firecracker runner + default-deny egress firewall + secret isolation + resource/timeout/size caps (`services/sandbox`)
- [ ] Deploy pipeline: build → sandboxed run → Traefik wildcard TLS subdomains → x402 injection → response cache (`services/deployer`)
- [ ] AI generation runtime: prompt → bundle (`handler`, `Dockerfile`, `openapi.json`, `agent-card.json`, `test-cases.json`) via bolt.diy fork + Claude Agent SDK (`packages/ai-runtime`)
- [ ] AI scorer: schema/latency/correctness probes, rolling health, 5-strike deactivation (`packages/ai-scorer`)
- [ ] ERC-8004 identity + reputation registered on Arc per resource (`packages/erc8004`)
- [ ] Marketplace + A2A agent cards: discovery, pricing, reputation, bond, "test this endpoint" sandbox (`apps/marketplace`, `packages/agent-card`)
- [ ] Creator staking bond + slashing + insurance refunds (`contracts/StakingVault.sol`, `packages/staking`)
- [ ] Premium data proxy: allowlisted, keyless upstream egress (also the only sandbox egress) (`packages/data-proxy`)
- [ ] Moderation: pre-publish classifier + takedown path (registry pause + sandbox kill + delist)
- [ ] Studio web app: compose, live deploy log, resource detail, revenue dashboard, SIWE (`apps/studio`)
- [ ] Reference buyer SDK + MCP server so real agents pay on day one (`packages/buyer-sdk`)
- [ ] Post-MVP (Phase 8): orchestrator + scale-to-zero, Gateway nanopayment batching, EURC payouts (StableFX), CCTP funding, data-proxy quotas, per-payer spend caps

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Token / tokenomics module — documented as a future App Kit Swap buyback router only; keep the platform cut in USDC/EURC. The spec (§9.16) says do not build it.
- Arc mainnet deployment — Arc is testnet-only; build on Arc Testnet (chain `5042002`) and re-pin all §6 addresses before any mainnet move.
- Chain portability — Utter deliberately exploits Arc-native properties (USDC as gas, sub-second finality, Gateway nanopayments, ERC-8004); it is not designed to be chain-agnostic.
- Running a handler against an unreserved (bare EIP-3009) authorization — the free-compute / settle-after-run vector. Funds must be pre-locked first.

## Context

- **Greenfield with an authoritative spec.** The build-ready engineering spec lives at `Utter-SPEC.md` (project root); UI design assets live in `Design/` (`UTTER-UI-DESIGN-PROMPT.md`, HTML mockups). No source code exists yet.
- **Spec is the source of truth.** Requirements and roadmap mirror the spec's component specs (§9) and phased Build Plan (§20, Phases 0–8). The spec's per-phase Definitions of Done become success criteria.
- **Settlement model is load-bearing.** The escrow-balance scheme (§9.4) is the corrected core: vanilla EIP-3009 cannot do metering or the response gate (it transfers exactly the signed value and does not lock funds). Build the escrow scheme first; do not regress to bare EIP-3009 for metered or gated calls.
- **Highest-risk subsystem is untrusted code execution (§9.5).** Utter runs arbitrary AI-generated code as public, money-handling internet services. Plain Docker is not a security boundary — microVM/gVisor isolation, default-deny egress via the data-proxy, and no secrets in containers are mandatory, not optional.
- **Tooling.** Remix + React + TypeScript frontend; Claude Agent SDK orchestration (bolt.diy-style harness); Docker + microVM/gVisor + Traefik; Node/TS backend; Postgres + Redis; Foundry for contracts; Viem as the chain client throughout; self-hosted x402 facilitator derived from `circlefin/arc-nanopayments`.
- **`[VERIFY]` items exist.** Several spec facts (Arc USDC EIP-3009 support + EIP-712 domain, x402 network identifier `eip155:5042002`, ERC-8004 registry ABI/addresses on Arc, Circle Programmable Wallets/Gateway on Arc, sandbox host support) must be confirmed against live docs before being relied on. Per-phase research resolves these.

## Constraints

- **Tech stack**: pnpm monorepo per §17 (apps/, services/, packages/, contracts/). Remix/React/TS front, Node/TS services, Foundry/Solidity contracts, Viem chain client — fixed by the spec.
- **Chain**: Arc Testnet only, chain ID `5042002`. USDC `0x3600…0000` is both the 6-decimal ERC-20 *and* the 18-decimal native gas token — always read `decimals()`, never hardcode, never mix the two.
- **Dev environment**: builder is on Windows 11. Build and test locally via **WSL2 + Docker Desktop**; a real Linux isolation host (gVisor/Firecracker + nested virt) and a wildcard TLS domain (`*.resources.<domain>`) must be provisioned **before** the Phase 3 sandbox/deploy work lands.
- **Security/rigor**: production-bound. The spec's security & threat model (§19) and acceptance/DoD tests gate progress — Foundry contract tests, sandbox egress/secret/limit probes, and the exactly-once money-path E2E are required, not optional.
- **Settlement**: escrow scheme primary; `exact`/EIP-3009 is flat-only (no gate, no metering); Permit2 is the no-deposit metered alternative.
- **Build process**: GSD methodology (Discuss → Plan → Execute → Verify), phase by phase; do not start a phase until the prior phase's acceptance tests pass.

## Key Decisions

<!-- Decisions that constrain future work. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Full scope — MVP + post-MVP (spec Phases 0–8) | User wants the complete platform, not a slice | — Pending |
| Treat `Utter-SPEC.md` as authoritative | Spec is build-ready and designed for phase-by-phase execution | — Pending |
| Production-bound rigor (security + tests gate phases) | Real money + untrusted code; correctness is non-negotiable | — Pending |
| Escrow-balance scheme is the primary settlement path | EIP-3009 cannot meter or gate safely (§9.4) | — Pending |
| WSL2/local-first dev, Linux isolation host before Phase 3 | Builder is on Windows; gVisor/Firecracker need Linux | — Pending |
| Tokenomics documented-only, not built | Keep platform cut in USDC/EURC for now (§9.16) | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-20 after initialization*
