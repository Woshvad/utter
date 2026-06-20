<!-- GSD:project-start source:PROJECT.md -->

## Project

**Utter**

Utter is a no-code platform that turns a plain-English prompt into a *live, paid API that AI agents pay to use per call in USDC*, built natively on **Arc**, Circle's stablecoin L1. A creator describes an endpoint; Utter generates the code, deploys it in an isolated sandbox, verifies it works, gives it an on-chain ERC-8004 identity, lists it in a marketplace with an A2A agent card, and other AI agents discover and pay for it per call. The creator earns the majority of every call. Zero servers, zero billing setup.

It is the **supply side of the agent economy**: x402 solved *how* agents pay; Utter is a factory for *what they buy*. One-liner: *you utter a sentence; you get a paid API.*

Audience: (A) creators/vibe-coders who want a priced URL in under two minutes, (B) agent operators whose agents deposit USDC once and then discover + pay per call with no API keys or humans, and (C) the platform operator (the builder) who earns a cut of every call.

**Core Value:** A creator describes an API in one sentence and gets a live endpoint that AI agents autonomously pay for per call in USDC — with payment debited **only after the response passes validation** (the escrow response gate). If everything else fails, the prompt-to-paid-API loop with safe on-chain settlement must work.

### Constraints

- **Tech stack**: pnpm monorepo per §17 (apps/, services/, packages/, contracts/). Remix/React/TS front, Node/TS services, Foundry/Solidity contracts, Viem chain client — fixed by the spec.
- **Chain**: Arc Testnet only, chain ID `5042002`. USDC `0x3600…0000` is both the 6-decimal ERC-20 *and* the 18-decimal native gas token — always read `decimals()`, never hardcode, never mix the two.
- **Dev environment**: builder is on Windows 11. Build and test locally via **WSL2 + Docker Desktop**; a real Linux isolation host (gVisor/Firecracker + nested virt) and a wildcard TLS domain (`*.resources.<domain>`) must be provisioned **before** the Phase 3 sandbox/deploy work lands.
- **Security/rigor**: production-bound. The spec's security & threat model (§19) and acceptance/DoD tests gate progress — Foundry contract tests, sandbox egress/secret/limit probes, and the exactly-once money-path E2E are required, not optional.
- **Settlement**: escrow scheme primary; `exact`/EIP-3009 is flat-only (no gate, no metering); Permit2 is the no-deposit metered alternative.
- **Build process**: GSD methodology (Discuss → Plan → Execute → Verify), phase by phase; do not start a phase until the prior phase's acceptance tests pass.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->

## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

## Utter Engineering Rules (from SPEC §21)

> Read `Utter-SPEC.md` fully before editing. It is authoritative. Work phase by phase (SPEC §20); don't skip acceptance tests. Pin §6 (Arc reference), §9.4 (settlement), §16 (env vars).

- **Chain:** Arc Testnet, chainId `5042002`. USDC `0x3600…0000` is the 6-dp ERC-20 **and** the 18-dp native gas token. ALWAYS read `decimals()`; never mix 18-dp native gas with 6-dp ERC-20.
- **Primary money path = escrow scheme:** buyer deposits → `/verify` reserves the cap → run handler → validate response (ESCROW GATE) → `/settle` debits `min(computed, cap)` with inline split. EIP-3009 `exact` is FLAT-only (no gate, no metering). Permit2 is the no-deposit metered option.
- **NEVER run a handler against an unreserved authorization** (free-compute vector). Funds must be locked first. Do not regress to bare EIP-3009 for metered or gated calls.
- **Exactly-once:** idempotent `/settle` + persist `(idemKey → result)` + `GET /results/:idemKey`. Never double-charge on retry; never re-sign on retry.
- **Untrusted generated code runs ONLY in the sandbox** (gVisor/Firecracker), default-deny egress via the data-proxy, no secrets in containers, resource/timeout/size caps. Plain Docker is NOT a security boundary.
- **Distinguish** endpoint malfunction (no charge + strike) vs valid declared error for bad buyer input (no strike; charge per error policy) vs success (charge).
- **Reuse** `circlefin/arc-nanopayments` for `exact`; the escrow + metered schemes are Utter extensions you build.
- **`[VERIFY]` tags** in the spec are facts to confirm against live docs (§23) before relying on them — Arc is testnet-only and addresses/ABIs/standards move. Confirm, then delete the tag.
- **Secrets** only in `.env.local` (gitignored). Anything touching wallets/payments/sandbox is high-risk; add tests.
- **Docs/comments:** plain prose, no em dashes, no filler.
