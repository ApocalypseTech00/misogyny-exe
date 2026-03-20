// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/Address.sol";

/**
 * MISOGYNY.EXE — PaymentSplitter
 *
 * Splits all incoming ETH:
 *   50% → Charity wallet (off-ramped to Refuge via Coinbase)
 *   30% → Artist wallet
 *   20% → Project wallet
 *
 * Based on OpenZeppelin PaymentSplitter (removed in v5).
 * Set this contract's address as the creator/revenue address.
 * Call release(payee) to withdraw each payee's share.
 */
contract MisogynyPaymentSplitter {
    event PayeeAdded(address account, uint256 shares);
    event PaymentReleased(address to, uint256 amount);
    event PaymentReceived(address from, uint256 amount);

    uint256 private _totalShares;
    uint256 private _totalReleased;
    mapping(address => uint256) private _shares;
    mapping(address => uint256) private _released;
    address[] private _payees;

    error NoPayees();
    error SharesAreZero();
    error AlreadyHasShares();
    error AccountHasNoShares();
    error NotDuePayment();
    error PayeesSharesLengthMismatch();

    constructor(address[] memory payees, uint256[] memory shares_) {
        if (payees.length == 0) revert NoPayees();
        if (payees.length != shares_.length)
            revert PayeesSharesLengthMismatch();

        for (uint256 i = 0; i < payees.length; i++) {
            _addPayee(payees[i], shares_[i]);
        }
    }

    receive() external payable {
        emit PaymentReceived(msg.sender, msg.value);
    }

    /// @notice Total shares across all payees
    function totalShares() public view returns (uint256) {
        return _totalShares;
    }

    /// @notice Total ETH already released
    function totalReleased() public view returns (uint256) {
        return _totalReleased;
    }

    /// @notice Shares for a given payee
    function shares(address account) public view returns (uint256) {
        return _shares[account];
    }

    /// @notice ETH already released to a given payee
    function released(address account) public view returns (uint256) {
        return _released[account];
    }

    /// @notice Payee address by index
    function payee(uint256 index) public view returns (address) {
        return _payees[index];
    }

    /// @notice Number of payees
    function payeeCount() public view returns (uint256) {
        return _payees.length;
    }

    /// @notice Pending payment for a given payee
    function pending(address account) public view returns (uint256) {
        if (_shares[account] == 0) return 0;
        uint256 totalReceived = address(this).balance + _totalReleased;
        uint256 owed = (totalReceived * _shares[account]) /
            _totalShares -
            _released[account];
        return owed;
    }

    /// @notice Release owed ETH to a payee
    function release(address payable account) public {
        if (_shares[account] == 0) revert AccountHasNoShares();

        uint256 payment = pending(account);
        if (payment == 0) revert NotDuePayment();

        _released[account] += payment;
        _totalReleased += payment;

        Address.sendValue(account, payment);
        emit PaymentReleased(account, payment);
    }

    /// @notice Release all payees at once
    function releaseAll() external {
        for (uint256 i = 0; i < _payees.length; i++) {
            address payable account = payable(_payees[i]);
            if (pending(account) > 0) {
                release(account);
            }
        }
    }

    function _addPayee(address account, uint256 shares_) private {
        if (shares_ == 0) revert SharesAreZero();
        if (_shares[account] != 0) revert AlreadyHasShares();

        _payees.push(account);
        _shares[account] = shares_;
        _totalShares += shares_;
        emit PayeeAdded(account, shares_);
    }
}
