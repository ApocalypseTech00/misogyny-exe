// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * MISOGYNY.EXE — Restricted NFT (ERC-721)
 *
 * Transfer-restricted to marketplace only. Blocks OpenSea, Blur, etc.
 * Owner (bot) mints with metadata URI, marketplace handles all sales.
 */
contract MisogynyNFT is ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;
    address public marketplace;

    error TransferRestricted();

    event MarketplaceUpdated(address indexed newMarketplace);

    constructor() ERC721("MISOGYNY.EXE", "MSGNY") Ownable(msg.sender) {}

    /// @notice Set the marketplace address
    function setMarketplace(address _marketplace) external onlyOwner {
        if (_marketplace == address(0)) revert TransferRestricted();
        marketplace = _marketplace;
        emit MarketplaceUpdated(_marketplace);
    }

    /// @notice Mint a new token (owner/bot only)
    function mint(
        address to,
        string calldata uri
    ) external onlyOwner returns (uint256) {
        uint256 tokenId = ++_nextTokenId;
        _mint(to, tokenId);
        _setTokenURI(tokenId, uri);
        return tokenId;
    }

    /// @notice Total tokens minted
    function totalSupply() public view returns (uint256) {
        return _nextTokenId;
    }

    /// @notice Update token metadata URI (owner only — for correcting poisoned metadata)
    function updateTokenURI(uint256 tokenId, string calldata uri) external onlyOwner {
        _setTokenURI(tokenId, uri);
    }

    /// @dev Restrict transfers to marketplace only. Minting is unrestricted.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);

        // Transfers (not mints/burns) restricted to marketplace
        if (from != address(0) && to != address(0)) {
            if (msg.sender != marketplace) revert TransferRestricted();
            // Marketplace is trusted — skip approval check
            return super._update(to, tokenId, address(0));
        }

        return super._update(to, tokenId, auth);
    }
}
