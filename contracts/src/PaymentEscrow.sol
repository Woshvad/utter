// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IResourceRegistry} from "./interfaces/IResourceRegistry.sol";

/// @notice Primary escrow and settlement contract (CONTRACT-01, CONTRACT-02,
/// D-01/D-02/D-03/D-04/D-07). Buyers deposit USDC into internal balances, then
/// authorize per-call debits off-chain by signing an EIP-712 DebitAuthorization.
/// The Phase 2 relayer (the admin) submits a signed authorization to debit, which
/// verifies the signature, enforces the single-use nonce, expiry, signed spend
/// cap, and resource active-state, then applies the inline creator/treasury split
/// as internal balances. Parties pull real USDC out via withdraw.
///
/// All amounts are USDC base units. USDC on Arc is a 6-decimal ERC-20; this
/// contract never scales by decimals and never mixes the 18-decimal native gas
/// token (CLAUDE.md decimals trap, D-07). The split is pure integer arithmetic:
/// the creator share is floored and the remainder routes to the treasury so the
/// two shares always sum to the debited amount (D-03).
///
/// Admin model: a single Ownable owner can rotate the admin (relayer) key. This
/// single-key concentration is the MVP choice (D-04). Production should move to
/// Ownable2Step, split admin and owner roles, and place the owner behind a
/// multisig (01-RESEARCH Pitfall 4). Accepted as a documented threat-model item
/// (T-01-05-KC).
contract PaymentEscrow is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Basis-point denominator. creatorBps is expressed against 10000.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice EIP-712 DebitAuthorization typehash. The field order
    /// buyer, resourceId, maxAmount, nonce, validBefore is the spec-authoritative
    /// layout (Utter-SPEC.md §9.4 lines 324-327, 01-RESEARCH Pitfall 1) and is a
    /// LOCKED cross-phase constant: the Phase 2 client signTypedData types array
    /// must match this byte-for-byte or recovery fails.
    bytes32 private constant DEBIT_TYPEHASH = keccak256(
        "DebitAuthorization(address buyer,bytes32 resourceId,uint256 maxAmount,bytes32 nonce,uint256 validBefore)"
    );

    /// @notice The escrowed USDC token. Pulled in on deposit, paid out on withdraw.
    IERC20 public immutable usdc;

    /// @notice The resource config store. debit reads getResource for the split
    /// config and the active flag (CONTRACT-04 read path).
    IResourceRegistry public immutable registry;

    /// @notice The relayer / facilitator permitted to submit debits. Never treated
    /// as the buyer; the buyer is always the EIP-712 signer.
    address public admin;

    /// @notice Internal USDC balances. Credited by deposit and the debit split,
    /// debited by debit and withdraw.
    mapping(address => uint256) public balanceOf;

    /// @notice Single-use replay nonces. A consumed nonce can never be reused.
    mapping(bytes32 => bool) public usedNonce;

    /// @notice Emitted when a buyer deposits USDC into their internal balance.
    event Deposited(address indexed account, uint256 amount);

    /// @notice Emitted when an account withdraws real USDC out of escrow.
    event Withdrawn(address indexed account, uint256 amount);

    /// @notice Emitted when the admin (relayer) key is rotated.
    event AdminUpdated(address indexed previousAdmin, address indexed newAdmin);

    /// @notice Emitted on a successful debit with the full split breakdown.
    event Debited(
        bytes32 indexed resourceId,
        address indexed buyer,
        uint256 amount,
        uint256 toCreator,
        uint256 toTreasury,
        bytes32 nonce
    );

    /// @notice Caller is not the admin (relayer) for a debit.
    error NotAdmin();
    /// @notice The submitted authorization is malformed.
    error BadAuth();
    /// @notice The nonce has already been consumed (replay).
    error NonceUsed();
    /// @notice The authorization expired (block.timestamp > validBefore).
    error Expired();
    /// @notice The debited amount exceeds the signed cap (maxAmount).
    error AmountExceedsCap();
    /// @notice The recovered signer does not equal the buyer.
    error BadSignature();
    /// @notice The resource is paused or unregistered.
    error ResourceInactive();
    /// @notice A zero amount was supplied where a positive amount is required.
    error ZeroAmount();

    /// @param _usdc The escrowed USDC token.
    /// @param _registry The resource config store debit reads.
    /// @param _admin The initial relayer / facilitator permitted to submit debits.
    /// @param initialOwner The Ownable owner permitted to rotate the admin (D-04).
    constructor(IERC20 _usdc, IResourceRegistry _registry, address _admin, address initialOwner)
        EIP712("UtterEscrow", "1")
        Ownable(initialOwner)
    {
        usdc = _usdc;
        registry = _registry;
        admin = _admin;
        emit AdminUpdated(address(0), _admin);
    }

    /// @notice Rotate the admin (relayer) key. Owner-only (D-04).
    /// @param newAdmin The new relayer address.
    function setAdmin(address newAdmin) external onlyOwner {
        emit AdminUpdated(admin, newAdmin);
        admin = newAdmin;
    }

    /// @notice Deposit USDC into the caller's internal balance.
    /// @dev Pull-then-credit: SafeERC20 transferFrom first, then credit the
    /// internal balance, so a fee-on-transfer or reverting token cannot inflate
    /// the ledger. nonReentrant for defense in depth.
    /// @param amount USDC base units to deposit.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw USDC from the caller's internal balance.
    /// @dev Checks-effects-interactions: debit the internal balance first (Solidity
    /// 0.8 underflow reverts if the caller is overdrawn), then transfer out last.
    /// nonReentrant guards the single external interaction.
    /// @param amount USDC base units to withdraw.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        balanceOf[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Settle a per-call charge against a buyer-signed authorization.
    /// @dev Only the admin (relayer) may submit. Verifies the EIP-712 signature,
    /// rejects replayed nonces, expired authorizations, amounts above the signed
    /// cap, and inactive resources, then debits the buyer and credits the floored
    /// creator share plus the remainder to the treasury, all as internal balances.
    /// Ordered per Utter-SPEC.md §10: gate, validate, verify, read config,
    /// effects, split. The only token interactions live in deposit/withdraw, so
    /// the split is pure internal arithmetic that cannot move funds below the
    /// buyer's funded balance without reverting (Pitfall 2). NEVER runs against an
    /// unreserved authorization: the buyer's internal balance IS the reservation,
    /// debited atomically here.
    /// @param buyer The EIP-712 signer being charged. Never msg.sender.
    /// @param resourceId The resource the charge is for.
    /// @param amount The metered charge, must be <= maxAmount.
    /// @param maxAmount The signed spend cap.
    /// @param nonce The single-use replay nonce.
    /// @param validBefore The authorization expiry timestamp.
    /// @param sig The 65-byte buyer signature over the DebitAuthorization.
    function debit(
        address buyer,
        bytes32 resourceId,
        uint256 amount,
        uint256 maxAmount,
        bytes32 nonce,
        uint256 validBefore,
        bytes calldata sig
    ) external nonReentrant {
        if (msg.sender != admin) revert NotAdmin();
        if (usedNonce[nonce]) revert NonceUsed();
        if (block.timestamp > validBefore) revert Expired();
        if (amount > maxAmount) revert AmountExceedsCap();
        if (!_verify(buyer, resourceId, maxAmount, nonce, validBefore, sig)) revert BadSignature();

        (address creator, address treasury, uint16 creatorBps, bool active) = registry.getResource(resourceId);
        if (!active) revert ResourceInactive();

        // EFFECTS before the split. Underflow here reverts when the buyer is not
        // funded for the full amount, the acceptable MVP fail-safe (Pitfall 2); no
        // separate on-chain reservation locking is in scope (§22 Q4).
        usedNonce[nonce] = true;
        balanceOf[buyer] -= amount;

        // SPLIT: floor the creator share, route the remainder (rounding dust) to
        // the treasury so the two shares always sum to amount (D-03, Pattern 3).
        uint256 toCreator = (amount * creatorBps) / BPS_DENOMINATOR;
        uint256 toTreasury = amount - toCreator;
        balanceOf[creator] += toCreator;
        balanceOf[treasury] += toTreasury;

        emit Debited(resourceId, buyer, amount, toCreator, toTreasury, nonce);
    }

    /// @notice Verify a buyer signature over a DebitAuthorization.
    /// @dev Rebuilds the EIP-712 digest from the locked typehash and OZ domain
    /// separator, then recovers via OZ ECDSA (malleability-safe, rejects high-s and
    /// bad v). NEVER raw ecrecover. Returns true only when the recovered signer
    /// equals the buyer.
    function _verify(
        address buyer,
        bytes32 resourceId,
        uint256 maxAmount,
        bytes32 nonce,
        uint256 validBefore,
        bytes calldata sig
    ) internal view returns (bool) {
        bytes32 structHash = keccak256(abi.encode(DEBIT_TYPEHASH, buyer, resourceId, maxAmount, nonce, validBefore));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, sig);
        return signer == buyer;
    }
}
