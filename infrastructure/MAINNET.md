# Utter mainnet / compliance cutover runbook

This is the pre-flight checklist for moving Utter from Arc Testnet to a real-money
deployment. It is authored against the current code so the steps are executable, but it is
a plan, not a completed migration.

Read `infrastructure/RUNBOOK.md` (host bring-up) and `contracts/DEPLOY.md` (contract deploy)
alongside this file. The money-path invariants in `CLAUDE.md` and `Utter-SPEC.md` (escrow
response gate, exactly-once settle, gVisor isolation, runtime `decimals()`) stay in force on
mainnet without exception.

## 0. Status and preconditions

What is live today (testnet): the four Phase 1 contracts are deployed and verified on Arc
Testnet (chainId 5042002), with the live money path proven on-chain (see
`contracts/DEPLOYMENTS.md`). All on-chain roles are collapsed onto a single deployer EOA
(`0xDa8c5726f596E8dae99e6dDEBa8AEa1c8bE9A4a5`).

What does not exist yet, and therefore gates this cutover:

- Arc mainnet itself. There is no mainnet chain id, RPC, explorer, or USDC address to pin.
  Pin them from Circle's published values when Arc mainnet ships. Do not invent them.
- The three ERC-8004 reference registries. They are intentionally unpinned in `@utter/chain`
  and must be CREATE2-deployed (section 3).
- A funded `REGISTRY_ADMIN_PRIVATE_KEY` and the role multisigs (sections 2 and 3).

Everything below is wired and offline-verified. The live broadcasts and probes are
operator-gated and must be run on the host, in order, in section 6.

## 1. Re-pin chain identity

`packages/chain/src/arc.ts` is the single source of truth. `ARC_CHAIN_ID` and
`ARC_CAIP2_NETWORK` derive from `arcTestnet.id`, and the identity / agent-card authoring path
already imports them (no literals left in that path). Updating `arc.ts` flows to those
consumers automatically.

Re-pin, in order:

1. `packages/chain/src/arc.ts`: `id`, `rpcUrls`, `blockExplorers`, `name`, and `testnet: false`.
   Keep `nativeCurrency.decimals: 18` only as the native gas lens; it is never USDC ERC-20 math.
2. `packages/chain/src/addresses.ts`: the mainnet `USDC` address (critical, see section 8),
   `EURC`, and the four Phase 1 contract addresses after the redeploy in section 2.
3. `contracts/foundry.toml`: the `[etherscan]` chain id and the RPC alias.

Remaining hardcoded `5042002` / `eip155:5042002` literals still to re-point or re-pin (these
were intentionally left outside the identity/card centralization):

- Money path (re-pin with the money-path tests, do not rush): `packages/x402-arc/src/client.ts`,
  `accepts.ts`, `codec.ts`, `sidecar.ts`.
- Buyer SDK: `packages/buyer-sdk/src/client.ts`, `demo.ts`.
- Marketplace test endpoint: `apps/marketplace/src/test-endpoint.ts`.
- Deployer: `services/deployer/src/live-deploy.ts`, `inject-x402.ts`.
- Comment only: `contracts/src/IdentityRegistry.sol`.

The cleanest mainnet hardening is to re-point each of these at `ARC_CHAIN_ID` /
`ARC_CAIP2_NETWORK` from `@utter/chain` so there is one place to change next time. This is a
deliberate pre-mainnet task, not done today: there is no mainnet chain id to target yet, and these
literals sit inside the money-path EIP-712 signing domains, which stay byte-unchanged until they are
re-pinned together with the money-path tests against the real mainnet values (a wrong chainId in a
signing domain silently breaks settlement, so it is not changed speculatively). The identity /
agent-card path needs no such change; it already flows from `@utter/chain`.

## 2. Redeploy the Phase 1 contracts with separated roles

`contracts/script/Deploy.s.sol` reads every parameter from the environment and warns loudly
when a role silently defaults to the deployer. For mainnet, set them all explicitly:

- `USDC_ADDRESS`: the mainnet USDC ERC-20.
- `PLATFORM_FEE_BPS`: the platform cut (default 3000 = 30 percent platform, 70 percent creator).
- `DEPLOYER_PRIVATE_KEY`: a funded deployer (broadcast only).
- `PLATFORM_TREASURY`: a treasury multisig, not an EOA. Receives the platform cut.
- `ESCROW_ADMIN`: the hot relayer that submits debits.
- `CONTRACT_OWNER`: the `DEFAULT_ADMIN` multisig that holds the role-admin and the 2-step
  admin handoff (section 7). Each contract reverts on a zero admin.
- `REGISTRY_ADMIN`, `SLASHER`, `TREASURY_ADMIN`: the role grantees (section 7). Each defaults to
  `CONTRACT_OWNER` when unset, and the script warns loudly when it does, so production must set
  them to their own multisigs to get the role split. Point `SLASHER` at a multisig.
- `ADMIN_TRANSFER_DELAY`: the `AccessControlDefaultAdminRules` admin-transfer delay in seconds
  (default 2 days).

Run `forge test` (all suites green) before any broadcast, then deploy with
`--rpc-url $ARC_RPC_URL --broadcast`. The script grants the `StakingVault` its registry
`VAULT_ROLE` (required so a slash can consume an authorization) only when the deployer holds the
registry `DEFAULT_ADMIN`; when `CONTRACT_OWNER` is a separate multisig the deployer does not, so
the script logs a deferral and the admin multisig must run `registry.grantRole(registry.VAULT_ROLE(),
stakingVault)` as a post-deploy wiring step. Pin the printed addresses back into
`packages/chain/src/addresses.ts` and record them in `contracts/DEPLOYMENTS.md` with the deploy
tx hashes. Verify each contract on the mainnet explorer.

## 3. Deploy and pin the ERC-8004 registries

Run `contracts/script/DeployErc8004.s.sol` (CREATE2 with fixed salts) to deploy
`IdentityRegistry`, `ReputationRegistry`, and `ValidationRegistry`. Set the derived addresses in
`.env.local`:

- `ERC8004_IDENTITY_REGISTRY`
- `ERC8004_REPUTATION_REGISTRY`
- `ERC8004_VALIDATION_REGISTRY`

Fund `REGISTRY_ADMIN_PRIVATE_KEY` (the account that mints identities and writes the
`ResourceRegistry` agentId). `resolveErc8004Addresses` throws if any registry env is unset, so a
misconfiguration fails loud rather than minting into nowhere.

## 4. Arm the compliance controls (new env from this track)

These seams default to the current testnet behavior and arm only under explicit env.

Payer sanctions screening (facilitator, `/verify`):

- `SANCTIONS_DENYLIST`: comma or space separated payer addresses to deny.
- `SANCTIONS_REQUIRED=1`: in production, fail closed if a screen is intended but no denylist is
  configured.

The screen runs deny-by-default before the spend-cap gate and before the reserve, so a screened
payer makes no reservation and consumes zero compute (it returns `403 payer_screened`, which the
buyer gate treats as a clean no-charge denial). A real remote sanctions feed implements the same
`PayerScreen` interface later. KYC is intentionally out of scope.

ERC-8004 identity mint (marketplace publish):

- Set the three `ERC8004_*` registries plus `REGISTRY_ADMIN_PRIVATE_KEY` (section 3).
- Optional `IDENTITY_MINT_REQUIRED=1` to fail closed if the mint is intended but unconfigured.

The live mint reads the existing on-chain resource (`getResource`) and calls `publishIdentity`
in `update` mode, so it sets the minted agentId without clobbering the creator / treasury /
creatorBps the deployer already registered. The deployer registers the resource first with a
placeholder agentId; the marketplace updates it.

On-chain bond gate (marketplace publish):

- `BOND_GATE_ENABLED=1`, only once creators actually post bonds to the `StakingVault`.

Leave the bond gate off until bonds exist. On testnet no resource has a posted bond, so arming
it would reject every publish with `bond_not_posted`.

Live publish-time probe (scorer, marketplace publish):

- `SCORER_LIVE_HTTPS_HOST`: the wildcard resources host (e.g. `resources.<domain>`). Setting it arms
  the real `LiveHttpsProber` for the publish gate; unset, the autonomous `FixtureProber` is used. The
  probe is a no-pay HTTPS conformance check: it fetches the deployed agent card (must be 200 and
  structurally valid), then makes one UNPAID POST to the resource `/call` and requires a 402 (the pay
  gate must be enforced; a 200 there would be a free-serve leak), within a latency budget
  (`SCORER_LATENCY_BUDGET_MS`, default 10000). It binds the probed host to `SCORER_LIVE_HTTPS_HOST` so
  it can only reach `*.resources.<domain>` endpoints (SSRF guard), and it never pays, signs, or reads
  a key. A failing probe returns unverified, so the resource is never listed.

## 5. Relayer and treasury operations

- Fund the relayer signer pool. The escrow admin (`ESCROW_ADMIN`) is the hot relayer that
  submits `debit`.
- Withdrawals use the `PaymentEscrow` pull-payment primitive: the creator and the treasury each
  withdraw their accrued internal `balanceOf` to real USDC; bonds withdraw from the
  `StakingVault` after the cooldown. The off-chain payout surface now exists: the operator-run
  treasury sweep (`packages/staking`), the studio creator self-withdraw and accrued-balance
  display, and the dashboard payout-history panel. See `infrastructure/PAYOUT.md` for the runbook
  and the live proof checklist.

## 6. Operator-gated live proofs (run in this order)

1. `forge test` (offline, local EVM) green.
2. Money-path E2E on mainnet (the echo live money path, the `MoneyPath.s.sol` flow): deposit,
   `/verify` reserve, handler, escrow response gate, `/settle` debit clamped to the signed cap,
   the 70/30 split confirmed by the `Debited` event. This accrues the treasury and creator
   balances the payout proof (item 7) draws down.
3. Sanctions: a denylisted payer is rejected `403 payer_screened` with zero reservation.
4. ERC-8004: a publish mints a real agentId; the served card's `identity.agentId` and the
   on-chain `ResourceRegistry` agree.
5. Bond: a sub-floor resource is rejected; a bonded resource lists.
6. The gVisor egress containment probe passes (`UTTER_RUN_EGRESS_PROBE=1`); a non-allowlisted
   host is unreachable from the untrusted container.
7. Payout: run the live proof checklist in `infrastructure/PAYOUT.md`. The operator treasury sweep
   and a creator self-withdraw each emit a `Withdrawn` event on ArcScan, the creator withdrawal
   shows up in the dashboard payout-history panel, and the swept balances read back to zero.
8. Publish probe (if `SCORER_LIVE_HTTPS_HOST` is armed, section 4): publishing a deployed resource
   runs the live HTTPS conformance probe; a card that is unreachable, invalid, free-serving (no 402),
   or over the latency budget is rejected unverified and never listed.

## 7. Contract hardening

The first two items below are DONE in the contract source and gated by `forge test`. They need a
redeploy with the role addresses set (section 2), so the live posture only takes effect once the
operator redeploys and points the roles at multisigs. The third item is still open.

- DONE. The five `Ownable` contracts (`ResourceRegistry`, `PaymentEscrow`, `StakingVault`,
  `IdentityRegistry`, `PaymentSplitter`) now inherit OpenZeppelin `AccessControlDefaultAdminRules`.
  That one base gives both the role split (`REGISTRY_ADMIN_ROLE`, `SLASHER_ROLE`,
  `TREASURY_ADMIN_ROLE`; `DEFAULT_ADMIN_ROLE` gates the escrow relayer rotation and the splitter
  config) AND a 2-step, time-delayed, non-renounceable `DEFAULT_ADMIN` handoff, so an owner change
  cannot brick a contract. Point `DEFAULT_ADMIN` at a multisig at deploy (section 2).
- DONE. The slash integrity gap is closed on-chain. `ResourceRegistry.slashAuthorization`
  (`SLASHER_ROLE`) now records a pending authorization `{amount, executableAt = now +
  SLASH_DISPUTE_WINDOW}` (1 day) rather than an advisory event; `DEFAULT_ADMIN` may
  `cancelSlashAuthorization` during the window to dispute. `StakingVault.slash` (`SLASHER_ROLE`)
  consumes that exact authorization through `consumeSlashAuthorization` (registry `VAULT_ROLE`,
  held only by the vault) before any bond effect, and the consume is single-use. So a bond can be
  slashed only after a matured, matching, undisputed registry authorization, and one key cannot
  unilaterally slash (with `SLASHER` a multisig, defense in depth on top).
- DONE. The treasury payout / creator withdrawal surface ships (section 5): the operator-run
  treasury sweep (`packages/staking`), the studio creator self-withdraw and accrued-balance
  display, and the dashboard payout-history panel (the on-chain `Withdrawn` read via
  `readWithdrawals`). The live proof is the operator checklist in `infrastructure/PAYOUT.md`.

KYC is intentionally out of scope (testnet, and not required for the supply-side flow).

## 8. Money and decimals discipline

USDC `0x3600000000000000000000000000000000000000` on Arc is both the 6-decimal ERC-20 and the
18-decimal native gas token. Always read `decimals()` at runtime for ERC-20 amount math; never
hardcode `1e6`, `/ 6`, or a decimals literal, and never mix the 18-decimal native gas value with
6-decimal ERC-20 amounts. On mainnet, re-pin the USDC address and re-confirm its `decimals()`
rather than assuming 6.
