// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * Test-only mock of the Rare Protocol ERC-721 collection.
 * Implements the interface CollectionAdmin expects:
 *   mint(address, string) -> uint256
 *   updateTokenURI(uint256, string)
 *   setRoyaltyReceiver(address)
 *   transferOwnership(address)
 */
contract MockRareCollection is ERC721URIStorage, Ownable {
    uint256 private _nextTokenId = 1;
    address public royaltyReceiver;

    event RoyaltyReceiverUpdated(address indexed receiver);

    constructor() ERC721("MockRare", "MOCKR") Ownable(msg.sender) {}

    function mint(address to, string calldata tokenURI_)
        external
        onlyOwner
        returns (uint256 tokenId)
    {
        tokenId = _nextTokenId++;
        _mint(to, tokenId);
        _setTokenURI(tokenId, tokenURI_);
    }

    function updateTokenURI(uint256 tokenId, string calldata uri) external onlyOwner {
        _setTokenURI(tokenId, uri);
    }

    function setRoyaltyReceiver(address receiver) external onlyOwner {
        royaltyReceiver = receiver;
        emit RoyaltyReceiverUpdated(receiver);
    }
}
