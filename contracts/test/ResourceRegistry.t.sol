// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";

/// @notice CONTRACT-04 tests for the resource config store: register stores the
/// config and emits the indexer event, pause / unpause flips the active flag,
/// and every mutator is role-gated (an unauthorized caller reverts with the OZ
/// AccessControlUnauthorizedAccount error for the specific required role). The
/// single test admin holds DEFAULT_ADMIN_ROLE plus both specific roles, so the
/// existing positive-path tests behave exactly like the old single owner.
contract ResourceRegistryTest is Test {
    ResourceRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal slasher2 = makeAddr("slasher2");
    // A stand-in for the StakingVault. It is granted VAULT_ROLE so it can consume
    // authorizations; consume is VAULT_ROLE-gated, not vault-contract-specific.
    address internal vault = makeAddr("vault");

    bytes32 internal constant RESOURCE_ID = keccak256("resource-1");
    bytes32 internal constant AGENT_ID = keccak256("agent-1");
    bytes32 internal constant PRICING_HASH = keccak256("pricing-1");
    uint16 internal constant CREATOR_BPS = 7000;
    uint256 internal constant SLASH_AMOUNT = 1_000_000;

    // Mirror the contract events so vm.expectEmit can match them.
    event ResourceRegistered(
        bytes32 indexed resourceId,
        address indexed creator,
        address treasury,
        uint16 creatorBps,
        bytes32 agentId,
        bytes32 pricingHash
    );
    event ResourcePaused(bytes32 indexed resourceId);
    event ResourceUnpaused(bytes32 indexed resourceId);
    event ResourceSlashAuthorized(bytes32 indexed resourceId, uint256 amount, string reason, uint64 executableAt);
    event ResourceSlashConsumed(bytes32 indexed resourceId, uint256 amount);
    event ResourceSlashCancelled(bytes32 indexed resourceId, uint256 amount);

    function setUp() public {
        // The single owner holds DEFAULT_ADMIN_ROLE plus REGISTRY_ADMIN_ROLE and
        // SLASHER_ROLE, mirroring the old single owner. Zero delay: no admin
        // transfer is exercised here.
        registry = new ResourceRegistry(uint48(0), owner, owner, owner);

        // Grant the vault stand-in VAULT_ROLE so it can consume authorizations.
        // Cache the role before the prank so the role read does not consume it.
        bytes32 vaultRole = registry.VAULT_ROLE();
        vm.prank(owner);
        registry.grantRole(vaultRole, vault);
    }

    function _register() internal {
        vm.prank(owner);
        registry.register(RESOURCE_ID, creator, treasury, CREATOR_BPS, AGENT_ID, PRICING_HASH);
    }

    /// @notice register emits ResourceRegistered and getResource returns the
    /// stored creator / treasury / creatorBps with active == true.
    function test_register_storesConfigEmitsEvent() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit ResourceRegistered(RESOURCE_ID, creator, treasury, CREATOR_BPS, AGENT_ID, PRICING_HASH);

        vm.prank(owner);
        registry.register(RESOURCE_ID, creator, treasury, CREATOR_BPS, AGENT_ID, PRICING_HASH);

        (address gotCreator, address gotTreasury, uint16 gotBps, bool active) = registry.getResource(RESOURCE_ID);
        assertEq(gotCreator, creator, "creator stored");
        assertEq(gotTreasury, treasury, "treasury stored");
        assertEq(gotBps, CREATOR_BPS, "creatorBps stored");
        assertTrue(active, "registered resource active");
        assertTrue(registry.isActive(RESOURCE_ID), "isActive true after register");
    }

    /// @notice pause flips active to false and emits ResourcePaused; unpause
    /// restores active to true.
    function test_pause_deactivatesResource() public {
        _register();

        vm.expectEmit(true, false, false, false, address(registry));
        emit ResourcePaused(RESOURCE_ID);
        vm.prank(owner);
        registry.pause(RESOURCE_ID);

        assertFalse(registry.isActive(RESOURCE_ID), "paused resource inactive");
        (,,, bool activeAfterPause) = registry.getResource(RESOURCE_ID);
        assertFalse(activeAfterPause, "getResource active false after pause");

        vm.expectEmit(true, false, false, false, address(registry));
        emit ResourceUnpaused(RESOURCE_ID);
        vm.prank(owner);
        registry.unpause(RESOURCE_ID);

        assertTrue(registry.isActive(RESOURCE_ID), "unpaused resource active");
    }

    /// @notice register reverts ZeroAddress when creator or treasury is the zero
    /// address, so the escrow split share can never be credited to address(0).
    function test_register_revertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ResourceRegistry.ZeroAddress.selector);
        registry.register(RESOURCE_ID, address(0), treasury, CREATOR_BPS, AGENT_ID, PRICING_HASH);

        vm.prank(owner);
        vm.expectRevert(ResourceRegistry.ZeroAddress.selector);
        registry.register(RESOURCE_ID, creator, address(0), CREATOR_BPS, AGENT_ID, PRICING_HASH);
    }

    /// @notice update reverts ZeroAddress when treasury is the zero address.
    function test_update_revertsOnZeroAddressTreasury() public {
        _register();

        vm.prank(owner);
        vm.expectRevert(ResourceRegistry.ZeroAddress.selector);
        registry.update(RESOURCE_ID, address(0), CREATOR_BPS, AGENT_ID, PRICING_HASH);
    }

    /// @notice An unauthorized caller to register / pause / slashAuthorization
    /// reverts with AccessControlUnauthorizedAccount(caller, role) for the
    /// specific role the function now requires.
    function test_registry_onlyAdminGuards() public {
        bytes32 registryRole = registry.REGISTRY_ADMIN_ROLE();
        bytes32 slasherRole = registry.SLASHER_ROLE();

        // register guard (REGISTRY_ADMIN_ROLE)
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, registryRole)
        );
        registry.register(RESOURCE_ID, creator, treasury, CREATOR_BPS, AGENT_ID, PRICING_HASH);

        // register a resource as owner so pause / slash have an existing target
        _register();

        // pause guard (REGISTRY_ADMIN_ROLE)
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, registryRole)
        );
        registry.pause(RESOURCE_ID);

        // slashAuthorization guard (SLASHER_ROLE)
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, slasherRole)
        );
        registry.slashAuthorization(RESOURCE_ID, 1_000_000, "fraud");
    }

    /// @notice The role split is enforced: an account holding REGISTRY_ADMIN_ROLE
    /// but NOT SLASHER_ROLE still cannot call slashAuthorization, proving the two
    /// privileges are distinct and not collapsed into one admin.
    function test_registry_registryAdminCannotSlash() public {
        _register();
        bytes32 slasherRole = registry.SLASHER_ROLE();

        // owner holds REGISTRY_ADMIN_ROLE here; revoke SLASHER_ROLE from owner so
        // it becomes a registry-admin-without-slasher case.
        vm.prank(owner);
        registry.revokeRole(slasherRole, owner);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, owner, slasherRole)
        );
        registry.slashAuthorization(RESOURCE_ID, 1_000_000, "fraud");
    }

    /// @notice SLASHER_ROLE is grantable: after the DEFAULT_ADMIN grants it to a
    /// second account, that account can call slashAuthorization.
    function test_registry_grantSlasherRoleLetsSecondAccountSlash() public {
        _register();
        bytes32 slasherRole = registry.SLASHER_ROLE();

        // slasher2 has no role yet, so it cannot slash.
        vm.prank(slasher2);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, slasher2, slasherRole)
        );
        registry.slashAuthorization(RESOURCE_ID, 1_000_000, "fraud");

        // The DEFAULT_ADMIN grants SLASHER_ROLE to slasher2.
        vm.prank(owner);
        registry.grantRole(slasherRole, slasher2);
        assertTrue(registry.hasRole(slasherRole, slasher2), "slasher2 not granted SLASHER_ROLE");

        // Now slasher2 can authorize a slash.
        vm.prank(slasher2);
        registry.slashAuthorization(RESOURCE_ID, 1_000_000, "fraud");
    }

    /// @notice slashAuthorization records a pending authorization with the dispute
    /// window and emits ResourceSlashAuthorized carrying executableAt;
    /// getPendingSlash returns the recorded amount and maturity timestamp.
    function test_slashAuthorization_recordsPendingWithWindow() public {
        _register();

        uint64 expectedExecutableAt = uint64(block.timestamp) + registry.SLASH_DISPUTE_WINDOW();

        vm.expectEmit(true, false, false, true, address(registry));
        emit ResourceSlashAuthorized(RESOURCE_ID, SLASH_AMOUNT, "fraud", expectedExecutableAt);
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "fraud");

        (uint256 amount, uint64 executableAt) = registry.getPendingSlash(RESOURCE_ID);
        assertEq(amount, SLASH_AMOUNT, "pending amount not recorded");
        assertEq(executableAt, expectedExecutableAt, "executableAt not recorded");
    }

    /// @notice A zero-amount slash authorization is rejected at the source, so the
    /// pending record never holds a meaningless zero the vault could not consume and
    /// getPendingSlash's "(0,0) means none" invariant always holds.
    function test_slashAuthorization_revertsOnZeroAmount() public {
        _register();
        vm.expectRevert(ResourceRegistry.ZeroSlashAmount.selector);
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, 0, "fraud");
    }

    /// @notice getPendingSlash returns (0, 0) when no authorization is pending.
    function test_getPendingSlash_zeroWhenNone() public {
        _register();
        (uint256 amount, uint64 executableAt) = registry.getPendingSlash(RESOURCE_ID);
        assertEq(amount, 0, "amount not zero with no authorization");
        assertEq(executableAt, 0, "executableAt not zero with no authorization");
    }

    /// @notice A new authorization overwrites a prior pending one for the resource.
    function test_slashAuthorization_overwritesPrior() public {
        _register();

        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "first");

        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT * 2, "second");

        (uint256 amount,) = registry.getPendingSlash(RESOURCE_ID);
        assertEq(amount, SLASH_AMOUNT * 2, "prior authorization not overwritten");
    }

    /// @notice The vault (VAULT_ROLE) consumes a matured matching authorization:
    /// it emits ResourceSlashConsumed and clears the pending authorization
    /// (single-use).
    function test_consumeSlashAuthorization_consumesMatured() public {
        _register();
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "fraud");
        vm.warp(block.timestamp + registry.SLASH_DISPUTE_WINDOW());

        vm.expectEmit(true, false, false, true, address(registry));
        emit ResourceSlashConsumed(RESOURCE_ID, SLASH_AMOUNT);
        vm.prank(vault);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT);

        (uint256 amount, uint64 executableAt) = registry.getPendingSlash(RESOURCE_ID);
        assertEq(amount, 0, "authorization not cleared on consume");
        assertEq(executableAt, 0, "executableAt not cleared on consume");
    }

    /// @notice consume reverts NoPendingSlash when none is recorded.
    function test_consumeSlashAuthorization_revertsWithoutPending() public {
        _register();
        vm.expectRevert(ResourceRegistry.NoPendingSlash.selector);
        vm.prank(vault);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT);
    }

    /// @notice consume reverts SlashAmountMismatch when the amount differs.
    function test_consumeSlashAuthorization_revertsOnAmountMismatch() public {
        _register();
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "fraud");
        vm.warp(block.timestamp + registry.SLASH_DISPUTE_WINDOW());

        vm.expectRevert(ResourceRegistry.SlashAmountMismatch.selector);
        vm.prank(vault);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT + 1);
    }

    /// @notice consume reverts SlashWindowActive before the dispute window elapses.
    function test_consumeSlashAuthorization_revertsBeforeWindow() public {
        _register();
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "fraud");
        // No warp: still inside the dispute window.

        vm.expectRevert(ResourceRegistry.SlashWindowActive.selector);
        vm.prank(vault);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT);
    }

    /// @notice An authorization is single-use: after the vault consumes it, a
    /// second consume reverts NoPendingSlash.
    function test_consumeSlashAuthorization_singleUse() public {
        _register();
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "fraud");
        vm.warp(block.timestamp + registry.SLASH_DISPUTE_WINDOW());

        vm.prank(vault);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT);

        vm.expectRevert(ResourceRegistry.NoPendingSlash.selector);
        vm.prank(vault);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT);
    }

    /// @notice consume is VAULT_ROLE-gated: a direct external caller, even the
    /// SLASHER, reverts AccessControlUnauthorizedAccount(VAULT_ROLE).
    function test_consumeSlashAuthorization_onlyVaultRole() public {
        _register();
        bytes32 vaultRole = registry.VAULT_ROLE();
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "fraud");
        vm.warp(block.timestamp + registry.SLASH_DISPUTE_WINDOW());

        // owner holds SLASHER_ROLE and DEFAULT_ADMIN but not VAULT_ROLE.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, owner, vaultRole)
        );
        vm.prank(owner);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT);

        // A stranger cannot consume either.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, vaultRole)
        );
        vm.prank(stranger);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT);
    }

    /// @notice cancelSlashAuthorization (DEFAULT_ADMIN) disputes a pending
    /// authorization: it emits ResourceSlashCancelled and clears the pending
    /// authorization, so a later consume reverts NoPendingSlash.
    function test_cancelSlashAuthorization_clearsPending() public {
        _register();
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "fraud");

        vm.expectEmit(true, false, false, true, address(registry));
        emit ResourceSlashCancelled(RESOURCE_ID, SLASH_AMOUNT);
        vm.prank(owner);
        registry.cancelSlashAuthorization(RESOURCE_ID);

        (uint256 amount, uint64 executableAt) = registry.getPendingSlash(RESOURCE_ID);
        assertEq(amount, 0, "authorization not cleared on cancel");
        assertEq(executableAt, 0, "executableAt not cleared on cancel");

        // Even after the window elapses, nothing remains to consume.
        vm.warp(block.timestamp + registry.SLASH_DISPUTE_WINDOW());
        vm.expectRevert(ResourceRegistry.NoPendingSlash.selector);
        vm.prank(vault);
        registry.consumeSlashAuthorization(RESOURCE_ID, SLASH_AMOUNT);
    }

    /// @notice cancel reverts NoPendingSlash when none is recorded.
    function test_cancelSlashAuthorization_revertsWithoutPending() public {
        _register();
        vm.expectRevert(ResourceRegistry.NoPendingSlash.selector);
        vm.prank(owner);
        registry.cancelSlashAuthorization(RESOURCE_ID);
    }

    /// @notice cancel is DEFAULT_ADMIN-gated: a non-admin caller reverts
    /// AccessControlUnauthorizedAccount(DEFAULT_ADMIN_ROLE), even the SLASHER.
    function test_cancelSlashAuthorization_onlyDefaultAdmin() public {
        _register();
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, SLASH_AMOUNT, "fraud");

        // slasher2 gets SLASHER_ROLE only; it still cannot cancel.
        bytes32 slasherRole = registry.SLASHER_ROLE();
        vm.prank(owner);
        registry.grantRole(slasherRole, slasher2);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, slasher2, adminRole)
        );
        vm.prank(slasher2);
        registry.cancelSlashAuthorization(RESOURCE_ID);
    }
}
