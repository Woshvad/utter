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
            // Re-enter on transfer. Bubble the inner revert so a guarded target
            // reverts the whole call: the attack either succeeds (re-entry runs)
            // or the nonReentrant guard reverts the entire outer transaction,
            // which is exactly the security property the reentrancy test asserts.
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
