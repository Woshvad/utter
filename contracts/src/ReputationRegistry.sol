// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ERC-8004 reference ReputationRegistry for Arc Testnet (ID-02, ID-03).
/// Arc has NO canonical ERC-8004 deployment (05-RESEARCH Pitfall 1); this minimal
/// reference matches the EIP-8004 giveFeedback signature byte-for-byte so a future
/// canonical Arc deployment is a drop-in ABI swap.
///
/// A client records feedback about an agent identity (the IdentityRegistry tokenId).
/// The contract maintains a per-agent monotonic feedbackIndex and emits NewFeedback
/// for the off-chain indexer; it does not custody funds or score on chain.
///
/// Score encoding: `value` is an int128 with `valueDecimals` fixed-point places, per
/// the documented EIP-8004 convention value = round(score * 10 ** valueDecimals)
/// (05-RESEARCH Open Q2). This is a feedback-scale fixed-point convention for the
/// score field only; it is NOT a USDC amount and carries no money decimals literal.
contract ReputationRegistry {
    /// @notice Per-agent monotonic feedback counter. Indexed from 1, so a zero
    /// feedbackIndex unambiguously means "no feedback recorded" off chain.
    mapping(uint256 => uint64) public feedbackCount;

    /// @notice A zero agentId was supplied. agentId is the IdentityRegistry tokenId,
    /// which starts at 1, so zero can never be a real agent.
    error UnknownAgent();

    /// @notice Emitted when a client records feedback about an agent. agentId is the
    /// IdentityRegistry tokenId; clientAddress is the feedback author; feedbackIndex
    /// is the per-agent monotonic counter. Mirrors the EIP-8004 NewFeedback signature.
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals
    );

    /// @notice Record feedback about an agent identity.
    /// @dev Reverts UnknownAgent when agentId is zero. Increments the per-agent
    /// feedbackIndex and emits NewFeedback. Matches the EIP-8004 giveFeedback
    /// argument names and order exactly (a canonical swap stays ABI-compatible).
    /// @param agentId The IdentityRegistry tokenId the feedback is about.
    /// @param value Fixed-point score, value = round(score * 10 ** valueDecimals).
    /// @param valueDecimals Fixed-point places for value (feedback scale, not money).
    /// @param tag1 Free-form category tag for indexing.
    /// @param tag2 Secondary free-form tag.
    /// @param endpoint The endpoint the feedback concerns.
    /// @param feedbackURI Off-chain location of the full feedback payload.
    /// @param feedbackHash Content hash binding the off-chain feedback payload.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (agentId == 0) revert UnknownAgent();

        uint64 feedbackIndex = ++feedbackCount[agentId];

        emit NewFeedback(agentId, msg.sender, feedbackIndex, value, valueDecimals);
    }
}
