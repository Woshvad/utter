// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";

/// @notice EIP-712 signing helper for PaymentEscrow DebitAuthorization tests.
///
/// This helper independently reconstructs the EIP-712 digest (domain separator
/// + struct hash) rather than asking the contract under test to build it. A
/// passing recovery in a test therefore proves the contract's domain and
/// typehash encoding are byte-identical to the canonical EIP-712 layout,
/// guarding against field-order drift (01-RESEARCH Pitfall 1) between the
/// Solidity typehash and the Phase 2 client signTypedData call.
///
/// Locked cross-phase constants (Utter-SPEC.md §9.4): domain name "UtterEscrow",
/// version "1", chainId 5042002. The field order buyer, resourceId, maxAmount,
/// nonce, validBefore must match the client types array exactly.
abstract contract EIP712SignHelper is CommonBase {
    bytes32 internal constant DEBIT_TYPEHASH = keccak256(
        "DebitAuthorization(address buyer,bytes32 resourceId,uint256 maxAmount,bytes32 nonce,uint256 validBefore)"
    );

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @param buyerPk      private key of the buyer signing the authorization
    /// @param escrow       deployed PaymentEscrow address (verifyingContract)
    /// @param buyer        buyer address embedded in the struct
    /// @param resourceId   bytes32 resource identifier
    /// @param maxAmount    signed spend cap in USDC base units
    /// @param nonce        single-use bytes32 replay nonce
    /// @param validBefore  unix expiry timestamp
    /// @return sig         65-byte (r, s, v) signature
    function _signDebit(
        uint256 buyerPk,
        address escrow,
        address buyer,
        bytes32 resourceId,
        uint256 maxAmount,
        bytes32 nonce,
        uint256 validBefore
    ) internal view returns (bytes memory sig) {
        bytes32 structHash =
            keccak256(abi.encode(DEBIT_TYPEHASH, buyer, resourceId, maxAmount, nonce, validBefore));

        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("UtterEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                escrow
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }
}
