// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";

/// @notice Deterministically deploys the three ERC-8004 reference registries to Arc
/// Testnet (ID-01, ID-02, ID-03). Arc has NO canonical ERC-8004 deployment
/// (05-RESEARCH Pitfall 1), so Utter deploys its own reference and pins the derived
/// addresses into packages/chain/src/addresses.ts afterwards.
///
/// Determinism: each registry is deployed with CREATE2 via a fixed per-contract salt
/// (`new C{salt: ...}(args)`), so the resulting address is a pure function of
/// (deployer, salt, initcode). The canonical CREATE2 deterministic-deployment-proxy
/// is pinned at CREATE2_FACTORY below; an operator may instead route the salted
/// initcode through that factory for a deployer-independent address. The forge VM's
/// own CREATE2 (used here) is the autonomous, keyless proof that the addresses are
/// deterministic.
///
/// USDC / decimals: none of the three registries hold funds, so no USDC address or
/// decimals scaling is ever passed in (CLAUDE.md decimals trap is N/A here).
///
/// Run modes:
///   Keyless dry run (no key, no gas, local EVM simulation):
///     forge script script/DeployErc8004.s.sol
///   Dry run against the live Arc RPC (simulation only, no state change):
///     forge script script/DeployErc8004.s.sol --rpc-url $ARC_RPC_URL
///   Live broadcast (requires a funded REGISTRY_ADMIN_PRIVATE_KEY):
///     forge script script/DeployErc8004.s.sol --rpc-url $ARC_RPC_URL --broadcast
///
/// The live broadcast is OPERATOR-GATED: no funded key ships in this repo and the
/// derived addresses stay UNPINNED until the operator deploys (T-05-02-PHANTOM,
/// T-05-02-KEY). The dry run uses a well-known test key default so the deploy logic
/// runs end to end on the local EVM without any operator setup.
contract DeployErc8004 is Script {
    // CREATE2_FACTORY (0x4e59b44847b379578588920cA78FbF26c0B4956C) is inherited from
    // forge-std's Base and matches packages/chain/src/addresses.ts. An operator can
    // route the salted initcode through it for a deployer-independent address. Arc has
    // no canonical ERC-8004 registry, so there is no phantom 0x8004 address to pin.

    /// @notice Anvil account 0 private key. Used ONLY as the dry-run default so a
    /// keyless `forge script` simulates the deploy. A live broadcast must supply a
    /// real funded REGISTRY_ADMIN_PRIVATE_KEY in .env.local (never committed).
    uint256 internal constant DEFAULT_DRY_RUN_PK =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    /// @notice Fixed per-contract CREATE2 salts. Stable salts make the derived
    /// addresses reproducible across runs and across operators (ID-03).
    bytes32 internal constant IDENTITY_SALT = keccak256("utter.erc8004.identity.v1");
    bytes32 internal constant REPUTATION_SALT = keccak256("utter.erc8004.reputation.v1");
    bytes32 internal constant VALIDATION_SALT = keccak256("utter.erc8004.validation.v1");

    function run() external {
        // Owner / deployer from env with a documented dry-run default so the keyless
        // run needs no operator setup. The owner is reserved for future admin hooks;
        // register/giveFeedback/validation are not owner-gated in this reference.
        uint256 deployerPk = vm.envOr("REGISTRY_ADMIN_PRIVATE_KEY", DEFAULT_DRY_RUN_PK);
        address deployer = vm.addr(deployerPk);
        address owner = vm.envOr("CONTRACT_OWNER", deployer);

        if (owner == deployer) {
            console.log("WARNING: CONTRACT_OWNER unset, defaulting to deployer. Set it for production.");
        }

        console.log("CREATE2 factory (reference):", CREATE2_FACTORY);

        vm.startBroadcast(deployerPk);

        // Deterministic CREATE2 deploys: the address is a pure function of the
        // deployer, the fixed salt, and the initcode (constructor args included).
        IdentityRegistry identity = new IdentityRegistry{salt: IDENTITY_SALT}(owner);
        ReputationRegistry reputation = new ReputationRegistry{salt: REPUTATION_SALT}();
        ValidationRegistry validation = new ValidationRegistry{salt: VALIDATION_SALT}();

        vm.stopBroadcast();

        // Print the derived addresses so the operator can pin them into
        // packages/chain/src/addresses.ts (the deferred post-deploy step).
        console.log("IdentityRegistry:  ", address(identity));
        console.log("ReputationRegistry:", address(reputation));
        console.log("ValidationRegistry:", address(validation));
        console.log("owner:             ", owner);
    }
}
