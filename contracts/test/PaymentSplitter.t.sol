// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PaymentSplitter} from "../src/PaymentSplitter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice CONTRACT-03 tests: distribute() flushes the configured bps split
/// with the rounding remainder to treasury, and the split is conserved under
/// fuzz (toCreator + toTreasury == amount, no dust leak — Pattern 3).
contract PaymentSplitterTest is Test {
    uint16 internal constant DEFAULT_BPS = 7000; // 70/30 creator/treasury (D-03)
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    MockERC20 internal usdc;
    PaymentSplitter internal splitter;

    address internal creator = address(0xC0FFEE);
    address internal treasury = address(0x7EA);
    address internal owner = address(0x0E0E);

    function setUp() public {
        usdc = new MockERC20();
        splitter = new PaymentSplitter(IERC20(address(usdc)), creator, treasury, DEFAULT_BPS, owner);
    }

    /// @notice Mint a deliberately non-divisible amount into the splitter, flush
    /// it, and assert the creator received the floored share, treasury received
    /// the remainder, and the splitter is drained to zero.
    function test_distribute_splitsHeldBalance() public {
        uint256 amount = 1_000_001; // not divisible by the bps split
        usdc.mint(address(splitter), amount);

        uint256 expectedCreator = (amount * DEFAULT_BPS) / BPS_DENOMINATOR;
        uint256 expectedTreasury = amount - expectedCreator;

        splitter.distribute();

        assertEq(usdc.balanceOf(creator), expectedCreator, "creator share");
        assertEq(usdc.balanceOf(treasury), expectedTreasury, "treasury share");
        assertEq(usdc.balanceOf(address(splitter)), 0, "splitter drained");
    }

    /// @notice Conservation invariant under fuzz: for any amount and any bps in
    /// [0, 10000], the creator share is exactly floor(amount*bps/10000), the
    /// treasury share is the remainder, and the two sum back to the full amount
    /// with no dust left behind.
    function testFuzz_distribute_rounding(uint256 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, BPS_DENOMINATOR));
        amount = bound(amount, 0, 1e24);

        // Fresh distinct recipients per run so prior-balance carryover cannot
        // mask a dust leak.
        address c = address(uint160(uint256(keccak256(abi.encode(amount, bps, "creator")))));
        address t = address(uint160(uint256(keccak256(abi.encode(amount, bps, "treasury")))));
        vm.assume(c != t && c != address(0) && t != address(0));

        PaymentSplitter s = new PaymentSplitter(IERC20(address(usdc)), c, t, bps, owner);
        usdc.mint(address(s), amount);

        s.distribute();

        uint256 toCreator = usdc.balanceOf(c);
        uint256 toTreasury = usdc.balanceOf(t);

        assertEq(toCreator, (amount * bps) / BPS_DENOMINATOR, "floored creator share");
        assertEq(toTreasury, amount - toCreator, "treasury remainder");
        assertEq(toCreator + toTreasury, amount, "split conservation");
        assertEq(usdc.balanceOf(address(s)), 0, "splitter drained");
    }
}
