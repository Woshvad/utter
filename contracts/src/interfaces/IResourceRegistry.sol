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
}
