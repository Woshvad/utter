// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {EIP712SignHelper} from "./helpers/EIP712SignHelper.sol";

/// @notice Wave 0 scaffold smoke test. Proves the toolchain, remappings, and
/// cheatcodes all resolve before any production contract exists: MockERC20
/// mints at 6 decimals, and the EIP-712 helper signs a DebitAuthorization that
/// recovers to the funded test key (independent reconstruction guards the
/// domain/typehash byte-layout per 01-RESEARCH Pitfall 1).
contract ScaffoldTest is Test, EIP712SignHelper {
    MockERC20 internal usdc;

    function setUp() public {
        usdc = new MockERC20();
    }

    function test_scaffold_mockUsdcMintsAt6Decimals() public {
        address holder = makeAddr("holder");
        usdc.mint(holder, 1_000_000);

        assertEq(usdc.decimals(), 6, "MockERC20 must report 6 decimals");
        assertEq(usdc.balanceOf(holder), 1_000_000, "minted balance mismatch");
    }

    function test_scaffold_eip712HelperRecoversBuyer() public {
        (address buyer, uint256 buyerPk) = makeAddrAndKey("buyer");
        address escrow = makeAddr("escrow");

        bytes memory sig = _signDebit(
            buyerPk,
            escrow,
            buyer,
            keccak256("resource-1"),
            500_000,
            keccak256("nonce-1"),
            block.timestamp + 1 hours
        );

        // Independently rebuild the same digest the helper signed and assert
        // recovery returns the buyer, proving domain + typehash encoding match.
        bytes32 structHash = keccak256(
            abi.encode(
                DEBIT_TYPEHASH,
                buyer,
                keccak256("resource-1"),
                uint256(500_000),
                keccak256("nonce-1"),
                block.timestamp + 1 hours
            )
        );
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

        assertEq(ECDSA.recover(digest, sig), buyer, "EIP-712 recovery must equal buyer");
    }
}
