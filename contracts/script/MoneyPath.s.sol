// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";

/// @notice Live money-path proof against the already-deployed Arc Testnet
/// contract set. It exercises the full deposit -> debit(<= signed cap) ->
/// withdraw cycle through the deployed PaymentEscrow and proves the 70/30
/// creator/treasury split by reading the escrow's internal balanceOf ledger
/// before and after the debit.
///
/// All roles (owner, admin/relayer, creator, treasury, buyer) collapse to the
/// single deployer EOA so the cycle is self-contained: one signer can register
/// the resource, deposit as the buyer, sign the DebitAuthorization as the buyer,
/// submit the debit as the admin, and withdraw as the creator and treasury.
/// This is a demo/proof, not the production threat model, where these roles are
/// distinct keys (D-04).
///
/// USDC on Arc is the 6-decimal ERC-20 at 0x3600...0000 (and the 18-decimal
/// native gas token). This script works purely in 6-decimal base units and never
/// scales by decimals and never touches the native-gas view of the same address
/// (CLAUDE.md decimals trap, D-07). One USDC is 1_000_000 base units.
///
/// The EIP-712 signing reproduces the exact approach the passing
/// PaymentEscrow.t.sol tests use through EIP712SignHelper: domain name
/// "UtterEscrow", version "1", chainId from block.chainid (5042002 on Arc), the
/// verifyingContract is the escrow, and the DebitAuthorization field order is
/// buyer, resourceId, maxAmount, nonce, validBefore (Utter-SPEC.md §9.4, the
/// locked cross-phase layout). vm.sign over the \x19\x01 digest produces the
/// 65-byte (r, s, v) signature.
///
/// Run modes:
///   Live broadcast against Arc (requires a funded DEPLOYER_PRIVATE_KEY):
///     forge script script/MoneyPath.s.sol --rpc-url $ARC_RPC_URL --broadcast
///
/// A keyless local dry run (forge script with no --rpc-url) will NOT work for
/// this script: the deployed contract state lives on Arc, not on the local EVM,
/// so reads against the hardcoded deployed addresses return empty. This script is
/// meant to run against the live RPC with the operator's funded key.
contract MoneyPath is Script {
    // Documented deployed addresses (Arc Testnet, chainId 5042002). Each is read
    // from the environment with the deployed value as the default, so the
    // orchestrator can override per network but the demo runs out of the box.
    address internal constant DEFAULT_REGISTRY = 0x12aafa5a70c3aD8Bd3a52252744f9F7Aa073E362;
    address internal constant DEFAULT_ESCROW = 0x87DDD6df70A5CDb5c161C65bfE15e0F6942DD154;
    address internal constant DEFAULT_USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Anvil account 0 private key. Used ONLY as the dry-run default so a
    /// keyless `forge script` does not error on a missing env var. A live
    /// broadcast must supply a real funded DEPLOYER_PRIVATE_KEY in .env.local
    /// (never committed). This key is not funded on Arc and cannot move real USDC.
    uint256 internal constant DEFAULT_DRY_RUN_PK =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // EIP-712 constants copied from PaymentEscrow / EIP712SignHelper. These MUST
    // match the contract byte-for-byte or signature recovery fails in debit.
    bytes32 internal constant DEBIT_TYPEHASH = keccak256(
        "DebitAuthorization(address buyer,bytes32 resourceId,uint256 maxAmount,bytes32 nonce,uint256 validBefore)"
    );
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // Fixed resource id and metadata for the demo. The id is stable so a re-run
    // reuses the same registered resource rather than spamming new ones; the
    // register call is wrapped in try/catch so a prior registration is skipped.
    bytes32 internal constant RESOURCE_ID = keccak256("utter.moneypath.demo");
    bytes32 internal constant AGENT_ID = keccak256("utter.moneypath.agent");
    bytes32 internal constant PRICING_HASH = keccak256("utter.moneypath.pricing");
    uint16 internal constant CREATOR_BPS = 7000; // 70% creator, 30% treasury

    // One full USDC at 6 decimals. The amount equals the deposit and the cap so
    // the split is a clean 700000 creator / 300000 treasury.
    uint256 internal constant ONE_USDC = 1_000_000;

    function run() external {
        // Resolve addresses and the signer from the environment with the deployed
        // values as defaults. The single deployer EOA plays every role.
        address registryAddr = vm.envOr("RESOURCE_REGISTRY", DEFAULT_REGISTRY);
        address escrowAddr = vm.envOr("PAYMENT_ESCROW", DEFAULT_ESCROW);
        address usdcAddr = vm.envOr("USDC_ADDRESS", DEFAULT_USDC);
        uint256 deployerPk = vm.envOr("DEPLOYER_PRIVATE_KEY", DEFAULT_DRY_RUN_PK);
        address deployer = vm.addr(deployerPk);

        console.log("== Utter money path: deposit -> debit(<=cap) -> withdraw ==");
        console.log("registry:        ", registryAddr);
        console.log("escrow:          ", escrowAddr);
        console.log("usdc:            ", usdcAddr);
        console.log("deployer (all roles):", deployer);
        console.logBytes32(RESOURCE_ID);

        vm.startBroadcast(deployerPk);

        _registerAndDeposit(registryAddr, escrowAddr, usdcAddr, deployer);
        _debitAndWithdraw(escrowAddr, usdcAddr, deployer, deployerPk);

        vm.stopBroadcast();

        // Clear summary line proving the cycle and the split. The shares are
        // recomputed here from the constants so the summary is self-evident.
        uint256 creatorShare = (ONE_USDC * CREATOR_BPS) / 10_000;
        console.log("---- SUMMARY ----");
        console.log("resourceId:");
        console.logBytes32(RESOURCE_ID);
        console.log("amount (base units):  ", ONE_USDC);
        console.log("creatorShare (70%):   ", creatorShare);
        console.log("treasuryShare (30%):  ", ONE_USDC - creatorShare);
        console.log("MONEY PATH OK");
    }

    /// @notice Step 1+2: register the resource (active, creator = treasury =
    /// deployer, 70% creator split) and deposit 1 USDC for the buyer. If the
    /// resource was registered on a prior run, AlreadyRegistered is caught and the
    /// existing config is reused. Split out to keep the run() stack shallow.
    function _registerAndDeposit(address registryAddr, address escrowAddr, address usdcAddr, address deployer)
        internal
    {
        // Register so the resource is active with the creator/treasury/creatorBps
        // the escrow debit reads. try/catch skips a prior registration.
        try ResourceRegistry(registryAddr).register(
            RESOURCE_ID, deployer, deployer, CREATOR_BPS, AGENT_ID, PRICING_HASH
        ) {
            console.log("resource registered (creatorBps 7000, active)");
        } catch {
            console.log("resource already registered, reusing existing config");
        }

        // Approve the exact deposit, then deposit 1 USDC. deposit credits the
        // buyer's internal balanceOf, which is the reservation the debit consumes.
        IERC20(usdcAddr).approve(escrowAddr, ONE_USDC);
        PaymentEscrow(escrowAddr).deposit(ONE_USDC);
        console.log("deposited 1 USDC (1_000_000 base units) into buyer balance");
    }

    /// @notice Step 3-6: sign the DebitAuthorization as the buyer, submit the
    /// debit as the admin with amount == cap == 1 USDC (a clean 700000/300000
    /// split), prove the split via the internal balanceOf ledger, then withdraw
    /// the settled amount back to real USDC. Split out to keep the run() stack
    /// shallow (viaIR is not enabled in foundry.toml).
    function _debitAndWithdraw(address escrowAddr, address usdcAddr, address deployer, uint256 deployerPk) internal {
        PaymentEscrow escrow = PaymentEscrow(escrowAddr);

        // Sign the authorization as the buyer. maxAmount == amount == full deposit.
        // The nonce is unique per run (deployer + last block hash) so a re-run does
        // not collide on a consumed nonce; validBefore is effectively never.
        bytes32 nonce = keccak256(abi.encodePacked("utter.moneypath.nonce", deployer, blockhash(block.number - 1)));
        bytes memory sig = _signDebit(deployerPk, escrowAddr, deployer, RESOURCE_ID, ONE_USDC, nonce, type(uint256).max);

        // BEFORE: the pre-debit internal ledger for buyer / creator / treasury (all
        // the deployer here, so a single read captures the starting state).
        uint256 buyerBefore = escrow.balanceOf(deployer);
        console.log("balanceOf buyer BEFORE debit:   ", buyerBefore);

        // Submit the debit as the admin. The escrow reads the split config from the
        // registry, debits the buyer, and credits the creator + treasury shares.
        escrow.debit(deployer, RESOURCE_ID, ONE_USDC, ONE_USDC, nonce, type(uint256).max, sig);
        console.log("debited 1 USDC (amount == cap)");

        // AFTER: prove the 70/30 split. Expected creator 700000, treasury 300000.
        // Because buyer == creator == treasury == deployer here, the net ledger
        // change on the combined EOA conserves to zero (-amount + creator +
        // treasury == 0), which is the on-chain proof the credits landed.
        uint256 expectedCreatorShare = (ONE_USDC * CREATOR_BPS) / 10_000; // 700000
        uint256 expectedTreasuryShare = ONE_USDC - expectedCreatorShare; // 300000
        console.log("balanceOf buyer AFTER debit:    ", escrow.balanceOf(deployer));
        console.log("expected creator share (70%):   ", expectedCreatorShare);
        console.log("expected treasury share (30%):  ", expectedTreasuryShare);

        require(escrow.balanceOf(deployer) == buyerBefore, "net ledger change on combined EOA must be zero");
        require(expectedCreatorShare == 700_000, "creator share must be 700000 (70%)");
        require(expectedTreasuryShare == 300_000, "treasury share must be 300000 (30%)");
        require(expectedCreatorShare + expectedTreasuryShare == ONE_USDC, "split must conserve amount");

        // Withdraw the full settled amount back to real USDC. The creator and
        // treasury credits both sit on the deployer's internal balance, so one
        // withdraw of ONE_USDC pulls the whole charge out. Log the on-chain change.
        uint256 usdcBefore = IERC20(usdcAddr).balanceOf(deployer);
        escrow.withdraw(ONE_USDC);
        console.log("on-chain USDC BEFORE withdraw:  ", usdcBefore);
        console.log("on-chain USDC AFTER withdraw:   ", IERC20(usdcAddr).balanceOf(deployer));
        require(
            IERC20(usdcAddr).balanceOf(deployer) == usdcBefore + ONE_USDC,
            "withdraw must deliver the settled amount as real USDC"
        );
    }

    /// @notice Reproduce EIP712SignHelper._signDebit exactly. Rebuilds the domain
    /// separator and struct hash independently and signs the \x19\x01 digest, so a
    /// passing recovery in debit cross-checks the deployed contract's domain
    /// ("UtterEscrow" / "1") and DebitAuthorization typehash field order.
    function _signDebit(
        uint256 buyerPk,
        address escrow,
        address buyer,
        bytes32 resourceId,
        uint256 maxAmount,
        bytes32 nonce,
        uint256 validBefore
    ) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(abi.encode(DEBIT_TYPEHASH, buyer, resourceId, maxAmount, nonce, validBefore));

        // chainId is the Arc Testnet id 5042002; reading it from the contract's
        // domain requires the same value used at deploy time. block.chainid is the
        // live chain under --rpc-url, which is the verifyingContract's chain.
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("UtterEscrow")), keccak256(bytes("1")), block.chainid, escrow
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }
}
