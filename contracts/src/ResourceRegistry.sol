// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IResourceRegistry} from "./interfaces/IResourceRegistry.sol";

/// @notice On-chain config store for Utter resources (CONTRACT-04, D-05). Each
/// resource is keyed by a bytes32 resourceId and holds the creator, the split
/// recipients (treasury) and basis points, the agent identity, a pricing hash,
/// the active flag, and a mirror of the posted bond. Mutators emit events the
/// off-chain indexer and marketplace consume, and getResource / isActive are the
/// reads PaymentEscrow performs in Wave 3 to read the split config and gate a
/// debit on the resource being active (pause mirrors Scorer deactivation).
///
/// Admin model: every mutator is gated by a single Ownable owner, which is the
/// MVP choice (D-04). A single key that can register, pause, authorize slashes,
/// and set bonds is an admin-key concentration risk. Production should split
/// distinct REGISTRY-ADMIN and SLASHER roles via AccessControl and place the
/// owner behind a multisig (01-RESEARCH Pitfall 4). That hardening is out of
/// scope for the MVP and is accepted as a documented threat-model item.
contract ResourceRegistry is IResourceRegistry, Ownable {
    /// @notice Basis-point denominator. creatorBps is expressed against 10000.
    uint16 public constant BPS_DENOMINATOR = 10_000;

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

    /// @notice On-chain authorization signal that drives the StakingVault slash.
    /// The registry records the intent and reason; it does not move funds.
    event ResourceSlashAuthorized(bytes32 indexed resourceId, uint256 amount, string reason);

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

    /// @param initialOwner The registry admin (OZ v5 Ownable takes the owner).
    constructor(address initialOwner) Ownable(initialOwner) {}

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
    ) external onlyOwner {
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
    function update(
        bytes32 resourceId,
        address treasury,
        uint16 creatorBps,
        bytes32 agentId,
        bytes32 pricingHash
    ) external onlyOwner {
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
    function pause(bytes32 resourceId) external onlyOwner {
        Resource storage r = resources[resourceId];
        if (!r.exists) revert UnknownResource();
        r.active = false;
        emit ResourcePaused(resourceId);
    }

    /// @notice Unpause a resource, restoring its active state.
    function unpause(bytes32 resourceId) external onlyOwner {
        Resource storage r = resources[resourceId];
        if (!r.exists) revert UnknownResource();
        r.active = true;
        emit ResourceUnpaused(resourceId);
    }

    /// @notice Authorize a slash against a resource bond.
    /// @dev ADVISORY-ONLY. This emits an indexer signal that a slash is intended;
    /// it does not custody or move funds and is NOT consumed or reconciled on
    /// chain by StakingVault.slash. The off-chain scorer / admin drives the actual
    /// spend by calling StakingVault.slash(resourceId, amount, reason) directly
    /// with consistent values. The two contracts share no state; this event must
    /// not be relied on as an on-chain spend authorization. Full on-chain coupling
    /// is an accepted out-of-scope design item under the MVP single-key threat
    /// model (D-04).
    function slashAuthorization(bytes32 resourceId, uint256 amount, string calldata reason) external onlyOwner {
        if (!resources[resourceId].exists) revert UnknownResource();
        emit ResourceSlashAuthorized(resourceId, amount, reason);
    }

    /// @notice Record the posted bond mirror for a resource. The real custody
    /// lives in the StakingVault; this is the registry-side reflection.
    function setBond(bytes32 resourceId, uint256 bond) external onlyOwner {
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
