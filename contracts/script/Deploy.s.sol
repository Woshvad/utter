// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {IResourceRegistry} from "../src/interfaces/IResourceRegistry.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {PaymentSplitter} from "../src/PaymentSplitter.sol";

/// @notice Deploys and wires the Phase 1 contract set to Arc Testnet
/// (ResourceRegistry, PaymentEscrow, StakingVault, and one representative
/// PaymentSplitter). All parameters are read from the environment so no address
/// or key is hardcoded; see contracts/.env.example and contracts/DEPLOY.md.
///
/// USDC on Arc is the 6-decimal ERC-20 at 0x3600...0000 (also the 18-decimal
/// native gas token). This script never scales by decimals and never mixes the
/// two: it only passes the USDC address through to the constructors, which work
/// in base units (CLAUDE.md decimals trap).
///
/// Run modes:
///   Dry run (no key, no gas, local EVM simulation):
///     forge script script/Deploy.s.sol
///   Dry run against the live Arc RPC (simulation only, no state change):
///     forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL
///   Live broadcast (requires a funded DEPLOYER_PRIVATE_KEY):
///     forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast
///
/// The live broadcast is operator-gated: no funded deployer key ships in this
/// repo. The dry run uses a well-known test key default so the deploy logic runs
/// end to end on the local EVM without any operator setup.
contract Deploy is Script {
    /// @notice Canonical Arc USDC, used as the default when USDC_ADDRESS is unset.
    address internal constant DEFAULT_USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Anvil account 0 private key. Used ONLY as the dry-run default so a
    /// keyless `forge script` simulates the deploy. A live broadcast must supply a
    /// real funded DEPLOYER_PRIVATE_KEY in .env.local (never committed).
    uint256 internal constant DEFAULT_DRY_RUN_PK =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        // Parameters from env with documented defaults so the dry run needs no
        // operator setup. PLATFORM_FEE_BPS defaults to 3000 (platform 30% /
        // creator 70%, spec §16). The splitter's creatorBps is the complement.
        address usdc = vm.envOr("USDC_ADDRESS", DEFAULT_USDC);
        uint16 feeBps = uint16(vm.envOr("PLATFORM_FEE_BPS", uint256(3000)));
        uint256 deployerPk = vm.envOr("DEPLOYER_PRIVATE_KEY", DEFAULT_DRY_RUN_PK);
        address deployer = vm.addr(deployerPk);

        // treasury / admin / owner default to the deployer when unset so the dry
        // run is self-contained. A live deploy should set PLATFORM_TREASURY and
        // ESCROW_ADMIN explicitly.
        address treasury = vm.envOr("PLATFORM_TREASURY", deployer);
        address admin = vm.envOr("ESCROW_ADMIN", deployer);
        address owner = vm.envOr("CONTRACT_OWNER", deployer);

        require(feeBps <= 10_000, "PLATFORM_FEE_BPS exceeds 10000");
        uint16 creatorBps = 10_000 - feeBps;

        vm.startBroadcast(deployerPk);

        // 1. Registry: the on-chain resource config store the escrow reads.
        ResourceRegistry registry = new ResourceRegistry(owner);

        // 2. Escrow: primary money path, wired to the USDC token, the registry it
        // reads split config from, the relayer admin, and the owner.
        PaymentEscrow escrow =
            new PaymentEscrow(IERC20(usdc), IResourceRegistry(address(registry)), admin, owner);

        // 3. Staking vault: per-resource bond custody plus the in-vault insurance
        // pool, owned by the admin that may slash and refund.
        StakingVault vault = new StakingVault(IERC20(usdc), owner);

        // 4. Representative PaymentSplitter for the flat exact path. The splitter
        // is per-resource in production; this one is deployed as a wiring example
        // so operators see the exact-path payout contract. creator defaults to the
        // treasury here; real resources deploy their own splitter per creator.
        PaymentSplitter splitter =
            new PaymentSplitter(IERC20(usdc), treasury, treasury, creatorBps, owner);

        vm.stopBroadcast();

        // Print the deployed addresses so the operator can pin them back into
        // packages/chain/src/addresses.ts (DEPLOY.md step 7).
        console.log("USDC (token):           ", usdc);
        console.log("ResourceRegistry:       ", address(registry));
        console.log("PaymentEscrow:          ", address(escrow));
        console.log("StakingVault:           ", address(vault));
        console.log("PaymentSplitter (sample):", address(splitter));
        console.log("owner:                  ", owner);
        console.log("escrow admin (relayer): ", admin);
        console.log("platform treasury:      ", treasury);
        console.log("creatorBps:             ", creatorBps);
    }
}
