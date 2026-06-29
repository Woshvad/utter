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
    uint256 internal constant DEFAULT_DRY_RUN_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    /// @notice Resolved deploy parameters. Grouped into a struct so the run()
    /// stack stays shallow (viaIR is not enabled in foundry.toml).
    struct Params {
        address usdc;
        uint256 deployerPk;
        address deployer;
        address treasury;
        address admin;
        address owner;
        address registryAdmin;
        address slasher;
        address treasuryAdmin;
        uint48 adminDelay;
        uint16 creatorBps;
    }

    function run() external {
        Params memory p = _resolveParams();

        vm.startBroadcast(p.deployerPk);

        // 1. Registry: the on-chain resource config store the escrow reads.
        // DEFAULT_ADMIN is the owner; REGISTRY_ADMIN_ROLE and SLASHER_ROLE go to
        // the dedicated role addresses.
        ResourceRegistry registry = new ResourceRegistry(p.adminDelay, p.owner, p.registryAdmin, p.slasher);

        // 2. Escrow: primary money path, wired to the USDC token, the registry it
        // reads split config from, the relayer admin, and the DEFAULT_ADMIN owner.
        PaymentEscrow escrow =
            new PaymentEscrow(IERC20(p.usdc), IResourceRegistry(address(registry)), p.admin, p.adminDelay, p.owner);

        // 3. Staking vault: per-resource bond custody plus the in-vault insurance
        // pool. SLASHER_ROLE may slash; TREASURY_ADMIN_ROLE may refund. The vault
        // consumes slash authorizations from the registry, so it holds a reference
        // to it and is granted VAULT_ROLE below.
        StakingVault vault = new StakingVault(
            IERC20(p.usdc), IResourceRegistry(address(registry)), p.adminDelay, p.owner, p.slasher, p.treasuryAdmin
        );

        // Couple the slash path: grant the vault VAULT_ROLE on the registry so it
        // alone may consume a recorded slash authorization. The deployer holds
        // DEFAULT_ADMIN here so the grant succeeds in the dry run; on mainnet the
        // admin multisig performs this grant as a post-deploy wiring step.
        // Only the registry DEFAULT_ADMIN may grant VAULT_ROLE. In the keyless dry
        // run the deployer holds DEFAULT_ADMIN, so the grant succeeds. On a
        // production broadcast where CONTRACT_OWNER is a separate multisig the
        // deployer does NOT hold it, so guard the grant to avoid a hard revert that
        // would fail the whole deploy; the admin multisig performs this grant as the
        // post-deploy wiring step. Without VAULT_ROLE the vault cannot consume a
        // slash authorization, so this step must not be skipped silently.
        if (registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), p.deployer)) {
            registry.grantRole(registry.VAULT_ROLE(), address(vault));
            console.log("Granted VAULT_ROLE on registry to StakingVault:", address(vault));
        } else {
            console.log(
                "VAULT_ROLE grant DEFERRED: the deployer is not the registry DEFAULT_ADMIN. The admin multisig MUST grant registry.VAULT_ROLE() to the StakingVault post-deploy, or slash can never consume an authorization."
            );
            console.log("StakingVault awaiting VAULT_ROLE grant:", address(vault));
        }

        // 4. Representative PaymentSplitter for the flat exact path. The splitter
        // is per-resource in production; this one is deployed as a wiring example
        // so operators see the exact-path payout contract. creator defaults to the
        // treasury here; real resources deploy their own splitter per creator.
        PaymentSplitter splitter =
            new PaymentSplitter(IERC20(p.usdc), p.treasury, p.treasury, p.creatorBps, p.adminDelay, p.owner);

        vm.stopBroadcast();

        _logSummary(p, address(registry), address(escrow), address(vault), address(splitter));
    }

    /// @notice Read every parameter from the environment with the documented
    /// defaults and emit the warn-on-default-to-deployer / default-to-owner
    /// diagnostics. Split out of run() to keep the deploy stack shallow.
    function _resolveParams() internal view returns (Params memory p) {
        // PLATFORM_FEE_BPS defaults to 3000 (platform 30% / creator 70%, spec
        // §16). The splitter's creatorBps is the complement.
        p.usdc = vm.envOr("USDC_ADDRESS", DEFAULT_USDC);
        uint16 feeBps = uint16(vm.envOr("PLATFORM_FEE_BPS", uint256(3000)));
        p.deployerPk = vm.envOr("DEPLOYER_PRIVATE_KEY", DEFAULT_DRY_RUN_PK);
        p.deployer = vm.addr(p.deployerPk);

        // treasury / admin / owner default to the deployer when unset so the dry
        // run is self-contained. A live deploy should set PLATFORM_TREASURY and
        // ESCROW_ADMIN explicitly.
        p.treasury = vm.envOr("PLATFORM_TREASURY", p.deployer);
        p.admin = vm.envOr("ESCROW_ADMIN", p.deployer);
        p.owner = vm.envOr("CONTRACT_OWNER", p.deployer);

        // AccessControl role grantees. Each defaults to the owner (DEFAULT_ADMIN)
        // when unset so the keyless dry run is self-contained; a live deploy should
        // point each at the dedicated multisig / operator key. adminDelay is the
        // 2-step DEFAULT_ADMIN_ROLE transfer delay (default 2 days).
        p.registryAdmin = vm.envOr("REGISTRY_ADMIN", p.owner);
        p.slasher = vm.envOr("SLASHER", p.owner);
        p.treasuryAdmin = vm.envOr("TREASURY_ADMIN", p.owner);
        p.adminDelay = uint48(vm.envOr("ADMIN_TRANSFER_DELAY", uint256(2 days)));

        // Warn loudly if any role silently defaulted to the deployer. On a live
        // broadcast this collapses the relayer, owner, and treasury into one EOA
        // and flattens the threat model, so the operator must see it. This is a
        // warning, not a hard revert, to keep the keyless dry run convenient.
        if (p.treasury == p.deployer) {
            console.log("WARNING: PLATFORM_TREASURY unset, defaulting to deployer. Set it for production.");
        }
        if (p.admin == p.deployer) {
            console.log("WARNING: ESCROW_ADMIN unset, defaulting to deployer. Set it for production.");
        }
        if (p.owner == p.deployer) {
            console.log("WARNING: CONTRACT_OWNER unset, defaulting to deployer. Set it for production.");
        }

        // Warn when a specific role defaulted to the owner. On a live broadcast
        // this collapses the role split back into the DEFAULT_ADMIN key, so the
        // operator must set each role explicitly for production.
        if (p.registryAdmin == p.owner) {
            console.log("WARNING: REGISTRY_ADMIN unset, defaulting to owner. Set it for production.");
        }
        if (p.slasher == p.owner) {
            console.log("WARNING: SLASHER unset, defaulting to owner. Set it for production.");
        }
        if (p.treasuryAdmin == p.owner) {
            console.log("WARNING: TREASURY_ADMIN unset, defaulting to owner. Set it for production.");
        }

        require(feeBps <= 10_000, "PLATFORM_FEE_BPS exceeds 10000");
        p.creatorBps = 10_000 - feeBps;
    }

    /// @notice Print the deployed addresses and resolved roles so the operator can
    /// pin them back into packages/chain/src/addresses.ts (DEPLOY.md step 7).
    function _logSummary(Params memory p, address registry, address escrow, address vault, address splitter)
        internal
        pure
    {
        console.log("USDC (token):           ", p.usdc);
        console.log("ResourceRegistry:       ", registry);
        console.log("PaymentEscrow:          ", escrow);
        console.log("StakingVault:           ", vault);
        console.log("PaymentSplitter (sample):", splitter);
        console.log("owner (DEFAULT_ADMIN):  ", p.owner);
        console.log("escrow admin (relayer): ", p.admin);
        console.log("platform treasury:      ", p.treasury);
        console.log("registry admin role:    ", p.registryAdmin);
        console.log("slasher role:           ", p.slasher);
        console.log("treasury admin role:    ", p.treasuryAdmin);
        console.log("admin transfer delay:   ", uint256(p.adminDelay));
        console.log("creatorBps:             ", p.creatorBps);
    }
}
