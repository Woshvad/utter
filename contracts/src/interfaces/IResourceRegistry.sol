// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Read interface for the on-chain resource config store
/// (CONTRACT-04, D-05). PaymentEscrow.debit consumes exactly these two reads in
/// Wave 3: getResource supplies the split config (creator, treasury, creatorBps)
/// and the active flag, and isActive is the cheap active-check the debit path
/// uses to block paused resources. Defining the interface first means the escrow
/// plan receives a contract to import rather than reverse engineering the store.
interface IResourceRegistry {
    /// @notice Return the split config and active state for a resource.
    /// @dev Reverts UnknownResource if the resource was never registered. The
    /// escrow path reads creator and treasury as the split recipients,
    /// creatorBps as the basis-point share, and active to gate the debit.
    /// @param resourceId The bytes32 key identifying the resource.
    /// @return creator Recipient of the creator share.
    /// @return treasury Recipient of the platform share plus rounding dust.
    /// @return creatorBps Creator share in basis points (0..10000).
    /// @return active Whether the resource is currently live (not paused).
    function getResource(bytes32 resourceId)
        external
        view
        returns (address creator, address treasury, uint16 creatorBps, bool active);

    /// @notice Whether the resource is registered and currently active.
    /// @dev Returns false for both an unknown resource and a paused one, so the
    /// escrow active-check is a single boolean read with no revert handling.
    /// @param resourceId The bytes32 key identifying the resource.
    /// @return Whether the resource exists and is active.
    function isActive(bytes32 resourceId) external view returns (bool);

    /// @notice Consume a matured slash authorization for a resource. The
    /// StakingVault calls this as the first step of slash, so a bond can only be
    /// slashed after a registry authorization has been recorded, its dispute
    /// window has elapsed, and the amount matches exactly.
    /// @dev VAULT_ROLE-gated so only the StakingVault may consume; even the
    /// slasher cannot consume directly. Single-use: the pending authorization is
    /// cleared on consume. Reverts NoPendingSlash if none is recorded,
    /// SlashAmountMismatch if amount does not match the recorded amount, and
    /// SlashWindowActive if the dispute window has not yet elapsed.
    /// @param resourceId The resource whose pending slash is consumed.
    /// @param amount The slash amount, which must equal the recorded amount.
    function consumeSlashAuthorization(bytes32 resourceId, uint256 amount) external;

    /// @notice Read the pending slash authorization recorded for a resource.
    /// @dev Returns (0, 0) when no authorization is pending. executableAt is the
    /// timestamp at which the dispute window elapses and the vault may consume.
    /// @param resourceId The resource to read.
    /// @return amount The recorded slash amount, or 0 if none is pending.
    /// @return executableAt The timestamp the slash matures, or 0 if none.
    function getPendingSlash(bytes32 resourceId) external view returns (uint256 amount, uint64 executableAt);
}
