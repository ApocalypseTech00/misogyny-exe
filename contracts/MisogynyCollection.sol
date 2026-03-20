// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * MISOGYNY.EXE — 1/1 Collection (ERC-721)
 *
 * 9 unique typographic artworks with on-chain reserve auctions.
 * All proceeds forwarded to PaymentSplitter (50% charity / 30% artist / 20% project).
 */
contract MisogynyCollection is ERC721URIStorage, ERC2981, Ownable {
    uint256 private _nextTokenId;
    address public immutable paymentSplitter;
    string public contractURI;

    uint256 public constant AUCTION_DURATION = 24 hours;
    uint256 public constant ANTI_SNIPE_WINDOW = 10 minutes;

    struct Auction {
        uint256 reservePrice;
        uint256 highestBid;
        address highestBidder;
        uint256 endTime;
        bool active;
        bool settled;
    }

    mapping(uint256 => Auction) public auctions;

    event AuctionCreated(uint256 indexed tokenId, uint256 reservePrice);
    event BidPlaced(uint256 indexed tokenId, address indexed bidder, uint256 amount);
    event AuctionSettled(uint256 indexed tokenId, address indexed winner, uint256 amount);
    event AuctionCancelled(uint256 indexed tokenId);

    error AuctionNotActive();
    error BidTooLow();
    error AuctionNotEnded();
    error AuctionAlreadyActive();
    error HasBids();
    error ForwardFailed();
    error RefundFailed();

    constructor(
        string memory _contractURI,
        address _paymentSplitter
    ) ERC721("MISOGYNY.EXE 1/1", "MSGNYX") Ownable(msg.sender) {
        paymentSplitter = _paymentSplitter;
        contractURI = _contractURI;
        _setDefaultRoyalty(0x5C357a074e6E5E40bf86D7230d62b8aD28D12deF, 1000); // 10% royalties to artist
    }

    /// @notice Owner mints a new 1/1 token
    function mint(string memory _tokenURI) external onlyOwner returns (uint256) {
        uint256 tokenId = ++_nextTokenId;
        _mint(msg.sender, tokenId);
        _setTokenURI(tokenId, _tokenURI);
        return tokenId;
    }

    /// @notice Start a reserve auction for a token
    function createAuction(uint256 tokenId, uint256 reservePrice) external onlyOwner {
        if (auctions[tokenId].active) revert AuctionAlreadyActive();
        // Transfer token to contract to escrow
        transferFrom(msg.sender, address(this), tokenId);
        auctions[tokenId] = Auction({
            reservePrice: reservePrice,
            highestBid: 0,
            highestBidder: address(0),
            endTime: 0, // starts when first bid placed
            active: true,
            settled: false
        });
        emit AuctionCreated(tokenId, reservePrice);
    }

    /// @notice Place a bid on an active auction
    function bid(uint256 tokenId) external payable {
        Auction storage a = auctions[tokenId];
        if (!a.active) revert AuctionNotActive();
        if (msg.value < a.reservePrice) revert BidTooLow();
        if (msg.value <= a.highestBid) revert BidTooLow();
        if (a.endTime > 0 && block.timestamp > a.endTime) revert AuctionNotActive();

        // Refund previous bidder
        if (a.highestBidder != address(0)) {
            (bool refunded, ) = a.highestBidder.call{value: a.highestBid}("");
            if (!refunded) revert RefundFailed();
        }

        a.highestBid = msg.value;
        a.highestBidder = msg.sender;

        // First valid bid starts the countdown
        if (a.endTime == 0) {
            a.endTime = block.timestamp + AUCTION_DURATION;
        }
        // Anti-snipe: extend if bid in last 10 minutes
        else if (a.endTime - block.timestamp < ANTI_SNIPE_WINDOW) {
            a.endTime = block.timestamp + ANTI_SNIPE_WINDOW;
        }

        emit BidPlaced(tokenId, msg.sender, msg.value);
    }

    /// @notice Settle a completed auction — sends NFT to winner, ETH to splitter
    function settleAuction(uint256 tokenId) external {
        Auction storage a = auctions[tokenId];
        if (!a.active) revert AuctionNotActive();
        if (a.endTime == 0 || block.timestamp < a.endTime) revert AuctionNotEnded();

        a.active = false;
        a.settled = true;

        // Send NFT to winner
        _transfer(address(this), a.highestBidder, tokenId);

        // Send ETH to PaymentSplitter
        (bool success, ) = paymentSplitter.call{value: a.highestBid}("");
        if (!success) revert ForwardFailed();

        emit AuctionSettled(tokenId, a.highestBidder, a.highestBid);
    }

    /// @notice Owner can cancel auction if no bids yet
    function cancelAuction(uint256 tokenId) external onlyOwner {
        Auction storage a = auctions[tokenId];
        if (!a.active) revert AuctionNotActive();
        if (a.highestBidder != address(0)) revert HasBids();

        a.active = false;
        // Return NFT to owner
        _transfer(address(this), owner(), tokenId);

        emit AuctionCancelled(tokenId);
    }

    function setContractURI(string memory _contractURI) external onlyOwner {
        contractURI = _contractURI;
    }

    function totalSupply() public view returns (uint256) {
        return _nextTokenId;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721URIStorage, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
