// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {IResourceRegistry} from "../src/interfaces/IResourceRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {EIP712SignHelper} from "./helpers/EIP712SignHelper.sol";

/// @notice CONTRACT-01 / CONTRACT-02 (+ the CONTRACT-04 debit-inactive row)
/// tests for the primary escrow path. They prove the deposit -> debit(<= signed
/// cap) -> withdraw cycle credits the buyer, decrements by amount, splits 70/30
/// creator/treasury with the remainder to treasury, and lets parties withdraw
/// real USDC; and that debit rejects replayed nonces, expired authorizations,
/// over-cap amounts, forged signatures, non-admin callers, and inactive
/// resources. The split-conservation invariant is fuzzed.
///
/// Signatures are produced by the independent EIP712SignHelper, which rebuilds
/// the EIP-712 digest from scratch rather than via the contract. A passing
/// recovery therefore cross-checks that the contract's domain (UtterEscrow / 1)
/// and DebitAuthorization typehash field order match the canonical layout
/// (01-RESEARCH Pitfall 1).
contract PaymentEscrowTest is Test, EIP712SignHelper {
    PaymentEscrow internal escrow;
    ResourceRegistry internal registry;
    MockERC20 internal usdc;

    address internal owner = makeAddr("owner");
    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");

    address internal buyer;
    uint256 internal buyerPk;

    bytes32 internal constant RESOURCE_ID = keccak256("resource-1");
    bytes32 internal constant AGENT_ID = keccak256("agent-1");
    bytes32 internal constant PRICING_HASH = keccak256("pricing-1");
    uint16 internal constant CREATOR_BPS = 7000;
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    uint256 internal constant DEPOSIT_AMOUNT = 1_000_000; // 1 USDC at 6 decimals

    // Mirror the Debited event so vm.expectEmit can match it.
    event Debited(
        bytes32 indexed resourceId,
        address indexed buyer,
        uint256 amount,
        uint256 toCreator,
        uint256 toTreasury,
        bytes32 nonce
    );

    function setUp() public {
        (buyer, buyerPk) = makeAddrAndKey("buyer");

        usdc = new MockERC20();
        registry = new ResourceRegistry(owner);
        escrow = new PaymentEscrow(IERC20(address(usdc)), IResourceRegistry(address(registry)), admin, owner);

        vm.prank(owner);
        registry.register(RESOURCE_ID, creator, treasury, CREATOR_BPS, AGENT_ID, PRICING_HASH);

        usdc.mint(buyer, DEPOSIT_AMOUNT);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(buyer);
        escrow.deposit(DEPOSIT_AMOUNT);
    }

    /// @notice deposit pulls USDC out of the buyer and credits balanceOf.
    function test_deposit_creditsBalance() public {
        // setUp already deposited DEPOSIT_AMOUNT; deposit a fresh increment.
        uint256 extra = 250_000;
        usdc.mint(buyer, extra);
        uint256 escrowBalBefore = usdc.balanceOf(address(escrow));

        vm.prank(buyer);
        escrow.deposit(extra);

        assertEq(escrow.balanceOf(buyer), DEPOSIT_AMOUNT + extra, "internal balance credited");
        assertEq(usdc.balanceOf(address(escrow)), escrowBalBefore + extra, "real USDC pulled in");
        assertEq(usdc.balanceOf(buyer), 0, "buyer wallet drained by deposit");
    }

    /// @notice a valid signed debit decrements the buyer by amount and credits
    /// the floored creator share and the treasury remainder.
    function test_debit_splitsAndDecrements() public {
        uint256 amount = 300_000;
        uint256 maxAmount = 300_000;
        bytes32 nonce = keccak256("nonce-split");
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, maxAmount, nonce, validBefore);

        uint256 expectedCreator = (amount * CREATOR_BPS) / BPS_DENOMINATOR;
        uint256 expectedTreasury = amount - expectedCreator;

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Debited(RESOURCE_ID, buyer, amount, expectedCreator, expectedTreasury, nonce);

        vm.prank(admin);
        escrow.debit(buyer, RESOURCE_ID, amount, maxAmount, nonce, validBefore, sig);

        assertEq(escrow.balanceOf(buyer), DEPOSIT_AMOUNT - amount, "buyer decremented by amount");
        assertEq(escrow.balanceOf(creator), expectedCreator, "creator credited floored share");
        assertEq(escrow.balanceOf(treasury), expectedTreasury, "treasury credited remainder");
        assertEq(expectedCreator + expectedTreasury, amount, "split conserves amount");
        assertTrue(escrow.usedNonce(nonce), "nonce marked used");
    }

    /// @notice amount above the signed cap reverts (AmountExceedsCap).
    function test_debit_revertsWhenAmountExceedsCap() public {
        uint256 maxAmount = 200_000;
        uint256 amount = 200_001; // one base unit over the cap
        bytes32 nonce = keccak256("nonce-cap");
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, maxAmount, nonce, validBefore);

        vm.prank(admin);
        vm.expectRevert(PaymentEscrow.AmountExceedsCap.selector);
        escrow.debit(buyer, RESOURCE_ID, amount, maxAmount, nonce, validBefore, sig);
    }

    /// @notice after a debit the creator can withdraw real USDC out via SafeERC20.
    function test_withdraw_transfersOut() public {
        uint256 amount = 300_000;
        bytes32 nonce = keccak256("nonce-withdraw");
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, amount, nonce, validBefore);
        vm.prank(admin);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);

        uint256 creatorShare = (amount * CREATOR_BPS) / BPS_DENOMINATOR;
        assertEq(escrow.balanceOf(creator), creatorShare, "creator has internal balance");

        vm.prank(creator);
        escrow.withdraw(creatorShare);

        assertEq(escrow.balanceOf(creator), 0, "internal balance drained");
        assertEq(usdc.balanceOf(creator), creatorShare, "real USDC delivered to creator");
    }

    /// @notice the split conserves the debited amount and floors the creator
    /// share for any fuzzed amount and basis-point share.
    function testFuzz_split_remainderToTreasury(uint256 amount, uint16 bps) public {
        bps = uint16(bound(uint256(bps), 0, BPS_DENOMINATOR));
        // Keep the debit within the buyer's funded balance; require a positive
        // amount so the case is meaningful.
        amount = bound(amount, 1, DEPOSIT_AMOUNT);

        // Re-point the resource bps to the fuzzed value.
        vm.prank(owner);
        registry.update(RESOURCE_ID, treasury, bps, AGENT_ID, PRICING_HASH);

        bytes32 nonce = keccak256(abi.encodePacked("nonce-fuzz", amount, bps));
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, amount, nonce, validBefore);

        vm.prank(admin);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);

        uint256 toCreator = escrow.balanceOf(creator);
        uint256 toTreasury = escrow.balanceOf(treasury);

        assertEq(toCreator, (amount * bps) / BPS_DENOMINATOR, "creator share floored");
        assertEq(toCreator + toTreasury, amount, "split conserves amount");
        assertLe(toCreator, amount, "creator share never exceeds amount");
    }

    /// @notice re-submitting the same nonce reverts (NonceUsed).
    function test_debit_revertsOnNonceReplay() public {
        uint256 amount = 100_000;
        bytes32 nonce = keccak256("nonce-replay");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, amount, nonce, validBefore);

        vm.prank(admin);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);

        // Same nonce again, even with a fresh valid signature, must revert.
        vm.prank(admin);
        vm.expectRevert(PaymentEscrow.NonceUsed.selector);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);
    }

    /// @notice a validBefore in the past reverts (Expired).
    function test_debit_revertsWhenExpired() public {
        uint256 amount = 100_000;
        bytes32 nonce = keccak256("nonce-expired");
        // Warp forward so we can place validBefore strictly in the past.
        vm.warp(block.timestamp + 10);
        uint256 validBefore = block.timestamp - 1;
        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, amount, nonce, validBefore);

        vm.prank(admin);
        vm.expectRevert(PaymentEscrow.Expired.selector);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);
    }

    /// @notice a signature from a non-buyer key reverts (BadSignature).
    function test_debit_revertsOnBadSignature() public {
        (, uint256 otherPk) = makeAddrAndKey("attacker");
        uint256 amount = 100_000;
        bytes32 nonce = keccak256("nonce-badsig");
        uint256 validBefore = block.timestamp + 1 hours;

        // Sign with the attacker key but claim the auth is the buyer's.
        bytes memory sig = _signDebit(otherPk, address(escrow), buyer, RESOURCE_ID, amount, nonce, validBefore);

        vm.prank(admin);
        vm.expectRevert(PaymentEscrow.BadSignature.selector);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);
    }

    /// @notice a signature built by the independent helper recovers to the buyer,
    /// proving the contract domain / typehash match the canonical EIP-712 layout.
    function test_debit_acceptsValidSignature() public {
        uint256 amount = 123_456;
        bytes32 nonce = keccak256("nonce-valid");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, amount, nonce, validBefore);

        vm.prank(admin);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);

        assertTrue(escrow.usedNonce(nonce), "valid signature consumed the nonce");
        assertEq(escrow.balanceOf(buyer), DEPOSIT_AMOUNT - amount, "buyer debited on valid sig");
    }

    /// @notice a non-admin caller reverts (NotAdmin) even with a valid signature.
    function test_debit_revertsWhenCallerNotAdmin() public {
        uint256 amount = 100_000;
        bytes32 nonce = keccak256("nonce-notadmin");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, amount, nonce, validBefore);

        // The buyer (or any non-admin) cannot submit the debit.
        vm.prank(buyer);
        vm.expectRevert(PaymentEscrow.NotAdmin.selector);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);
    }

    /// @notice a paused resource reverts (ResourceInactive).
    function test_debit_revertsWhenResourceInactive() public {
        vm.prank(owner);
        registry.pause(RESOURCE_ID);

        uint256 amount = 100_000;
        bytes32 nonce = keccak256("nonce-inactive");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(buyerPk, address(escrow), buyer, RESOURCE_ID, amount, nonce, validBefore);

        vm.prank(admin);
        vm.expectRevert(PaymentEscrow.ResourceInactive.selector);
        escrow.debit(buyer, RESOURCE_ID, amount, amount, nonce, validBefore, sig);
    }
}
