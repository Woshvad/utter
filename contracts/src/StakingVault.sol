// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IResourceRegistry} from "./interfaces/IResourceRegistry.sol";

/// @notice Per-resource USDC bond custody with an in-vault insurance pool
/// (CONTRACT-05, CONTRACT-07, D-06). A creator deposits a bond per resource to
/// back the trust loop. A slash moves the slashed amount into the insurance pool
/// while the funds stay inside this vault's custody boundary. Slashed funds
/// reimburse affected buyers through the admin-only refund capability, which is
/// guarded against draining the pool beyond its balance.
///
/// Slash coupling: a slash is coupled to the ResourceRegistry on chain. slash
/// first consumes a matured, matching authorization the slasher recorded on the
/// registry (consumeSlashAuthorization), then runs the bond and insurance
/// effects. So one key alone cannot slash a bond: it must record an
/// authorization on the registry, wait the cancelable dispute window, then call
/// slash here, which consumes the exact authorization once.
///
/// Withdraw is gated by a cooldown that starts when the creator requests it, so
/// a creator cannot front-run a pending slash by withdrawing first. Slashing is
/// permitted at any time, including during an active cooldown, which closes the
/// withdraw-to-dodge path (01-RESEARCH Pitfall 5).
///
/// Admin model: access is split across OpenZeppelin AccessControl roles instead
/// of a single owner. SLASHER_ROLE gates slash; TREASURY_ADMIN_ROLE gates
/// refund, so the key that can slash a bond is distinct from the key that can
/// disburse insurance funds. DEFAULT_ADMIN_ROLE is the role admin that grants
/// and revokes those roles and is handed over through the 2-step, time-delayed,
/// non-brickable transfer of AccessControlDefaultAdminRules so the admin key can
/// move to a multisig (01-RESEARCH Pitfall 4).
///
/// All amounts are USDC base units. Arc USDC is 6-decimal, but no decimals
/// literal or scaling appears in this contract; base units are the only unit on
/// chain (D-07). Every USDC-touching function uses SafeERC20 for transfers and
/// follows checks-effects-interactions under a ReentrancyGuard.
contract StakingVault is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Gates slash. Held by the off-chain scorer / slasher.
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    /// @notice Gates refund (insurance-pool disbursement). Held by the treasury
    /// operator, distinct from the slasher.
    bytes32 public constant TREASURY_ADMIN_ROLE = keccak256("TREASURY_ADMIN_ROLE");

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

    /// @notice The ResourceRegistry this vault consumes slash authorizations from.
    /// Immutable after deploy. slash consumes a matured authorization here before
    /// touching the bond, coupling the two contracts on chain.
    IResourceRegistry public immutable registry;

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
    /// @param registry_ The ResourceRegistry this vault consumes slash
    /// authorizations from. Must be non-zero.
    /// @param initialAdminDelay Delay enforced on the 2-step DEFAULT_ADMIN_ROLE
    /// transfer (AccessControlDefaultAdminRules).
    /// @param initialAdmin Holder of DEFAULT_ADMIN_ROLE, which grants and revokes
    /// the specific roles. Must be non-zero.
    /// @param slasher Granted SLASHER_ROLE (slash).
    /// @param treasuryAdmin Granted TREASURY_ADMIN_ROLE (refund).
    constructor(
        IERC20 usdc_,
        IResourceRegistry registry_,
        uint48 initialAdminDelay,
        address initialAdmin,
        address slasher,
        address treasuryAdmin
    ) AccessControlDefaultAdminRules(initialAdminDelay, initialAdmin) {
        if (address(registry_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
        registry = registry_;
        _grantRole(SLASHER_ROLE, slasher);
        _grantRole(TREASURY_ADMIN_ROLE, treasuryAdmin);
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

    /// @notice Slash a resource's bond into the insurance pool. SLASHER_ROLE only.
    /// The slashed amount moves from the bond to insurancePoolBalance and stays in
    /// vault custody; no tokens leave. Permitted at any time, including during an
    /// active withdraw cooldown, which closes the withdraw-to-dodge path.
    /// @dev Coupled to the ResourceRegistry on chain. This first calls
    /// registry.consumeSlashAuthorization(resourceId, amount), which reverts
    /// unless the slasher recorded a matching authorization on the registry and
    /// its dispute window has elapsed, and which clears the authorization so it is
    /// single-use. Only then does the existing bond / insurance effect run. The
    /// whole call is atomic under nonReentrant, so a failed consume leaves the
    /// bond untouched. The amount must equal the recorded authorization exactly.
    /// @param resourceId The resource whose bond is slashed.
    /// @param amount USDC base units to slash.
    /// @param reason Human-readable reason emitted for the indexer.
    function slash(bytes32 resourceId, uint256 amount, string calldata reason)
        external
        onlyRole(SLASHER_ROLE)
        nonReentrant
    {
        registry.consumeSlashAuthorization(resourceId, amount);

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

    /// @notice Refund a buyer from the insurance pool. TREASURY_ADMIN_ROLE only
    /// (the in-vault InsurancePool.refund capability, CONTRACT-07). Reverts if the amount
    /// exceeds the pool balance, which prevents draining the pool past what
    /// slashing has funded (over-refund guard, D-06).
    /// @param payer The buyer to reimburse.
    /// @param amount USDC base units to pay out.
    function refund(address payer, uint256 amount) external onlyRole(TREASURY_ADMIN_ROLE) nonReentrant {
        if (payer == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > insurancePoolBalance) revert OverRefund();

        insurancePoolBalance -= amount;

        usdc.safeTransfer(payer, amount);

        emit Refunded(payer, amount);
    }
}
