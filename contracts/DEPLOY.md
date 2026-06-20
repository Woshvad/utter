# Deploying the Utter contracts to Arc Testnet

This runbook deploys and verifies the Phase 1 contract set on Arc Testnet:
ResourceRegistry, PaymentEscrow, StakingVault, and a representative
PaymentSplitter. The `forge test` suite is the autonomous correctness gate and
passes without any live deploy. The on-chain deploy plus ArcScan verification
below is the operator-gated subset of CONTRACT-06 / Success Criterion 1. It is
NOT required for `forge test` to be green; it needs a funded deployer key, which
does not ship in this repo.

Arc Testnet: chainId `5042002`. USDC `0x3600000000000000000000000000000000000000`
is the 6-decimal ERC-20 and also the 18-decimal native gas token. Gas is paid in
native USDC, so the deployer EOA must hold a USDC balance.

## Prerequisites

- Foundry installed (`forge --version`).
- The full suite green: `forge test` (run from `contracts/`).

## 1. Fund a deployer EOA

Fund a fresh EOA with native USDC for gas at https://faucet.circle.com. The web
faucet is captcha-gated (about 20 USDC per address per 2 hours), so treat
funding as a manual operator step. Record the EOA private key for the next step.

## 2. Set the environment

Copy `.env.example` to `.env.local` and fill in the operator values. `.env.local`
is gitignored (CLAUDE.md: secrets only in `.env.local`); never commit a real key.

```bash
cp .env.example .env.local
# then edit .env.local:
#   DEPLOYER_PRIVATE_KEY = the funded EOA key from step 1
#   ARC_RPC_URL          = https://rpc.testnet.arc.network
#   PLATFORM_TREASURY    = the address that receives the platform 30% cut
#   ESCROW_ADMIN         = the relayer key permitted to submit escrow debits
#   CONTRACT_OWNER       = the Ownable owner (defaults to the deployer if unset)
source .env.local
```

`USDC_ADDRESS` and `PLATFORM_FEE_BPS` default to the Arc USDC address and 3000
(platform 30% / creator 70%) when unset.

## 3. Dry run (no gas, no broadcast)

Simulate the full deploy on the local EVM with no key and no gas:

```bash
forge script script/Deploy.s.sol
```

Optionally simulate against the live Arc RPC (still no state change, no gas):

```bash
forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL
```

The dry run prints every contract address it would deploy. Confirm it exits 0.

## 4. Live broadcast

With a funded `DEPLOYER_PRIVATE_KEY` set, broadcast the deploy:

```bash
forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast
```

Record the deployed addresses printed at the end (ResourceRegistry,
PaymentEscrow, StakingVault, PaymentSplitter).

## 5. Verify each contract on ArcScan

ArcScan is a Blockscout instance, so verification uses the Blockscout verifier
(no API key). Run one verify per contract, substituting the deployed address:

```bash
forge verify-contract \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api/ \
  <DEPLOYED_ADDRESS> src/ResourceRegistry.sol:ResourceRegistry

forge verify-contract \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api/ \
  <DEPLOYED_ADDRESS> src/PaymentEscrow.sol:PaymentEscrow

forge verify-contract \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api/ \
  <DEPLOYED_ADDRESS> src/StakingVault.sol:StakingVault

forge verify-contract \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api/ \
  <DEPLOYED_ADDRESS> src/PaymentSplitter.sol:PaymentSplitter
```

Constructor-argument flags (`--constructor-args`) may be required per contract;
pass the same arguments the deploy used (ABI-encoded). Foundry can read them from
the broadcast artifact under `broadcast/Deploy.s.sol/5042002/`.

## 6. Inspect the money path on ArcScan

To complete the on-chain subset of CONTRACT-06, run one
deposit -> debit(<= cap) -> withdraw cycle through PaymentEscrow and inspect the
resulting transaction on ArcScan. Confirm the `Debited` event shows the
creator/treasury split (70/30 by default) and that the buyer balance decremented
by exactly the debited amount with no double-charge.

## 7. Pin the deployed addresses

Pin the verified addresses back into `packages/chain/src/addresses.ts`, the single
place Utter addresses live, so later packages import them. Add one `export const`
per deployed contract alongside the existing Arc system addresses.

## Notes

- The live deploy plus ArcScan verification is operator-gated. `forge test`
  passing is the phase-correctness gate and is independent of this step.
- The deployer key lives only in `.env.local` (gitignored). `.env.example` carries
  placeholders only. Verifying on ArcScan maps the deployed bytecode back to the
  audited source so no unverified contract is trusted.
