# Echo money-path demo (PAY-12)

The echo endpoint is a trusted in-process Hono handler mounted behind the
`requirePayment` escrow gate. It proves the full Phase 2 money path end to end:

```
deposit-state -> 402 -> sign DebitAuthorization -> 200 with an on-chain debit <= cap
```

and that a malformed response releases the reservation, records a strike, and never
debits. The handler is NOT sandboxed here — the gVisor/Firecracker isolation runtime
lands in Phase 3.

## Files

- `handler.ts` — `echoHandler` (EchoSuccess success + EchoError declared-error
  branch) and a test-only `echoMalfunctionHandler`.
- `server.ts` — `createEchoServer`, the handler mounted behind `requirePayment`.
- `openapi.json` / `test-cases.json` — the success + declared-error schemas the gate
  classifies handler output against.
- `live-money-path.ts` — the operator-gated live on-chain E2E (below).

## Autonomous proof (the phase-correctness gate)

The autonomous suite is the code gate. It runs entirely offline against the in-memory
store and a mocked chain — no faucet, no keys, no live RPC:

```bash
pnpm vitest run packages/x402-arc -t "echo-money-path"
```

It asserts: 402 on the unpaid call; 200 + the echoed body + an `X-PAYMENT-RESPONSE`
receipt + exactly one debit `<= cap` on the paid call; 502 + reservation release +
a strike + zero debits on a malformed response; and idempotent recovery via
`retrieveByIdemKey` after a simulated disconnect with no double-charge.

This proves the `debit <= cap` **logic**. It does **not** prove a genuine on-chain
`Debited` event — that is the operator-gated live run below.

## Live on-chain proof (operator-gated, NOT a phase blocker)

`live-money-path.ts` broadcasts a real escrow `debit` against the deployed
`PaymentEscrow` (`0x87DDD6df…`) on Arc Testnet (chainId `5042002`). It spends real
testnet USDC, so it is operator-gated exactly like Phase 1's ArcScan verify
(`contracts/DEPLOY.md`). It is **not required** for the autonomous suite to be green.

Why it must run against the live RPC, not a fork: Arc USDC is also the native gas
token and its transfer path hits a blocklist **precompile** that a local
`forge`/`anvil` fork does not implement, so a forked state-changing settle reverts
where the live send succeeds (RESEARCH Pitfall 4 / A5). Phase 1 hit the same wall and
drove the money path with live `cast send`.

### Runbook

1. **Fund the buyer + relayer.** Fund two EOAs with native USDC at
   <https://faucet.circle.com> (captcha-gated, ~20 USDC per address per 2 hours). On
   testnet the relayer is the escrow admin — the deployer EOA `0xDa8c5726…` (collapsed
   roles). The buyer is any fresh funded EOA.

2. **Set the keys in `.env.local`** (gitignored — never commit a real key):

   ```bash
   cp .env.example .env.local
   # then edit .env.local:
   #   TEST_BUYER_PRIVATE_KEY = the funded buyer EOA key
   #   RELAYER_SIGNER_KEYS    = the escrow-admin (deployer) EOA key
   #   ARC_RPC_URL            = https://rpc.testnet.arc.network   (optional; default)
   ```

3. **Run the live money path:**

   ```bash
   node packages/x402-arc/examples/echo/live-money-path.ts
   ```

   The script: confirms it is on Arc Testnet; deposits into `PaymentEscrow` if the
   buyer's escrow balance is below the cap; serves the echo app against an in-process
   facilitator whose relayer signs against the live RPC; runs GET (402) → sign → GET
   (200); reads the on-chain `Debited` event; and asserts `debit <= cap` plus the
   floored 70/30 creator/treasury split. It prints the ArcScan tx link. It never logs
   a private key.

4. **Confirm on ArcScan.** Open the printed
   `https://testnet.arcscan.app/tx/<hash>` and verify the `Debited` event shows
   `debit <= cap` and the 70/30 split (`toCreator` / `toTreasury`).

### Honesty note

The genuine on-chain `Debited` event (real `debit <= cap` + the 70/30 split) is proven
**only** here, operator-gated. The autonomous Task-1 suite proves the `debit <= cap`
**logic** against a mocked/forked chain, not a genuine on-chain event. Verification
must not over-claim a genuine on-chain proof from the autonomous run. This is the same
operator-gated posture as Phase 1's live deploy + ArcScan verify, and is **not** a
phase blocker.
