// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Per-resource USDC bond custody with an in-vault insurance pool
/// (CONTRACT-05, CONTRACT-07, D-06). A creator deposits a bond per resource to
/// back the trust loop. The registry admin can slash a failing resource's bond,
/// which moves the slashed amount into the insurance pool while the funds stay
/// inside this vault's custody boundary. Slashed funds reimburse affected buyers
/// through the admin-only refund capability, which is guarded against draining
/// the pool beyond its balance.
///
/// Withdraw is gated by a cooldown that starts when the creator requests it, so
/// a creator cannot front-run a pending slash by withdrawing first. Slashing is
/// permitted at any time, including during an active cooldown, which closes the
/// withdraw-to-dodge path (01-RESEARCH Pitfall 5).
///
/// Admin model: a single Ownable owner can both slash and refund. This is the
/// MVP choice (D-04). A single key that can slash bonds and disburse insurance
/// funds is an admin-key concentration risk. Production should split distinct
/// SLASHER and TREASURY-ADMIN roles via AccessControl and place the owner behind
/// a multisig (01-RESEARCH Pitfall 4). That hardening is out of scope for the
/// MVP and is accepted as a documented threat-model item.
///
/// All amounts are USDC base units. Arc USDC is 6-decimal, but no decimals
/// literal or scaling appears in this contract; base units are the only unit on
/// chain (D-07). Every USDC-touching function uses SafeERC20 for transfers and
/// follows checks-effects-interactions under a ReentrancyGuard.
contract StakingVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The bond is below the minimum required after a deposit.
    error BelowMinBond();
    /// @notice A withdraw was attempted before the cooldown elapsed.
    error CooldownActive();
    /// @notice withdraw was called without a prior requestWithdraw.
    error WithdrawNotRequested();
    /// @notice withdraw was attempted but the resource holds no bond.
    error NothingToWithdraw();
    /// @notice A refund exceeds the available insurance pool balance.
    error OverRefund();
    /// @notice A bond action was attempted by an address that is not the bond owner.
    error NotBondOwner();
    /// @notice A deposit targeted a bond already owned by a different address.
    error BondOwnerMismatch();
    /// @notice A slash exceeds the resource's bond balance.
    error SlashExceedsBond();
    /// @notice A zero amount was supplied where a positive amount is required.
    error ZeroAmount();
    /// @notice A zero address was supplied where a real address is required.
    error ZeroAddress();

    /// @notice The USDC token bonds are denominated in. Immutable after deploy.
    IERC20 public immutable usdc;

    /// @notice Per-resource bond balance in USDC base units (D-06).
    mapping(bytes32 => uint256) public bonds;

    /// @notice The address that deposited a resource's bond and may withdraw it.
    mapping(bytes32 => address) public bondOwner;

    /// @notice Timestamp at which a resource's withdraw cooldown elapses. Zero
    /// means no withdraw has been requested.
    mapping(bytes32 => uint256) public cooldownEnds;

    /// @notice USDC held to reimburse buyers, funded by slashing. Stays in this
    /// vault's custody; slashing never transfers tokens out.
    uint256 public insurancePoolBalance;

    /// @notice Cooldown a creator must wait between requesting and finalizing a
    /// bond withdraw (spec §9.13, default 7 days).
    uint256 public constant COOLDOWN = 7 days;

    /// @notice Minimum bond a resource must hold after a deposit. 1_000_000 base
    /// units is $1 at 6 decimals (spec §16, MIN_BOND_BASE_UNITS).
    uint256 public constant MIN_BOND_BASE_UNITS = 1_000_000;

    /// @notice Emitted when a creator deposits into a resource's bond.
    event BondDeposited(bytes32 indexed resourceId, address indexed owner, uint256 amount);
    /// @notice Emitted when the admin slashes a bond into the insurance pool.
    event Slashed(bytes32 indexed resourceId, uint256 amount, string reason);
    /// @notice Emitted when a creator requests a bond withdraw, starting the cooldown.
    event WithdrawRequested(bytes32 indexed resourceId, uint256 cooldownEnds);
    /// @notice Emitted when a creator finalizes a bond withdraw after cooldown.
    event BondWithdrawn(bytes32 indexed resourceId, address indexed owner, uint256 amount);
    /// @notice Emitted when the admin refunds a buyer from the insurance pool.
    event Refunded(address indexed payer, uint256 amount);

    /// @param usdc_ The USDC token bonds are denominated in.
    /// @param initialOwner The registry admin that may slash and refund.
    constructor(IERC20 usdc_, address initialOwner) Ownable(initialOwner) {
        usdc = usdc_;
    }

    /// @notice Deposit into a resource's bond. Pulls USDC from the caller. The
    /// first depositor becomes the bond owner; afterwards only that owner may top
    /// up, so a second depositor can never seize ownership of another creator's
    /// combined bond (a resourceId is globally known, so an unconditional owner
    /// overwrite would let an attacker capture an existing bond for the price of
    /// MIN_BOND). The resulting bond must meet the minimum. A deposit clears any
    /// pending withdraw cooldown so a fresh bond is not instantly withdrawable on
    /// stale request state.
    /// @param resourceId The resource the bond backs.
    /// @param amount USDC base units to add to the bond.
    function deposit(bytes32 resourceId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        address current = bondOwner[resourceId];
        if (current != address(0) && current != msg.sender) revert BondOwnerMismatch();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 newBond = bonds[resourceId] + amount;
        if (newBond < MIN_BOND_BASE_UNITS) revert BelowMinBond();

        bonds[resourceId] = newBond;
        if (current == address(0)) bondOwner[resourceId] = msg.sender;
        cooldownEnds[resourceId] = 0;

        emit BondDeposited(resourceId, msg.sender, amount);
    }

    /// @notice Slash a resource's bond into the insurance pool. Admin-only. The
    /// slashed amount moves from the bond to insurancePoolBalance and stays in
    /// vault custody; no tokens leave. Permitted at any time, including during an
    /// active withdraw cooldown, which closes the withdraw-to-dodge path.
    /// @dev The `amount` is supplied directly by the admin and is NOT reconciled
    /// on chain against any ResourceRegistry authorization. The registry's
    /// `slashAuthorization` event is ADVISORY-ONLY: it is an indexer signal that a
    /// slash is intended, not an on-chain spend authorization that this function
    /// consumes. The off-chain scorer / admin drives the real spend by calling
    /// `slash(resourceId, amount, reason)` with consistent values. The two
    /// contracts share no state; full on-chain coupling is an accepted
    /// out-of-scope design item under the MVP single-key threat model (D-04).
    /// @param resourceId The resource whose bond is slashed.
    /// @param amount USDC base units to slash.
    /// @param reason Human-readable reason emitted for the indexer.
    function slash(bytes32 resourceId, uint256 amount, string calldata reason)
        external
        onlyOwner
        nonReentrant
    {
        if (amount > bonds[resourceId]) revert SlashExceedsBond();

        bonds[resourceId] -= amount;
        insurancePoolBalance += amount;

        emit Slashed(resourceId, amount, reason);
    }

    /// @notice Request a bond withdraw, starting the cooldown. Only the bond
    /// owner may request. The cooldown is set on request, not on deposit, so an
    /// old bond is never instantly withdrawable (01-RESEARCH Pitfall 5).
    /// @param resourceId The resource whose bond will be withdrawn.
    function requestWithdraw(bytes32 resourceId) external {
        if (msg.sender != bondOwner[resourceId]) revert NotBondOwner();

        uint256 ends = block.timestamp + COOLDOWN;
        cooldownEnds[resourceId] = ends;

        emit WithdrawRequested(resourceId, ends);
    }

    /// @notice Finalize a bond withdraw after the cooldown elapses. Only the bond
    /// owner may withdraw, a request must have been made, and the cooldown must
    /// have passed. Transfers the full remaining bond out.
    /// @param resourceId The resource whose bond is withdrawn.
    function withdraw(bytes32 resourceId) external nonReentrant {
        if (msg.sender != bondOwner[resourceId]) revert NotBondOwner();

        uint256 ends = cooldownEnds[resourceId];
        if (ends == 0) revert WithdrawNotRequested();
        // Cooldown enforced: withdraw only proceeds when
        // block.timestamp >= cooldownEnds[resourceId]; otherwise it reverts.
        if (!(block.timestamp >= cooldownEnds[resourceId])) revert CooldownActive();

        uint256 amount = bonds[resourceId];
        if (amount == 0) revert NothingToWithdraw();

        bonds[resourceId] = 0;
        cooldownEnds[resourceId] = 0;

        usdc.safeTransfer(msg.sender, amount);

        emit BondWithdrawn(resourceId, msg.sender, amount);
    }

    /// @notice Refund a buyer from the insurance pool. Admin-only (the in-vault
    /// InsurancePool.refund capability, CONTRACT-07). Reverts if the amount
    /// exceeds the pool balance, which prevents draining the pool past what
    /// slashing has funded (over-refund guard, D-06).
    /// @param payer The buyer to reimburse.
    /// @param amount USDC base units to pay out.
    function refund(address payer, uint256 amount) external onlyOwner nonReentrant {
        if (payer == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > insurancePoolBalance) revert OverRefund();

        insurancePoolBalance -= amount;

        usdc.safeTransfer(payer, amount);

        emit Refunded(payer, amount);
    }
}
