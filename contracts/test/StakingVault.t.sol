// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {IResourceRegistry} from "../src/interfaces/IResourceRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice CONTRACT-05 + CONTRACT-07 tests for the bond / slash / cooldown /
/// refund matrix. A creator deposits a bond, the admin slashes it into the
/// in-vault insurance pool, withdraw is blocked until the cooldown elapses while
/// slashing still works during cooldown, and the admin refunds buyers from the
/// pool with an over-refund guard and an only-admin guard.
///
/// Slash is coupled to the ResourceRegistry on chain (T56): a slash first
/// consumes a matured, matching authorization the slasher recorded on the
/// registry. The setup deploys a real registry, grants the vault VAULT_ROLE, and
/// registers the resource; each slash test records an authorization and warps
/// past SLASH_DISPUTE_WINDOW before slashing.
contract StakingVaultTest is Test {
    StakingVault internal vault;
    ResourceRegistry internal registry;
    MockERC20 internal usdc;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");
    address internal slasher2 = makeAddr("slasher2");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant RESOURCE_ID = keccak256("resource-1");
    bytes32 internal constant AGENT_ID = keccak256("agent-1");
    bytes32 internal constant PRICING_HASH = keccak256("pricing-1");
    uint16 internal constant CREATOR_BPS = 7000;

    // A bond comfortably above MIN_BOND_BASE_UNITS (1e6 == $1 at 6dp).
    uint256 internal constant BOND = 10_000_000; // $10

    // Mirror the contract events so vm.expectEmit can match them.
    event BondDeposited(bytes32 indexed resourceId, address indexed owner, uint256 amount);
    event Slashed(bytes32 indexed resourceId, uint256 amount, string reason);
    event BondWithdrawn(bytes32 indexed resourceId, address indexed owner, uint256 amount);
    event Refunded(address indexed payer, uint256 amount);

    function setUp() public {
        usdc = new MockERC20();
        // The single owner holds DEFAULT_ADMIN_ROLE plus REGISTRY_ADMIN_ROLE and
        // SLASHER_ROLE on the registry, and DEFAULT_ADMIN_ROLE plus SLASHER_ROLE
        // and TREASURY_ADMIN_ROLE on the vault, mirroring the old single owner.
        // Zero delay: no admin transfer is exercised here.
        registry = new ResourceRegistry(uint48(0), owner, owner, owner);
        vault = new StakingVault(
            IERC20(address(usdc)), IResourceRegistry(address(registry)), uint48(0), owner, owner, owner
        );

        // Couple the slash path: grant the vault VAULT_ROLE so it may consume a
        // recorded authorization, and register the resource so authorizations and
        // slashes target an existing resource.
        vm.startPrank(owner);
        registry.grantRole(registry.VAULT_ROLE(), address(vault));
        registry.register(RESOURCE_ID, creator, treasury, CREATOR_BPS, AGENT_ID, PRICING_HASH);
        vm.stopPrank();

        usdc.mint(creator, 1_000_000_000); // plenty of USDC for the creator
        vm.prank(creator);
        usdc.approve(address(vault), type(uint256).max);

        // The stranger is funded and approved so a takeover attempt fails on the
        // ownership guard, not on a missing balance or allowance.
        usdc.mint(stranger, 1_000_000_000);
        vm.prank(stranger);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev Record a matured slash authorization for `amount` and warp past the
    /// dispute window so a subsequent slash(amount) can consume it. The slasher
    /// (owner here) records on the registry; the window then elapses.
    function _authorizeAndMature(uint256 amount) internal {
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, amount, "scorer:authorize");
        vm.warp(block.timestamp + registry.SLASH_DISPUTE_WINDOW());
    }

    /// A second depositor cannot seize an existing bond: once creator owns the
    /// bond, a stranger's deposit reverts BondOwnerMismatch and ownership and the
    /// bond balance are untouched. The original owner can still top up.
    function test_deposit_rejectsBondOwnerTakeover() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        // Stranger attempts to take over the resource's bond.
        vm.expectRevert(StakingVault.BondOwnerMismatch.selector);
        vm.prank(stranger);
        vault.deposit(RESOURCE_ID, BOND);

        // Ownership and bond balance are unchanged by the rejected takeover.
        assertEq(vault.bondOwner(RESOURCE_ID), creator, "owner changed by takeover attempt");
        assertEq(vault.bonds(RESOURCE_ID), BOND, "bond changed by takeover attempt");

        // The original owner can still top up the same bond.
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);
        assertEq(vault.bonds(RESOURCE_ID), BOND * 2, "owner top-up not credited");
        assertEq(vault.bondOwner(RESOURCE_ID), creator, "owner changed by top-up");
    }

    /// A zero-amount deposit reverts ZeroAmount rather than emitting a no-op event.
    function test_deposit_revertsOnZeroAmount() public {
        vm.expectRevert(StakingVault.ZeroAmount.selector);
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, 0);
    }

    /// The constructor reverts ZeroAddress when the registry is the zero address,
    /// so a vault can never deploy without a registry to consume authorizations.
    function test_constructor_revertsOnZeroRegistry() public {
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        new StakingVault(IERC20(address(usdc)), IResourceRegistry(address(0)), uint48(0), owner, owner, owner);
    }

    /// A zero-address payer refund reverts ZeroAddress (defense in depth).
    function test_refund_revertsOnZeroAddressPayer() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);
        _authorizeAndMature(4_000_000);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, 4_000_000, "scorer:5-strikes");

        vm.expectRevert(StakingVault.ZeroAddress.selector);
        vm.prank(owner);
        vault.refund(address(0), 1_000_000);
    }

    /// Deposit credits bonds[resourceId] and pulls USDC into the vault.
    function test_bondDeposit_credits() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        assertEq(vault.bonds(RESOURCE_ID), BOND, "bond not credited");
        assertEq(usdc.balanceOf(address(vault)), BOND, "vault did not receive USDC");
        assertEq(vault.bondOwner(RESOURCE_ID), creator, "bond owner not set");
    }

    /// Admin slash decrements the bond, increments insurancePoolBalance, emits
    /// Slashed(reason); a non-admin slash reverts. The slash consumes a matured
    /// registry authorization first.
    function test_slash_movesToInsurancePool() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 4_000_000;
        _authorizeAndMature(slashAmount);

        vm.expectEmit(true, false, false, true);
        emit Slashed(RESOURCE_ID, slashAmount, "scorer:5-strikes");
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:5-strikes");

        assertEq(vault.bonds(RESOURCE_ID), BOND - slashAmount, "bond not decremented");
        assertEq(vault.insurancePoolBalance(), slashAmount, "insurance pool not credited");
        // Funds stay in vault custody: no token left the vault on slash.
        assertEq(usdc.balanceOf(address(vault)), BOND, "vault balance changed on slash");
        // The authorization was consumed (single-use): nothing pending remains.
        (uint256 pendingAmount,) = registry.getPendingSlash(RESOURCE_ID);
        assertEq(pendingAmount, 0, "authorization not cleared on consume");

        // A caller without SLASHER_ROLE cannot slash. Re-authorize so the call
        // reaches the role guard rather than reverting NoPendingSlash first.
        _authorizeAndMature(slashAmount);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, vault.SLASHER_ROLE()
            )
        );
        vm.prank(stranger);
        vault.slash(RESOURCE_ID, slashAmount, "unauthorized");
    }

    /// slash with NO prior authorization reverts NoPendingSlash and leaves the
    /// bond untouched (no money effect runs).
    function test_slash_revertsWithoutAuthorization() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        vm.expectRevert(ResourceRegistry.NoPendingSlash.selector);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, 4_000_000, "no-auth");

        assertEq(vault.bonds(RESOURCE_ID), BOND, "bond touched without authorization");
        assertEq(vault.insurancePoolBalance(), 0, "insurance pool credited without authorization");
    }

    /// slash BEFORE the dispute window elapses reverts SlashWindowActive and
    /// leaves the bond untouched.
    function test_slash_revertsBeforeWindow() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 4_000_000;
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, slashAmount, "scorer:authorize");
        // No warp: still inside the dispute window.

        vm.expectRevert(ResourceRegistry.SlashWindowActive.selector);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "too-soon");

        assertEq(vault.bonds(RESOURCE_ID), BOND, "bond touched before window");
        assertEq(vault.insurancePoolBalance(), 0, "insurance pool credited before window");
    }

    /// slash with an amount different from the authorized amount reverts
    /// SlashAmountMismatch and leaves the bond untouched.
    function test_slash_revertsOnAmountMismatch() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        _authorizeAndMature(4_000_000);

        vm.expectRevert(ResourceRegistry.SlashAmountMismatch.selector);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, 5_000_000, "wrong-amount");

        assertEq(vault.bonds(RESOURCE_ID), BOND, "bond touched on amount mismatch");
        assertEq(vault.insurancePoolBalance(), 0, "insurance pool credited on amount mismatch");
    }

    /// A DEFAULT_ADMIN cancel during the dispute window disputes the slash: a
    /// subsequent slash reverts NoPendingSlash and the bond is untouched.
    function test_slash_revertsAfterCancel() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 4_000_000;
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, slashAmount, "scorer:authorize");

        // DEFAULT_ADMIN disputes by cancelling during the window.
        vm.prank(owner);
        registry.cancelSlashAuthorization(RESOURCE_ID);

        // Even after the window would have elapsed, no authorization remains.
        vm.warp(block.timestamp + registry.SLASH_DISPUTE_WINDOW());
        vm.expectRevert(ResourceRegistry.NoPendingSlash.selector);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "cancelled");

        assertEq(vault.bonds(RESOURCE_ID), BOND, "bond touched after cancel");
        assertEq(vault.insurancePoolBalance(), 0, "insurance pool credited after cancel");
    }

    /// An authorization is single-use: after a successful slash consumes it, a
    /// second slash without re-authorizing reverts NoPendingSlash.
    function test_slash_authorizationSingleUse() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 3_000_000;
        _authorizeAndMature(slashAmount);

        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:first");
        assertEq(vault.bonds(RESOURCE_ID), BOND - slashAmount, "first slash not applied");

        // A second slash with no fresh authorization reverts NoPendingSlash.
        vm.expectRevert(ResourceRegistry.NoPendingSlash.selector);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:second");

        assertEq(vault.bonds(RESOURCE_ID), BOND - slashAmount, "bond changed on single-use second slash");
    }

    /// Only the vault may consume an authorization: a direct external caller,
    /// even the SLASHER, reverts AccessControlUnauthorizedAccount(VAULT_ROLE).
    function test_consume_onlyVaultRole() public {
        bytes32 vaultRole = registry.VAULT_ROLE();

        uint256 slashAmount = 4_000_000;
        _authorizeAndMature(slashAmount);

        // owner holds SLASHER_ROLE and DEFAULT_ADMIN but NOT VAULT_ROLE, so even
        // it cannot consume the authorization directly.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, owner, vaultRole)
        );
        vm.prank(owner);
        registry.consumeSlashAuthorization(RESOURCE_ID, slashAmount);

        // A stranger cannot consume either.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, vaultRole)
        );
        vm.prank(stranger);
        registry.consumeSlashAuthorization(RESOURCE_ID, slashAmount);
    }

    /// requestWithdraw then immediate withdraw reverts (CooldownActive); after
    /// warping past the cooldown, withdraw succeeds and transfers the bond out.
    function test_bondWithdraw_enforcesCooldown() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        vm.prank(creator);
        vault.requestWithdraw(RESOURCE_ID);

        // Immediate withdraw is blocked by the cooldown.
        vm.expectRevert(StakingVault.CooldownActive.selector);
        vm.prank(creator);
        vault.withdraw(RESOURCE_ID);

        // Warp past the cooldown.
        vm.warp(block.timestamp + 7 days);

        uint256 creatorBefore = usdc.balanceOf(creator);

        vm.expectEmit(true, true, false, true);
        emit BondWithdrawn(RESOURCE_ID, creator, BOND);
        vm.prank(creator);
        vault.withdraw(RESOURCE_ID);

        assertEq(vault.bonds(RESOURCE_ID), 0, "bond not cleared");
        assertEq(usdc.balanceOf(creator), creatorBefore + BOND, "bond not returned to creator");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault still holds USDC");
    }

    /// After requestWithdraw, an admin slash during the cooldown window still
    /// succeeds, so a creator cannot front-run a pending slash. The slash still
    /// consumes a matured registry authorization first.
    function test_slash_duringCooldown() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        vm.prank(creator);
        vault.requestWithdraw(RESOURCE_ID);

        uint256 slashAmount = 3_000_000;
        // Authorize then warp one day (== SLASH_DISPUTE_WINDOW), still inside the
        // 7-day withdraw cooldown, so the slash matures while the bond is locked.
        vm.prank(owner);
        registry.slashAuthorization(RESOURCE_ID, slashAmount, "scorer:authorize");
        vm.warp(block.timestamp + 1 days);

        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:strikes-during-cooldown");

        assertEq(vault.bonds(RESOURCE_ID), BOND - slashAmount, "bond not slashed during cooldown");
        assertEq(vault.insurancePoolBalance(), slashAmount, "insurance pool not credited");
    }

    /// After a slash funds the pool, admin refund transfers USDC to the payer and
    /// decrements insurancePoolBalance.
    function test_refund_paysFromInsurancePool() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 6_000_000;
        _authorizeAndMature(slashAmount);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:5-strikes");

        uint256 refundAmount = 2_500_000;

        vm.expectEmit(true, false, false, true);
        emit Refunded(payer, refundAmount);
        vm.prank(owner);
        vault.refund(payer, refundAmount);

        assertEq(usdc.balanceOf(payer), refundAmount, "payer not reimbursed");
        assertEq(vault.insurancePoolBalance(), slashAmount - refundAmount, "insurance pool not decremented");
    }

    /// Refund greater than the pool balance reverts (OverRefund).
    function test_refund_revertsOnOverRefund() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 5_000_000;
        _authorizeAndMature(slashAmount);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:5-strikes");

        uint256 poolBalance = vault.insurancePoolBalance();

        vm.expectRevert(StakingVault.OverRefund.selector);
        vm.prank(owner);
        vault.refund(payer, poolBalance + 1);
    }

    /// A caller without TREASURY_ADMIN_ROLE cannot refund.
    function test_refund_onlyAdmin() public {
        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        _authorizeAndMature(4_000_000);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, 4_000_000, "scorer:5-strikes");

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, vault.TREASURY_ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        vault.refund(payer, 1_000_000);
    }

    /// The role split is enforced: an account holding only SLASHER_ROLE cannot
    /// refund (TREASURY_ADMIN_ROLE), and an account holding only
    /// TREASURY_ADMIN_ROLE cannot slash. Proves slash and refund are distinct
    /// capabilities, not one collapsed admin.
    function test_roleSplit_slasherCannotRefund_treasuryCannotSlash() public {
        bytes32 slasherRole = vault.SLASHER_ROLE();
        bytes32 treasuryRole = vault.TREASURY_ADMIN_ROLE();

        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);
        _authorizeAndMature(4_000_000);
        vm.prank(owner);
        vault.slash(RESOURCE_ID, 4_000_000, "scorer:5-strikes");

        // slasher2 gets SLASHER_ROLE only.
        vm.prank(owner);
        vault.grantRole(slasherRole, slasher2);

        // slasher2 cannot refund (lacks TREASURY_ADMIN_ROLE).
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, slasher2, treasuryRole)
        );
        vm.prank(slasher2);
        vault.refund(payer, 1_000_000);

        // payer gets TREASURY_ADMIN_ROLE only and cannot slash (lacks SLASHER_ROLE).
        vm.prank(owner);
        vault.grantRole(treasuryRole, payer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, payer, slasherRole)
        );
        vm.prank(payer);
        vault.slash(RESOURCE_ID, 1_000_000, "unauthorized");
    }

    /// SLASHER_ROLE is grantable: after the DEFAULT_ADMIN grants it to a second
    /// account, that account can slash a bond into the insurance pool (consuming a
    /// matured registry authorization).
    function test_grantSlasherRoleLetsSecondAccountSlash() public {
        bytes32 slasherRole = vault.SLASHER_ROLE();

        vm.prank(creator);
        vault.deposit(RESOURCE_ID, BOND);

        uint256 slashAmount = 1_000_000;
        _authorizeAndMature(slashAmount);

        // slasher2 cannot slash before the grant.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, slasher2, slasherRole)
        );
        vm.prank(slasher2);
        vault.slash(RESOURCE_ID, slashAmount, "unauthorized");

        // The DEFAULT_ADMIN grants SLASHER_ROLE to slasher2.
        vm.prank(owner);
        vault.grantRole(slasherRole, slasher2);
        assertTrue(vault.hasRole(slasherRole, slasher2), "slasher2 not granted SLASHER_ROLE");

        // Now slasher2 can slash the matured authorization.
        vm.prank(slasher2);
        vault.slash(RESOURCE_ID, slashAmount, "scorer:granted");
        assertEq(vault.insurancePoolBalance(), slashAmount, "granted slasher slash not applied");
    }

    /// The DEFAULT_ADMIN 2-step transfer moves DEFAULT_ADMIN_ROLE after the delay
    /// and the old admin can no longer grant roles, proving the non-brick handoff.
    /// Uses a non-zero delay vault so the schedule is exercised.
    function test_defaultAdmin_twoStepTransfer() public {
        uint48 delay = 2 days;
        address newAdmin = makeAddr("newAdmin");
        // Warp off the genesis timestamp so the schedule (now + delay) is well
        // defined and the accept-before-delay path is exercised cleanly.
        vm.warp(1_000_000);
        StakingVault v =
            new StakingVault(IERC20(address(usdc)), IResourceRegistry(address(registry)), delay, owner, owner, owner);
        bytes32 adminRole = v.DEFAULT_ADMIN_ROLE();
        bytes32 slasherRole = v.SLASHER_ROLE();

        // Step 1: the current admin schedules the transfer.
        vm.prank(owner);
        v.beginDefaultAdminTransfer(newAdmin);

        // Accepting before the delay elapses reverts (the schedule has not passed).
        vm.prank(newAdmin);
        vm.expectRevert();
        v.acceptDefaultAdminTransfer();

        // Warp strictly past the schedule, then accept.
        vm.warp(block.timestamp + delay + 1);
        vm.prank(newAdmin);
        v.acceptDefaultAdminTransfer();

        // The role moved: newAdmin holds DEFAULT_ADMIN_ROLE, owner does not.
        assertTrue(v.hasRole(adminRole, newAdmin), "newAdmin lacks DEFAULT_ADMIN_ROLE");
        assertFalse(v.hasRole(adminRole, owner), "old admin still holds DEFAULT_ADMIN_ROLE");

        // The old admin can no longer grant roles.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, owner, adminRole)
        );
        v.grantRole(slasherRole, slasher2);

        // The new admin can grant roles.
        vm.prank(newAdmin);
        v.grantRole(slasherRole, slasher2);
        assertTrue(v.hasRole(slasherRole, slasher2), "new admin could not grant SLASHER_ROLE");
    }
}
