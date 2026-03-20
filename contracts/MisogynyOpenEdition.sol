// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * MISOGYNY.EXE — Open Edition (ERC-1155)
 *
 * 0.002 ETH per mint. 14-day window. Infinite supply.
 * All proceeds forwarded to PaymentSplitter (50% charity / 30% artist / 20% project).
 * Crossmint-compatible via mintTo().
 */
contract MisogynyOpenEdition is ERC1155, ERC2981, Ownable {
    uint256 public constant TOKEN_ID = 1;
    uint256 public constant PRICE = 0.002 ether;

    uint256 public mintStart;
    uint256 public mintEnd;
    uint256 public totalMinted;
    address public immutable paymentSplitter;

    string public name = "MISOGYNY.EXE";
    string public symbol = "MSGNY";
    string public contractURI;

    error MintNotActive();
    error InsufficientPayment();
    error ForwardFailed();

    constructor(
        string memory _uri,
        string memory _contractURI,
        address _paymentSplitter,
        uint256 _startTime,
        uint256 _duration
    ) ERC1155(_uri) Ownable(msg.sender) {
        paymentSplitter = _paymentSplitter;
        contractURI = _contractURI;
        mintStart = _startTime;
        mintEnd = _startTime + _duration;
        _setDefaultRoyalty(0x5C357a074e6E5E40bf86D7230d62b8aD28D12deF, 1000); // 10% royalties to artist
    }

    function mint(uint256 quantity) external payable {
        _mintInternal(msg.sender, quantity);
    }

    /// @notice Crossmint-compatible mint to a specific address
    function mintTo(address to, uint256 quantity) external payable {
        _mintInternal(to, quantity);
    }

    function _mintInternal(address to, uint256 quantity) private {
        if (block.timestamp < mintStart || block.timestamp > mintEnd)
            revert MintNotActive();
        if (msg.value < PRICE * quantity)
            revert InsufficientPayment();

        totalMinted += quantity;
        _mint(to, TOKEN_ID, quantity, "");

        (bool success, ) = paymentSplitter.call{value: msg.value}("");
        if (!success) revert ForwardFailed();
    }

    function setURI(string memory newuri) external onlyOwner {
        _setURI(newuri);
    }

    function setContractURI(string memory _contractURI) external onlyOwner {
        contractURI = _contractURI;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC1155, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
