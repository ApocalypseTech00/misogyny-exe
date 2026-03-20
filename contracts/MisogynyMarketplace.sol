// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMisogynyNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/**
 * MISOGYNY.EXE — Marketplace
 *
 * Custom marketplace for restricted ERC-721 tokens.
 * 15% royalty on every sale, split equally:
 *   5% → Charity (Refuge via off-ramp)
 *   5% → Bot/LLC (operations)
 *   5% → Artist
 * 85% → Seller
 */
contract MisogynyMarketplace is Ownable, ReentrancyGuard {
    IMisogynyNFT public immutable nft;

    uint256 public constant ROYALTY_BPS = 1500; // 15%
    uint256 private constant BPS = 10000;

    address public charityWallet;
    address public botWallet;
    address public artistWallet;

    struct Listing {
        address seller;
        uint256 price;
    }

    mapping(uint256 => Listing) public listings;

    event Listed(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price
    );
    event Sold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 price
    );
    event Cancelled(uint256 indexed tokenId, address indexed seller);
    event WalletsUpdated(address charity, address bot, address artist);

    error NotTokenOwner();
    error NotSeller();
    error AlreadyListed();
    error NotListed();
    error InsufficientPayment();
    error TransferFailed();
    error ZeroPrice();
    error ZeroAddress();

    constructor(
        address _nft,
        address _charity,
        address _bot,
        address _artist
    ) Ownable(msg.sender) {
        if (
            _nft == address(0) ||
            _charity == address(0) ||
            _bot == address(0) ||
            _artist == address(0)
        ) revert ZeroAddress();
        nft = IMisogynyNFT(_nft);
        charityWallet = _charity;
        botWallet = _bot;
        artistWallet = _artist;
    }

    /// @notice List an NFT for sale
    function list(uint256 tokenId, uint256 price) external {
        if (nft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (listings[tokenId].price != 0) revert AlreadyListed();
        if (price == 0) revert ZeroPrice();
        listings[tokenId] = Listing(msg.sender, price);
        emit Listed(tokenId, msg.sender, price);
    }

    /// @notice Buy a listed NFT
    function buy(uint256 tokenId) external payable nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.price == 0) revert NotListed();
        if (msg.value < l.price) revert InsufficientPayment();

        delete listings[tokenId];

        // Transfer NFT (marketplace is trusted — no approval needed)
        nft.transferFrom(l.seller, msg.sender, tokenId);

        // Calculate splits
        uint256 royalty = (l.price * ROYALTY_BPS) / BPS;
        uint256 perWallet = royalty / 3;
        uint256 sellerProceeds = l.price - royalty;

        // Pay seller
        _send(l.seller, sellerProceeds);

        // Pay royalties (last recipient gets remainder for rounding)
        _send(charityWallet, perWallet);
        _send(botWallet, perWallet);
        _send(artistWallet, royalty - perWallet * 2);

        // Refund overpayment
        if (msg.value > l.price) {
            _send(msg.sender, msg.value - l.price);
        }

        emit Sold(tokenId, l.seller, msg.sender, l.price);
    }

    /// @notice Cancel your listing
    function cancel(uint256 tokenId) external {
        if (listings[tokenId].seller != msg.sender) revert NotSeller();
        delete listings[tokenId];
        emit Cancelled(tokenId, msg.sender);
    }

    /// @notice Update royalty wallet addresses
    function updateWallets(
        address _charity,
        address _bot,
        address _artist
    ) external onlyOwner {
        if (
            _charity == address(0) ||
            _bot == address(0) ||
            _artist == address(0)
        ) revert ZeroAddress();
        charityWallet = _charity;
        botWallet = _bot;
        artistWallet = _artist;
        emit WalletsUpdated(_charity, _bot, _artist);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
