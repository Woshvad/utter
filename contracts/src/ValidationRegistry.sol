// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ERC-8004 reference ValidationRegistry for Arc Testnet (ID-02, ID-03).
/// Arc has NO canonical ERC-8004 deployment (05-RESEARCH Pitfall 1); this minimal
/// reference matches the EIP-8004 validationRequest / validationResponse signatures
/// byte-for-byte so a future canonical Arc deployment is a drop-in ABI swap.
///
/// A requester asks a named validator to attest an agent (the IdentityRegistry
/// tokenId); the validator later answers against the same requestHash. The contract
/// records the request so a response can be bound to it and emits indexer events; it
/// holds no funds, so no amount-math literal appears here.
contract ValidationRegistry {
    /// @notice The validator a recorded request is addressed to, keyed by requestHash.
    /// A zero validator means no request was recorded for that requestHash.
    mapping(bytes32 => address) public requestValidator;

    /// @notice A zero agentId was supplied. agentId is the IdentityRegistry tokenId,
    /// which starts at 1, so zero can never be a real agent.
    error UnknownAgent();
    /// @notice A zero validator address was supplied for a validation request.
    error ZeroValidator();
    /// @notice A request was already recorded for this requestHash.
    error RequestExists();
    /// @notice No request was recorded for the responded requestHash.
    error UnknownRequest();
    /// @notice A validationResponse came from an address that is not the addressed
    /// validator, which would let anyone forge an attestation.
    error NotValidator();

    /// @notice Emitted when a validation is requested. Mirrors the EIP-8004
    /// validationRequest signature so a canonical swap stays ABI-compatible.
    event ValidationRequested(
        address indexed validator,
        uint256 indexed agentId,
        string requestURI,
        bytes32 requestHash
    );

    /// @notice Emitted when the addressed validator answers a request. Mirrors the
    /// EIP-8004 validationResponse signature.
    event ValidationResponded(
        bytes32 indexed requestHash,
        address indexed validator,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    /// @notice Request that `validator` attest `agentId`.
    /// @dev Reverts UnknownAgent on a zero agentId, ZeroValidator on a zero validator,
    /// and RequestExists if the requestHash was already recorded. Matches the EIP-8004
    /// validationRequest argument names and order exactly.
    /// @param validator The address asked to produce the attestation.
    /// @param agentId The IdentityRegistry tokenId being validated.
    /// @param requestURI Off-chain location of the full request payload.
    /// @param requestHash Content hash binding the request; the response answers it.
    function validationRequest(
        address validator,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        if (agentId == 0) revert UnknownAgent();
        if (validator == address(0)) revert ZeroValidator();
        if (requestValidator[requestHash] != address(0)) revert RequestExists();

        requestValidator[requestHash] = validator;

        emit ValidationRequested(validator, agentId, requestURI, requestHash);
    }

    /// @notice Answer a recorded validation request. Only the addressed validator may
    /// respond, which prevents a third party forging an attestation.
    /// @dev Reverts UnknownRequest if no request was recorded for requestHash and
    /// NotValidator if the caller is not the addressed validator. Matches the EIP-8004
    /// validationResponse argument names and order exactly.
    /// @param requestHash The requestHash this response answers.
    /// @param response The validator's verdict code (caller-defined scale).
    /// @param responseURI Off-chain location of the full response payload.
    /// @param responseHash Content hash binding the off-chain response payload.
    /// @param tag Free-form category tag for indexing.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        address validator = requestValidator[requestHash];
        if (validator == address(0)) revert UnknownRequest();
        if (msg.sender != validator) revert NotValidator();

        emit ValidationResponded(requestHash, validator, response, responseURI, responseHash, tag);
    }
}
