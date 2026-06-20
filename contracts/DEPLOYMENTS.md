# Utter contract deployments

## Arc Testnet (chainId 5042002) - 2026-06-20

Deployed via `contracts/script/Deploy.s.sol` and verified on ArcScan (Blockscout).
Deployer / owner / escrow admin (relayer) / platform treasury default address:
`0xDa8c5726f596E8dae99e6dDEBa8AEa1c8bE9A4a5`. These are testnet deployments with
all roles collapsed onto the deployer EOA; a production deploy sets distinct
`PLATFORM_TREASURY` / `ESCROW_ADMIN` / `CONTRACT_OWNER` (see `DEPLOY.md`).

| Contract | Address | Deploy tx |
|----------|---------|-----------|
| ResourceRegistry | `0x12aafa5a70c3aD8Bd3a52252744f9F7Aa073E362` | `0xb607e882be7f5c00f41bfaebc9ddce9cbc08000c01e8f0f5608303f6a9de8dd0` |
| PaymentEscrow | `0x87DDD6df70A5CDb5c161C65bfE15e0F6942DD154` | `0x0acbcc2dc14f032ad80f1739344ced0fc7067e78e0d60de70af2cffe67a464e9` |
| StakingVault (+ InsurancePool) | `0x15573Cb5a391F1023317bd49b076A7FE664FdE8B` | `0x4bcd7ec52fffb6968841a147506524a8d93005f75ed056e46941fe878c1b43bc` |
| PaymentSplitter (sample) | `0x71375fC7cA1EA9d2f0dFc44d454B37AbD3cCe510` | `0x13dd645e4699d4b96b210cdbc86c3fa028026f798f2a053242d8d0a0e203a8a0` |

All four are verified on ArcScan (`Pass - Verified`). Explorer: https://testnet.arcscan.app/

### Money-path verification (Success Criterion 1 / CONTRACT-06)

A live deposit -> debit(<= signed cap) -> withdraw cycle through `PaymentEscrow`
(via `contracts/script/MoneyPath.s.sol` logic, driven with `cast` so Arc's native
USDC blocklist precompile executes) confirmed the inline 70/30 split on-chain:

- Resource registered: `resourceId = keccak256("utter.moneypath.demo")`, creatorBps 7000, active.
- Buyer deposited 1 USDC (1_000_000 base units); `debit` of 1_000_000 (== cap) against a
  buyer-signed EIP-712 `DebitAuthorization` (domain `UtterEscrow`/`1`).
- Result: creator internal balance credited **700000** (70%), treasury (`0x...dEaD`) credited
  **300000** (30%) - exact split, no dust leak. Creator withdrew its 700000 to real USDC;
  the treasury's 300000 remains held in escrow as the platform cut.

| Action | Tx |
|--------|----|
| register resource | `0x8811bc53edc3432458ee3026c2c5bd6d70534cf504d9e0f79ec1fe93c7e2cb4e` |
| approve USDC | `0xe33122e14fc139b7a84943b2469e0edc9946f84d655c9331863e1a45482edca7` |
| deposit 1 USDC | `0x5d371575e736b4a31972937b8f9d47e6509e21b1b4e630babbb4cd18a20c6df9` |
| debit (70/30 split) | `0x0e16ee496fb1d4b39a7da079da6e58d0368544c8b370ef9615c070538d2bf948` |
| withdraw creator share | `0x5d6308a58cac09ed1f4df4ed470b214fd0ec1d1e893347899bb218acbb755066` |

### Phase 2 money-path verification (PAY-12, live escrow gate) - 2026-06-20

The full Phase 2 escrow gate was proven on-chain by running the echo money path
(`packages/x402-arc/examples/echo/live-money-path.ts`): a buyer deposit, the off-chain
`/verify` reservation, the in-process handler, the escrow response gate, and a live
`/settle` escrow `debit` against the deployed `PaymentEscrow`. The metered amount
`5000 base + 100 perKB + 200 compute = 5300` clamped to the buyer-signed cap `10000`
(0.01 USDC); the `Debited` event split `creator 3710 (70%) / treasury 1590 (30%)`,
confirmed both by the decoded event and the resulting internal balances (deployer/creator
`8410` = 4700 leftover deposit + 3710 cut; treasury `0x...dEaD` `301590` = 300000 prior +
1590). Buyer = relayer = escrow admin = the deployer EOA (collapsed testnet roles).

Resource: `resourceId = keccak256("utter:echo:live-money-path")` = `0x515f3c13…d4ff`,
creator = deployer, treasury = `0x...dEaD`, creatorBps 7000, active.

| Action | Tx |
|--------|----|
| register resource | `0x5e36e97633cb86a047d006b2d076f915169e1aa2bc9d4b2318c0a07dcf85c338` |
| approve USDC | `0x0424a754db2e1fbe0ddad24a4f127fa2667125153d6bd78747ca7f86453471eb` |
| deposit 0.01 USDC | `0x0d637ccf90630bc4efce090df018bceba78e9d6c78714e04873caad4fc39c53c` |
| settle / debit (402 -> 200, 70/30 split) | `0x1c7606c543d7735420c746725d2685d9d88ba377cc7f11eb8f10207c38422dbf` |

### Phase 2 exact / EIP-3009 flat-path verification (PAY-08) - 2026-06-20

The FLAT `exact` settlement scheme was proven on-chain by
`packages/x402-arc/examples/echo/live-exact-path.ts`: the buyer signs an EIP-3009
`TransferWithAuthorization` (Arc USDC domain `USDC`/`2`) to the deployed
`PaymentSplitter`; the relayer submits it (USDC `transferWithAuthorization` moves the
signed `value` 5000 = 0.005 USDC to the splitter - no gate, no metering), then
`distribute()` flushes the configured split. The `Distributed` event confirmed
`toCreator 3500 (70%) / toTreasury 1500 (30%)` (sum 5000), and the splitter balance
returned to 0. Buyer = relayer = the deployer EOA; the splitter's creator = treasury =
deployer (sample config, unchanged), so the 0.005 USDC round-trips back (net cost ~gas).

| Action | Tx |
|--------|----|
| transferWithAuthorization (0.005 USDC -> splitter) | `0x192d5ec9462b7b73e550d6ba76e5c617df5da414b9a7b2a8823d52e7cb892cd7` |
| distribute (70/30 flat split) | `0x55188926dd9de94e4c5cbfbb25a785bc5030f1486cb677a9c34cb9c5a83bd8c4` |
