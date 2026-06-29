// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IResourceRegistry} from "./interfaces/IResourceRegistry.sol";

/// @notice On-chain config store for Utter resources (CONTRACT-04, D-05). Each
/// resource is keyed by a bytes32 resourceId and holds the creator, the split
/// recipients (treasury) and basis points, the agent identity, a pricing hash,
/// the active flag, and a mirror of the posted bond. Mutators emit events the
/// off-chain indexer and marketplace consume, and getResource / isActive are the
/// reads PaymentEscrow performs in Wave 3 to read the split config and gate a
/// debit on the resource being active (pause mirrors Scorer deactivation).
///
/// Admin model: access is split across OpenZeppelin AccessControl roles instead
/// of a single owner. REGISTRY_ADMIN_ROLE gates register / update / pause /
/// unpause / setBond; SLASHER_ROLE gates slashAuthorization; VAULT_ROLE gates
/// consumeSlashAuthorization (granted to the StakingVault so only the vault may
/// consume a recorded authorization); DEFAULT_ADMIN_ROLE gates
/// cancelSlashAuthorization (the dispute authority during the window).
/// DEFAULT_ADMIN_ROLE is the role admin that grants and revokes those roles and
/// is itself handed over through the 2-step, time-delayed, non-brickable
/// transfer of AccessControlDefaultAdminRules, so the admin key can be moved to a
/// multisig without a single key holding every privilege (01-RESEARCH Pitfall 4).
///
/// Slash coupling: the slash path is coupled to the StakingVault on chain. The
/// slasher records a pending authorization with a dispute window; after the
/// window elapses the vault consumes the exact authorization once. One key alone
/// cannot slash a bond: it must record here, wait the cancelable window, then
/// call the vault, which consumes the matured matching authorization.
contract ResourceRegistry is IResourceRegistry, AccessControlDefaultAdminRules {
    /// @notice Gates the resource config mutators (register, update, pause,
    /// unpause, setBond). Held by the registry operator.
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");

    /// @notice Gates slashAuthorization. Held by the off-chain scorer / slasher.
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    /// @notice Gates consumeSlashAuthorization. Granted to the StakingVault
    /// post-deploy so only the vault may consume a recorded authorization; a
    /// direct external caller, even the slasher, cannot consume.
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    /// @notice Basis-point denominator. creatorBps is expressed against 10000.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Time between recording a slash authorization and the moment the
    /// vault may consume it. During this window DEFAULT_ADMIN may cancel the
    /// authorization to dispute the slash.
    uint64 public constant SLASH_DISPUTE_WINDOW = 1 days;

    /// @notice Per-resource config. exists distinguishes a never-registered
    /// resource (default zero struct) from a registered one, since active alone
    /// is ambiguous with a paused resource.
    struct Resource {
        address creator;
        address treasury;
        uint16 creatorBps;
        bytes32 agentId;
        bytes32 pricingHash;
        bool active;
        uint256 bond;
        bool exists;
    }

    /// @notice resourceId to its config. Internal so reads go through the
    /// interface getters that enforce the exists invariant.
    mapping(bytes32 => Resource) internal resources;

    /// @notice A recorded slash authorization awaiting the dispute window. amount
    /// zero means no authorization is pending (the default zero struct).
    /// executableAt is the timestamp the vault may consume from.
    struct PendingSlash {
        uint256 amount;
        uint64 executableAt;
    }

    /// @notice resourceId to its pending slash authorization. Internal; read via
    /// getPendingSlash, recorded by slashAuthorization, cleared on consume/cancel.
    mapping(bytes32 => PendingSlash) internal pendingSlashes;

    /// @notice Emitted when a new resource is registered. The indexer builds the
    /// marketplace listing from this event.
    event ResourceRegistered(
        bytes32 indexed resourceId,
        address indexed creator,
        address treasury,
        uint16 creatorBps,
        bytes32 agentId,
        bytes32 pricingHash
    );

    /// @notice Emitted when the mutable config of an existing resource changes.
    event ResourceUpdated(
        bytes32 indexed resourceId, address treasury, uint16 creatorBps, bytes32 agentId, bytes32 pricingHash
    );

    /// @notice Emitted when a resource is paused (active set to false).
    event ResourcePaused(bytes32 indexed resourceId);

    /// @notice Emitted when a resource is unpaused (active set to true).
    event ResourceUnpaused(bytes32 indexed resourceId);

    /// @notice On-chain authorization that drives the StakingVault slash. The
    /// registry records the amount, reason, and the timestamp the slash matures
    /// (executableAt) so indexers see when the dispute window elapses. It does not
    /// move funds; the vault consumes the authorization after the window.
    event ResourceSlashAuthorized(bytes32 indexed resourceId, uint256 amount, string reason, uint64 executableAt);

    /// @notice Emitted when the StakingVault consumes a matured authorization as
    /// the first step of a slash. The pending authorization is cleared.
    event ResourceSlashConsumed(bytes32 indexed resourceId, uint256 amount);

    /// @notice Emitted when DEFAULT_ADMIN cancels a pending authorization during
    /// the dispute window. The pending authorization is cleared and no slash runs.
    event ResourceSlashCancelled(bytes32 indexed resourceId, uint256 amount);

    /// @notice Emitted when the posted bond mirror is updated.
    event ResourceBondSet(bytes32 indexed resourceId, uint256 bond);

    /// @notice The resourceId is already registered.
    error AlreadyRegistered();
    /// @notice The resourceId has not been registered.
    error UnknownResource();
    /// @notice creatorBps exceeds the 10000 basis-point ceiling.
    error InvalidBps();
    /// @notice creator or treasury was the zero address, which would route its
    /// split share to balanceOf[address(0)] in the escrow and lock it forever.
    error ZeroAddress();
    /// @notice No slash authorization is pending for the resource (consume or
    /// cancel was called with nothing recorded, or it was already consumed).
    error NoPendingSlash();
    /// @notice The consume amount does not match the recorded authorization.
    error SlashAmountMismatch();
    /// @notice The dispute window has not yet elapsed, so the slash cannot run.
    error SlashWindowActive();

    /// @param initialAdminDelay Delay enforced on the 2-step DEFAULT_ADMIN_ROLE
    /// transfer (AccessControlDefaultAdminRules).
    /// @param initialAdmin Holder of DEFAULT_ADMIN_ROLE, which grants and revokes
    /// the specific roles. Must be non-zero.
    /// @param registryAdmin Granted REGISTRY_ADMIN_ROLE (config mutators).
    /// @param slasher Granted SLASHER_ROLE (slashAuthorization).
    constructor(uint48 initialAdminDelay, address initialAdmin, address registryAdmin, address slasher)
        AccessControlDefaultAdminRules(initialAdminDelay, initialAdmin)
    {
        _grantRole(REGISTRY_ADMIN_ROLE, registryAdmin);
        _grantRole(SLASHER_ROLE, slasher);
    }

    /// @notice Register a new resource with its split config and metadata.
    /// @dev Reverts AlreadyRegistered if the resourceId is taken and InvalidBps
    /// if creatorBps exceeds the denominator. Stores active true.
    function register(
        bytes32 resourceId,
        address creator,
        address treasury,
        uint16 creatorBps,
        bytes32 agentId,
        bytes32 pricingHash
    ) external onlyRole(REGISTRY_ADMIN_ROLE) {
        if (resources[resourceId].exists) revert AlreadyRegistered();
        if (creator == address(0) || treasury == address(0)) revert ZeroAddress();
        if (creatorBps > BPS_DENOMINATOR) revert InvalidBps();

        resources[resourceId] = Resource({
            creator: creator,
            treasury: treasury,
            creatorBps: creatorBps,
            agentId: agentId,
            pricingHash: pricingHash,
            active: true,
            bond: 0,
            exists: true
        });

        emit ResourceRegistered(resourceId, creator, treasury, creatorBps, agentId, pricingHash);
    }

    /// @notice Update the mutable config of an existing resource. The creator and
    /// active flag are not changed here; pause / unpause handle activation.
    /// @dev Reverts UnknownResource if not registered, InvalidBps on bad bps.
    function update(bytes32 resourceId, address treasury, uint16 creatorBps, bytes32 agentId, bytes32 pricingHash)
        external
        onlyRole(REGISTRY_ADMIN_ROLE)
    {
        Resource storage r = resources[resourceId];
        if (!r.exists) revert UnknownResource();
        if (treasury == address(0)) revert ZeroAddress();
        if (creatorBps > BPS_DENOMINATOR) revert InvalidBps();

        r.treasury = treasury;
        r.creatorBps = creatorBps;
        r.agentId = agentId;
        r.pricingHash = pricingHash;

        emit ResourceUpdated(resourceId, treasury, creatorBps, agentId, pricingHash);
    }

    /// @notice Pause a resource. A paused resource reads active false so the
    /// escrow active-check blocks its debits (mirrors Scorer deactivation).
    function pause(bytes32 resourceId) external onlyRole(REGISTRY_ADMIN_ROLE) {
        Resource storage r = resources[resourceId];
        if (!r.exists) revert UnknownResource();
        r.active = false;
        emit ResourcePaused(resourceId);
    }

    /// @notice Unpause a resource, restoring its active state.
    function unpause(bytes32 resourceId) external onlyRole(REGISTRY_ADMIN_ROLE) {
        Resource storage r = resources[resourceId];
        if (!r.exists) revert UnknownResource();
        r.active = true;
        emit ResourceUnpaused(resourceId);
    }

    /// @notice Record a slash authorization against a resource bond, starting the
    /// dispute window.
    /// @dev This is no longer advisory-only. It records an on-chain authorization
    /// `{amount, executableAt = now + SLASH_DISPUTE_WINDOW}` that the StakingVault
    /// consumes through consumeSlashAuthorization once the window elapses. During
    /// the window DEFAULT_ADMIN may cancelSlashAuthorization to dispute the slash.
    /// A new authorization overwrites any prior pending one for the resource.
    /// @param resourceId The resource whose bond may be slashed.
    /// @param amount USDC base units to authorize for slashing.
    /// @param reason Human-readable reason emitted for the indexer.
    function slashAuthorization(bytes32 resourceId, uint256 amount, string calldata reason)
        external
        onlyRole(SLASHER_ROLE)
    {
        if (!resources[resourceId].exists) revert UnknownResource();

        uint64 executableAt = uint64(block.timestamp) + SLASH_DISPUTE_WINDOW;
        pendingSlashes[resourceId] = PendingSlash({amount: amount, executableAt: executableAt});

        emit ResourceSlashAuthorized(resourceId, amount, reason, executableAt);
    }

    /// @notice Cancel a pending slash authorization during the dispute window.
    /// DEFAULT_ADMIN_ROLE only (the dispute authority). Clears the pending
    /// authorization so the vault can no longer consume it.
    /// @dev Reverts NoPendingSlash if nothing is recorded. A cancelled
    /// authorization is deleted; the slasher must record a fresh one to slash.
    /// @param resourceId The resource whose pending authorization is cancelled.
    function cancelSlashAuthorization(bytes32 resourceId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        PendingSlash memory p = pendingSlashes[resourceId];
        if (p.amount == 0) revert NoPendingSlash();

        delete pendingSlashes[resourceId];

        emit ResourceSlashCancelled(resourceId, p.amount);
    }

    /// @inheritdoc IResourceRegistry
    function consumeSlashAuthorization(bytes32 resourceId, uint256 amount) external onlyRole(VAULT_ROLE) {
        PendingSlash memory p = pendingSlashes[resourceId];
        if (p.amount == 0) revert NoPendingSlash();
        if (p.amount != amount) revert SlashAmountMismatch();
        if (block.timestamp < p.executableAt) revert SlashWindowActive();

        delete pendingSlashes[resourceId];

        emit ResourceSlashConsumed(resourceId, amount);
    }

    /// @inheritdoc IResourceRegistry
    function getPendingSlash(bytes32 resourceId) external view returns (uint256 amount, uint64 executableAt) {
        PendingSlash memory p = pendingSlashes[resourceId];
        return (p.amount, p.executableAt);
    }

    /// @notice Record the posted bond mirror for a resource. The real custody
    /// lives in the StakingVault; this is the registry-side reflection.
    function setBond(bytes32 resourceId, uint256 bond) external onlyRole(REGISTRY_ADMIN_ROLE) {
        Resource storage r = resources[resourceId];
        if (!r.exists) revert UnknownResource();
        r.bond = bond;
        emit ResourceBondSet(resourceId, bond);
    }

    /// @inheritdoc IResourceRegistry
    function getResource(bytes32 resourceId)
        external
        view
        returns (address creator, address treasury, uint16 creatorBps, bool active)
    {
        Resource storage r = resources[resourceId];
        if (!r.exists) revert UnknownResource();
        return (r.creator, r.treasury, r.creatorBps, r.active);
    }

    /// @inheritdoc IResourceRegistry
    function isActive(bytes32 resourceId) external view returns (bool) {
        Resource storage r = resources[resourceId];
        return r.exists && r.active;
    }
}
