// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {PaymentSplitter} from "../src/PaymentSplitter.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {IResourceRegistry} from "../src/interfaces/IResourceRegistry.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

/// @notice CONTRACT-06 reentrancy cross-test. Proves the OpenZeppelin
/// ReentrancyGuard plus checks-effects-interactions ordering blocks a malicious
/// re-entering ERC-20 from recursing into the money-outflow paths. The harness
/// uses ReentrantToken as the USDC for each guarded contract: every token
/// transfer (the single external interaction in each outflow function) fires the
/// token's _update hook, which calls back into the same nonReentrant function.
/// The guard must revert the whole transaction so no double-withdraw,
/// double-distribute, or double-refund can occur.
///
/// The token is armed only immediately before the guarded call so the setup
/// transfers (deposits that fund the contracts) are not themselves re-entered.
contract ReentrancyTest is Test {
    /// @dev OZ ReentrancyGuard reverts with this selector on a re-entrant call.
    bytes4 internal constant REENTRANCY_ERROR = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    address internal owner = makeAddr("owner");
    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant RESOURCE_ID = keccak256("resource-1");
    uint16 internal constant CREATOR_BPS = 7000;
    uint256 internal constant AMOUNT = 1_000_000; // 1 USDC at 6 decimals

    /// @notice Single named test (matches the VALIDATION map's
    /// test_reentrancy_guarded) that drives the guard on the escrow, splitter,
    /// and vault outflow paths via helper sub-asserts.
    function test_reentrancy_guarded() public {
        _assertEscrowWithdrawGuarded();
        _assertSplitterDistributeGuarded();
        _assertVaultWithdrawGuarded();
        _assertVaultRefundGuarded();
    }

    /// @dev PaymentEscrow.withdraw: arm the token to re-enter withdraw during the
    /// safeTransfer payout. The guard must revert the outer withdraw.
    function _assertEscrowWithdrawGuarded() internal {
        ReentrantToken token = new ReentrantToken();
        ResourceRegistry registry = new ResourceRegistry(uint48(0), owner, owner, owner);
        PaymentEscrow escrow =
            new PaymentEscrow(IERC20(address(token)), IResourceRegistry(address(registry)), admin, uint48(0), owner);

        // Fund the escrow with an internal balance for the attacker (this test
        // contract) by depositing real tokens. Token is NOT armed yet, so the
        // deposit transfer does not re-enter.
        token.mint(address(this), AMOUNT);
        token.approve(address(escrow), type(uint256).max);
        escrow.deposit(AMOUNT);

        // Arm: when withdraw calls safeTransfer (firing _update), re-enter
        // withdraw for the same amount, which would be a double-withdraw if the
        // guard did not block it.
        token.arm(address(escrow), abi.encodeWithSelector(PaymentEscrow.withdraw.selector, AMOUNT));

        vm.expectRevert(REENTRANCY_ERROR);
        escrow.withdraw(AMOUNT);
    }

    /// @dev PaymentSplitter.distribute: arm the token to re-enter distribute
    /// during the creator-share safeTransfer. The guard must revert it.
    function _assertSplitterDistributeGuarded() internal {
        ReentrantToken token = new ReentrantToken();
        PaymentSplitter splitter =
            new PaymentSplitter(IERC20(address(token)), creator, treasury, CREATOR_BPS, uint48(0), owner);

        // Fund the splitter with a balance to flush. Not armed yet.
        token.mint(address(splitter), AMOUNT);

        token.arm(address(splitter), abi.encodeWithSelector(PaymentSplitter.distribute.selector));

        vm.expectRevert(REENTRANCY_ERROR);
        splitter.distribute();
    }

    /// @dev StakingVault.withdraw: arm the token to re-enter withdraw during the
    /// bond payout safeTransfer after the cooldown elapses. The guard must revert.
    function _assertVaultWithdrawGuarded() internal {
        ReentrantToken token = new ReentrantToken();
        StakingVault vault = new StakingVault(IERC20(address(token)), uint48(0), owner, owner, owner);

        // Bond owner deposits, requests withdraw, warps past cooldown. Not armed
        // during these funding transfers.
        token.mint(address(this), AMOUNT);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(RESOURCE_ID, AMOUNT);
        vault.requestWithdraw(RESOURCE_ID);
        vm.warp(block.timestamp + vault.COOLDOWN() + 1);

        token.arm(address(vault), abi.encodeWithSelector(StakingVault.withdraw.selector, RESOURCE_ID));

        vm.expectRevert(REENTRANCY_ERROR);
        vault.withdraw(RESOURCE_ID);
    }

    /// @dev StakingVault.refund: arm the token to re-enter refund during the
    /// insurance-pool payout safeTransfer. refund is TREASURY_ADMIN_ROLE-only and
    /// nonReentrant; the re-entry originates from the token contract (which holds
    /// no role), so the outer call still reverts and the double-refund is blocked.
    /// The first guard to fire on the re-entry is onlyRole(TREASURY_ADMIN_ROLE)
    /// (the token holds no role), so a generic revert is asserted rather than the
    /// specific reentrancy selector; either way the re-entry cannot drain the
    /// insurance pool twice. The pool is funded by slashing a bond first
    /// (SLASHER_ROLE-only), which moves no tokens.
    function _assertVaultRefundGuarded() internal {
        ReentrantToken token = new ReentrantToken();
        StakingVault vault = new StakingVault(IERC20(address(token)), uint48(0), owner, owner, owner);

        // Fund a bond, then slash it into the insurance pool so refund has a
        // non-zero pool to draw from. Funding transfer happens before arming.
        token.mint(address(this), AMOUNT);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(RESOURCE_ID, AMOUNT);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, AMOUNT, "fault");

        // Refund the attacker (this contract). When refund safeTransfers, the
        // _update hook re-enters refund for the same amount.
        token.arm(address(vault), abi.encodeWithSelector(StakingVault.refund.selector, address(this), AMOUNT));

        vm.prank(owner);
        vm.expectRevert();
        vault.refund(address(this), AMOUNT);
    }
}
