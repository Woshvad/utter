// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Malicious ERC-20 whose transfer re-enters a configured target.
/// Used by later plans to prove that nonReentrant guards revert a re-entry
/// attempt during a token transfer. After arming, every _update (transfer or
/// mint movement) calls back into target with payload. Test-only.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public payload;

    constructor() ERC20("Evil", "EVL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arm the token so the next _update re-enters target with payload.
    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0)) {
            // Re-enter on transfer. The bool is intentionally ignored: the
            // attack succeeds or the guarded target reverts the whole call.
            (bool ok,) = target.call(payload);
            ok;
        }
    }
}
