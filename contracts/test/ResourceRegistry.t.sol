// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";

/// @notice CONTRACT-04 tests for the resource config store: register stores the
/// config and emits the indexer event, pause / unpause flips the active flag,
/// and every mutator is owner-gated (non-owner reverts with the OZ v5
/// OwnableUnauthorizedAccount error).
contract ResourceRegistryTest is Test {
    ResourceRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");

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
        registry = new ResourceRegistry(owner);
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

    /// @notice A non-owner caller to register / pause / slashAuthorization reverts
    /// with OZ v5 OwnableUnauthorizedAccount(caller).
    function test_registry_onlyAdminGuards() public {
        // register guard
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.register(RESOURCE_ID, creator, treasury, CREATOR_BPS, AGENT_ID, PRICING_HASH);

        // register a resource as owner so pause / slash have an existing target
        _register();

        // pause guard
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.pause(RESOURCE_ID);

        // slashAuthorization guard
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.slashAuthorization(RESOURCE_ID, 1_000_000, "fraud");
    }
}
