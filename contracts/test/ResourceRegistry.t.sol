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

    bytes32 internal constant RESOURCE_ID = keccak256("resource-1");
    bytes32 internal constant AGENT_ID = keccak256("agent-1");
    bytes32 internal constant PRICING_HASH = keccak256("pricing-1");
    uint16 internal constant CREATOR_BPS = 7000;

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

    function setUp() public {
        // The single owner holds DEFAULT_ADMIN_ROLE plus REGISTRY_ADMIN_ROLE and
        // SLASHER_ROLE, mirroring the old single owner. Zero delay: no admin
        // transfer is exercised here.
        registry = new ResourceRegistry(uint48(0), owner, owner, owner);
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
}
