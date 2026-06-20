// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";

/// @notice ID-01 / ID-02 coverage for the ERC-8004 reference registries. Identity
/// register mints a sequential tokenId as the agentId, sets the card URL as the
/// token URI, and emits Registered; reputation giveFeedback bumps a per-agent index
/// and emits NewFeedback; validation binds a response to a recorded request and
/// guards the responder. Mirrors the contract events so vm.expectEmit can match them.
contract Erc8004Test is Test {
    IdentityRegistry internal identity;
    ReputationRegistry internal reputation;
    ValidationRegistry internal validation;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal other = makeAddr("other");
    address internal validator = makeAddr("validator");
    address internal client = makeAddr("client");

    string internal constant CARD_URI = "https://abc.resources.utter.dev/.well-known/agent-card.json";

    // Mirror the contract events so vm.expectEmit can match them.
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals
    );
    event ValidationRequested(
        address indexed validator,
        uint256 indexed agentId,
        string requestURI,
        bytes32 requestHash
    );
    event ValidationResponded(
        bytes32 indexed requestHash,
        address indexed validator,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    function setUp() public {
        identity = new IdentityRegistry(owner);
        reputation = new ReputationRegistry();
        validation = new ValidationRegistry();
    }

    /// register mints a sequential tokenId as the agentId to the caller, sets the
    /// agentURI as the token URI, emits Registered, and the next agent gets id+1.
    function test_register_mints_and_emits() public {
        vm.expectEmit(true, true, false, true);
        emit Registered(1, CARD_URI, creator);

        vm.prank(creator);
        uint256 agentId = identity.register(CARD_URI);

        assertEq(agentId, 1, "first agentId should be 1");
        assertEq(identity.ownerOf(agentId), creator, "agent NFT not owned by caller");
        assertEq(identity.tokenURI(agentId), CARD_URI, "tokenURI not set to the card URL");

        // The second registration mints the next sequential id to a different owner.
        vm.prank(other);
        uint256 secondId = identity.register("https://def.resources.utter.dev/card.json");
        assertEq(secondId, 2, "second agentId should be 2");
        assertEq(identity.ownerOf(2), other, "second agent NFT not owned by its caller");
    }

    /// An empty agentURI reverts EmptyAgentURI instead of minting an unresolvable
    /// identity.
    function test_register_revertsOnEmptyUri() public {
        vm.expectRevert(IdentityRegistry.EmptyAgentURI.selector);
        vm.prank(creator);
        identity.register("");
    }

    /// giveFeedback bumps the per-agent feedbackIndex (1-based) and emits NewFeedback
    /// with the caller as clientAddress; a second feedback increments the index.
    function test_giveFeedback_emits() public {
        uint256 agentId = 1;
        int128 value = 9500; // 0.95 at valueDecimals=4 (feedback scale, not money)
        uint8 valueDecimals = 4;

        vm.expectEmit(true, true, false, true);
        emit NewFeedback(agentId, client, 1, value, valueDecimals);

        vm.prank(client);
        reputation.giveFeedback(
            agentId, value, valueDecimals, "quality", "latency", "/predict", "https://fb.example/1", bytes32(uint256(0xabc))
        );

        assertEq(reputation.feedbackCount(agentId), 1, "feedbackIndex not incremented");

        // Second feedback for the same agent gets index 2.
        vm.expectEmit(true, true, false, true);
        emit NewFeedback(agentId, client, 2, value, valueDecimals);
        vm.prank(client);
        reputation.giveFeedback(
            agentId, value, valueDecimals, "quality", "latency", "/predict", "https://fb.example/2", bytes32(uint256(0xdef))
        );
        assertEq(reputation.feedbackCount(agentId), 2, "second feedbackIndex wrong");
    }

    /// A zero agentId reverts UnknownAgent (agentIds start at 1).
    function test_giveFeedback_revertsOnZeroAgent() public {
        vm.expectRevert(ReputationRegistry.UnknownAgent.selector);
        vm.prank(client);
        reputation.giveFeedback(0, 1, 0, "", "", "", "", bytes32(0));
    }

    /// validationRequest records the addressed validator and emits ValidationRequested;
    /// the addressed validator can then respond, emitting ValidationResponded.
    function test_validation_request_response_emit() public {
        uint256 agentId = 7;
        bytes32 requestHash = keccak256("request-1");

        vm.expectEmit(true, true, false, true);
        emit ValidationRequested(validator, agentId, "https://req.example/1", requestHash);

        vm.prank(client);
        validation.validationRequest(validator, agentId, "https://req.example/1", requestHash);
        assertEq(validation.requestValidator(requestHash), validator, "validator not recorded");

        bytes32 responseHash = keccak256("response-1");
        vm.expectEmit(true, true, false, true);
        emit ValidationResponded(requestHash, validator, 1, "https://resp.example/1", responseHash, "verified");

        vm.prank(validator);
        validation.validationResponse(requestHash, 1, "https://resp.example/1", responseHash, "verified");
    }

    /// Only the addressed validator may respond: a third party answering reverts
    /// NotValidator, which prevents forged attestations.
    function test_validationResponse_onlyAddressedValidator() public {
        bytes32 requestHash = keccak256("request-2");
        vm.prank(client);
        validation.validationRequest(validator, 7, "https://req.example/2", requestHash);

        vm.expectRevert(ValidationRegistry.NotValidator.selector);
        vm.prank(other);
        validation.validationResponse(requestHash, 1, "https://resp.example/2", bytes32(0), "verified");
    }

    /// A response to an unrecorded requestHash reverts UnknownRequest.
    function test_validationResponse_revertsOnUnknownRequest() public {
        vm.expectRevert(ValidationRegistry.UnknownRequest.selector);
        vm.prank(validator);
        validation.validationResponse(keccak256("missing"), 1, "", bytes32(0), "");
    }

    /// A duplicate validationRequest for the same requestHash reverts RequestExists.
    function test_validationRequest_revertsOnDuplicate() public {
        bytes32 requestHash = keccak256("request-3");
        vm.prank(client);
        validation.validationRequest(validator, 7, "https://req.example/3", requestHash);

        vm.expectRevert(ValidationRegistry.RequestExists.selector);
        vm.prank(client);
        validation.validationRequest(validator, 7, "https://req.example/3", requestHash);
    }
}
