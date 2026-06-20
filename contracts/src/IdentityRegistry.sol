// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice ERC-8004 reference IdentityRegistry for Arc Testnet (ID-01, ID-03).
/// Arc has NO canonical ERC-8004 deployment (05-RESEARCH Pitfall 1), so Utter
/// authors this minimal reference whose function/event signatures match EIP-8004
/// byte-for-byte; a future canonical Arc deployment is then a drop-in ABI swap.
///
/// Identity is an ERC-721: register(agentURI) mints the next sequential tokenId
/// to msg.sender, and that tokenId IS the agentId (05-RESEARCH agentId resolution).
/// The token URI is set to the supplied agent-card URL so the off-chain publish
/// pipeline (Plan 07) can resolve the card from the on-chain identity. The agent is
/// located via agentRegistry = "eip155:5042002:<IdentityRegistry>" + agentId.
///
/// Mint model: register mints to msg.sender (the publishing creator's signer). The
/// off-chain publish pipeline is the real gate on who may mint; the contract only
/// records the mint and the URI. A future ownership / transfer / revocation policy
/// is left to the canonical standard and is out of scope for this reference
/// (T-05-02-MINT, accepted MVP item).
///
/// No amount-math literal appears here: the registry holds identity, never funds.
contract IdentityRegistry is ERC721, ERC721URIStorage, Ownable {
    /// @notice Next tokenId to mint. The first registered agent is agentId 1, so a
    /// zero agentId unambiguously means "unregistered" off chain.
    uint256 private _nextAgentId = 1;

    /// @notice An empty agentURI was supplied. The agent card URL is required so
    /// the off-chain pipeline can resolve the identity to its card.
    error EmptyAgentURI();

    /// @notice Emitted when a new agent identity is minted. agentId is the ERC-721
    /// tokenId; the indexer and marketplace build the listing from this event.
    /// Mirrors the EIP-8004 Registered signature so a canonical swap is ABI-compatible.
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    /// @param initialOwner The registry admin (OZ v5 Ownable takes the owner). The
    /// owner does not gate register in this reference; it is reserved for future
    /// administrative hooks the canonical standard may add.
    constructor(address initialOwner)
        ERC721("Utter Agent Identity", "UTTERID")
        Ownable(initialOwner)
    {}

    /// @notice Register a new agent identity. Mints the next sequential tokenId to
    /// the caller and stores agentURI as that token's URI. Returns the minted
    /// tokenId as the agentId.
    /// @dev Reverts EmptyAgentURI when agentURI is empty. The tokenId IS the agentId
    /// (05-RESEARCH). Matches EIP-8004 register(string agentURI) returns (uint256).
    /// @param agentURI The agent-card URL the on-chain identity resolves to.
    /// @return agentId The minted ERC-721 tokenId, used as the agentId everywhere.
    function register(string calldata agentURI) external returns (uint256 agentId) {
        if (bytes(agentURI).length == 0) revert EmptyAgentURI();

        agentId = _nextAgentId++;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);

        emit Registered(agentId, agentURI, msg.sender);
    }

    // ERC721URIStorage overrides the ERC721 tokenURI / supportsInterface; the
    // multiple-inheritance resolution below is required by solc.

    /// @inheritdoc ERC721URIStorage
    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    /// @inheritdoc ERC721URIStorage
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
