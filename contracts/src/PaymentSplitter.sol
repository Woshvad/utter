// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Bespoke flat-path splitter for the exact / EIP-3009 scheme
/// (CONTRACT-03, D-03). It holds USDC transferred to it and distribute()
/// flushes the configured creatorBps split to the creator with the rounding
/// remainder routed to treasury, mirroring the inline split applied by the
/// escrow path so payout attribution is consistent across both money paths.
///
/// This is a custom contract. OpenZeppelin removed its deprecated splitter in
/// v5.x; there is no OZ import to clash with and none is used here.
///
/// Admin model: the split config setters (setSplit, setTreasury) are gated by
/// DEFAULT_ADMIN_ROLE, which is handed over through the 2-step, time-delayed,
/// non-brickable transfer of AccessControlDefaultAdminRules so the admin key can
/// move to a multisig (01-RESEARCH Pitfall 4). distribute is permissionless.
contract PaymentSplitter is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Basis-point denominator. creatorBps is expressed against 10000.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice The USDC token this splitter holds and pays out. The Arc USDC
    /// contract exposes a 6-decimal ERC-20 interface; all amounts are base
    /// units, never scaled by decimals.
    IERC20 public immutable usdc;

    /// @notice Recipient of the creator share.
    address public creator;

    /// @notice Recipient of the platform / treasury share plus rounding dust.
    address public treasury;

    /// @notice Creator share in basis points (0..10000). Default 7000 (70/30).
    uint16 public creatorBps;

    /// @notice Emitted on every distribute() that flushes the held balance.
    event Distributed(address indexed creator, address indexed treasury, uint256 toCreator, uint256 toTreasury);

    /// @notice Emitted when the admin mutates the split config.
    event SplitConfigured(uint16 creatorBps, address treasury);

    /// @notice creatorBps exceeds the 10000 denominator.
    error InvalidBps();

    /// @notice A required address argument was the zero address.
    error ZeroAddress();

    constructor(
        IERC20 _usdc,
        address _creator,
        address _treasury,
        uint16 _creatorBps,
        uint48 initialAdminDelay,
        address initialAdmin
    ) AccessControlDefaultAdminRules(initialAdminDelay, initialAdmin) {
        if (address(_usdc) == address(0) || _creator == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
        if (_creatorBps > BPS_DENOMINATOR) revert InvalidBps();
        usdc = _usdc;
        creator = _creator;
        treasury = _treasury;
        creatorBps = _creatorBps;
    }

    /// @notice Flush the contract's full USDC balance, splitting it by the
    /// configured creatorBps. The creator share is floored; the remainder
    /// (which absorbs any rounding dust) goes to treasury, so the split is
    /// conserved exactly (toCreator + toTreasury == balance) with no leak.
    /// Permissionless: anyone may call it, but funds only ever route to the
    /// pre-configured creator and treasury.
    function distribute() external nonReentrant {
        uint256 bal = usdc.balanceOf(address(this));
        // Nothing held: short-circuit so a no-op distribute does not emit an
        // empty Distributed(creator, treasury, 0, 0) event into the indexer.
        if (bal == 0) return;
        uint256 toCreator = (bal * creatorBps) / BPS_DENOMINATOR;
        uint256 toTreasury = bal - toCreator;

        usdc.safeTransfer(creator, toCreator);
        usdc.safeTransfer(treasury, toTreasury);

        emit Distributed(creator, treasury, toCreator, toTreasury);
    }

    /// @notice DEFAULT_ADMIN_ROLE-gated update of the creator basis-point share.
    function setSplit(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps > BPS_DENOMINATOR) revert InvalidBps();
        creatorBps = newBps;
        emit SplitConfigured(newBps, treasury);
    }

    /// @notice DEFAULT_ADMIN_ROLE-gated update of the treasury recipient.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit SplitConfigured(creatorBps, newTreasury);
    }
}
