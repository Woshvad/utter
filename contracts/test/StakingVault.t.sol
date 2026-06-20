// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice CONTRACT-05 + CONTRACT-07 tests for the bond / slash / cooldown /
/// refund matrix. A creator deposits a bond, the admin slashes it into the
/// in-vault insurance pool, withdraw is blocked until the cooldown elapses while
/// slashing still works during cooldown, and the admin refunds buyers from the
/// pool with an over-refund guard and an only-admin guard.
contract StakingVaultTest is Test {
    StakingVault internal vault;
    MockERC20 internal usdc;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant RESOURCE_ID = keccak256("resource-1");

    // A bond comfortably above MIN_BOND_BASE_UNITS (1e6 == $1 at 6dp).
    uint256 internal constant BOND = 10_000_000; // $10

    // Mirror the contract events so vm.expectEmit can match them.
    event BondDeposited(bytes32 indexed resourceId, address indexed owner, uint256 amount);
    event Slashed(bytes32 indexed resourceId, uint256 amount, string reason);
    event BondWithdrawn(bytes32 indexed resourceId, address indexed owner, uint256 amount);
    event Refunded(address indexed payer, uint256 amount);

    function setUp() public {
        usdc = new MockERC20();
        vault = new StakingVault(IERC20(address(usdc)), owner);

        usdc.mint(creator, 1_000_000_000); // plenty of USDC for the creator
        vm.prank(creator);
        usdc.approve(address(vault), type(uint256).max);

        // The stranger is funded and approved so a takeover attempt fails on the
        // ownership guard, not on a missing balance or allowance.
        usdc.mint(stranger, 1_000_000_000);
        vm.prank(stranger);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// A second depositor cannot seize an existing bond: once creator owns the
    /// bond, a stranger's deposit reverts BondOwnerMismatch and ownership and the
    /// bond balance are untouched. The original owner can still top up.
    function test_deposit_rejectsBondOwnerTakeover() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        // Stranger attempts to take over the resource's bond.
        vm.expectRevert(StakingVault.BondOwnerMismatch.selector);
        vm.prank(stranger);
        vault.deposit(RESOURCE_ID, BOND);

        // Ownership and bond balance are unchanged by the rejected takeover.
        assertEq(vault.bondOwner(RESOURCE_ID), creator, "owner changed by takeover attempt");
        assertEq(vault.bonds(RESOURCE_ID), BOND, "bond changed by takeover attempt");

        // The original owner can still top up the same bond.
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);
        assertEq(vault.bonds(RESOURCE_ID), BOND * 2, "owner top-up not credited");
        assertEq(vault.bondOwner(RESOURCE_ID), creator, "owner changed by top-up");
    }

    /// A zero-amount deposit reverts ZeroAmount rather than emitting a no-op event.
    function test_deposit_revertsOnZeroAmount() public {
        vm.expectRevert(StakingVault.ZeroAmount.selector);
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, 0);
    }

    /// A zero-address payer refund reverts ZeroAddress (defense in depth).
    function test_refund_revertsOnZeroAddressPayer() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, 4_000_000, "scorer:5-strikes");

        vm.expectRevert(StakingVault.ZeroAddress.selector);
        vm.prank(owner);
        vault.refund(address(0), 1_000_000);
    }

    /// Deposit credits bonds[resourceId] and pulls USDC into the vault.
    function test_bondDeposit_credits() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        assertEq(vault.bonds(RESOURCE_ID), BOND, "bond not credited");
        assertEq(usdc.balanceOf(address(vault)), BOND, "vault did not receive USDC");
        assertEq(vault.bondOwner(RESOURCE_ID), creator, "bond owner not set");
    }

    /// Admin slash decrements the bond, increments insurancePoolBalance, emits
    /// Slashed(reason); a non-admin slash reverts.
    function test_slash_movesToInsurancePool() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 4_000_000;

        vm.expectEmit(true, false, false, true);
        emit Slashed(RESOURCE_ID, slashAmount, "scorer:5-strikes");
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:5-strikes");

        assertEq(vault.bonds(RESOURCE_ID), BOND - slashAmount, "bond not decremented");
        assertEq(vault.insurancePoolBalance(), slashAmount, "insurance pool not credited");
        // Funds stay in vault custody: no token left the vault on slash.
        assertEq(usdc.balanceOf(address(vault)), BOND, "vault balance changed on slash");

        // Non-admin slash reverts.
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        vault.slash(RESOURCE_ID, slashAmount, "unauthorized");
    }

    /// requestWithdraw then immediate withdraw reverts (CooldownActive); after
    /// warping past the cooldown, withdraw succeeds and transfers the bond out.
    function test_bondWithdraw_enforcesCooldown() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        vm.prank(creator);
        vault.requestWithdraw(RESOURCE_ID);

        // Immediate withdraw is blocked by the cooldown.
        vm.expectRevert(StakingVault.CooldownActive.selector);
        vm.prank(creator);
        vault.withdraw(RESOURCE_ID);

        // Warp past the cooldown.
        vm.warp(block.timestamp + 7 days);

        uint256 creatorBefore = usdc.balanceOf(creator);

        vm.expectEmit(true, true, false, true);
        emit BondWithdrawn(RESOURCE_ID, creator, BOND);
        vm.prank(creator);
        vault.withdraw(RESOURCE_ID);

        assertEq(vault.bonds(RESOURCE_ID), 0, "bond not cleared");
        assertEq(usdc.balanceOf(creator), creatorBefore + BOND, "bond not returned to creator");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault still holds USDC");
    }

    /// After requestWithdraw, an admin slash during the cooldown window still
    /// succeeds, so a creator cannot front-run a pending slash.
    function test_slash_duringCooldown() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        vm.prank(creator);
        vault.requestWithdraw(RESOURCE_ID);

        // Move forward one day, still inside the 7-day cooldown.
        vm.warp(block.timestamp + 1 days);

        uint256 slashAmount = 3_000_000;
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:strikes-during-cooldown");

        assertEq(vault.bonds(RESOURCE_ID), BOND - slashAmount, "bond not slashed during cooldown");
        assertEq(vault.insurancePoolBalance(), slashAmount, "insurance pool not credited");
    }

    /// After a slash funds the pool, admin refund transfers USDC to the payer and
    /// decrements insurancePoolBalance.
    function test_refund_paysFromInsurancePool() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 6_000_000;
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:5-strikes");

        uint256 refundAmount = 2_500_000;

        vm.expectEmit(true, false, false, true);
        emit Refunded(payer, refundAmount);
        vm.prank(owner);
        vault.refund(payer, refundAmount);

        assertEq(usdc.balanceOf(payer), refundAmount, "payer not reimbursed");
        assertEq(
            vault.insurancePoolBalance(),
            slashAmount - refundAmount,
            "insurance pool not decremented"
        );
    }

    /// Refund greater than the pool balance reverts (OverRefund).
    function test_refund_revertsOnOverRefund() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 5_000_000;
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:5-strikes");

        uint256 poolBalance = vault.insurancePoolBalance();

        vm.expectRevert(StakingVault.OverRefund.selector);
        vm.prank(owner);
        vault.refund(payer, poolBalance + 1);
    }

    /// Non-admin refund reverts (OwnableUnauthorizedAccount).
    function test_refund_onlyAdmin() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        vm.prank(owner);
        vault.slash(RESOURCE_ID, 4_000_000, "scorer:5-strikes");

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        vault.refund(payer, 1_000_000);
    }
}
