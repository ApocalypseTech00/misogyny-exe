// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRareBazaar {
    function configureAuction(
        bytes32 _auctionType,
        address _originContract,
        uint256 _tokenId,
        uint256 _startingAmount,
        address _currencyAddress,
        uint256 _lengthOfAuction,
        uint256 _startTime,
        address[] calldata _splitAddresses,
        uint8[] calldata _splitRatios
    ) external;

    function cancelAuction(address _originContract, uint256 _tokenId) external;
}

interface IERC721Like {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
}

/**
 * MISOGYNY.EXE — SplitGuard (V6)
 *
 * Immutable wrapper that holds minted NFTs pre-sale and lists them on the Rare Bazaar
 * with revenue splits HARDCODED into bytecode. Primary splits cannot be redirected —
 * not even by DEPLOYER_A.
 *
 * Access model (V6 spec §7.6):
 *   - writer (mapping, gated by DEPLOYER_A)
 *       listAuction, cancelAuction, emergencyWithdraw
 *   - DEPLOYER_A
 *       setWriter (grant/revoke bot)
 *       cancelAuction (backup path if all writers revoked)
 *       emergencyWithdraw (backup path)
 *   - emergencyWithdraw destination is HARDCODED to TREASURY — a compromised writer
 *     cannot withdraw tokens to themselves.
 *
 * If the bot key leaks, DEPLOYER_A calls setWriter(bot, false). Bot is neutered in one tx.
 *
 * Bazaar approval is granted once in the constructor so listings don't race with approvals.
 */
contract SplitGuard {
    IRareBazaar public immutable BAZAAR;
    address public immutable COLLECTION;
    address public immutable SPLITTER;
    bytes32 public immutable AUCTION_TYPE;
    address public immutable DEPLOYER_A;
    address public immutable TREASURY;

    mapping(address => bool) public writer;

    error NotAuthorized();
    error NotTokenOwner();
    error ZeroAddress();

    event WriterUpdated(address indexed account, bool allowed);

    constructor(
        address bazaar,
        address collection,
        address splitter,
        bytes32 auctionType,
        address deployerA,
        address treasury
    ) {
        if (
            bazaar == address(0) ||
            collection == address(0) ||
            splitter == address(0) ||
            deployerA == address(0) ||
            treasury == address(0)
        ) revert ZeroAddress();

        BAZAAR = IRareBazaar(bazaar);
        COLLECTION = collection;
        SPLITTER = splitter;
        AUCTION_TYPE = auctionType;
        DEPLOYER_A = deployerA;
        TREASURY = treasury;

        IERC721Like(collection).setApprovalForAll(bazaar, true);
    }

    modifier onlyDeployerA() {
        if (msg.sender != DEPLOYER_A) revert NotAuthorized();
        _;
    }

    // -------------------------------------------------------
    // Writer management (DEPLOYER_A only)
    // -------------------------------------------------------

    /// @notice DEPLOYER_A grants or revokes a writer (the bot). Revocation is the kill switch.
    function setWriter(address account, bool allowed) external onlyDeployerA {
        writer[account] = allowed;
        emit WriterUpdated(account, allowed);
    }

    // -------------------------------------------------------
    // Listing (writer only)
    // -------------------------------------------------------

    /// @notice List a token held by this contract on the Rare Bazaar with hardcoded splits.
    /// @dev Writer-only. Splits are ALWAYS [SPLITTER, 100] — cannot be redirected.
    function listAuction(
        uint256 tokenId,
        uint256 startingPrice,
        uint256 duration
    ) external {
        if (!writer[msg.sender]) revert NotAuthorized();
        if (IERC721Like(COLLECTION).ownerOf(tokenId) != address(this)) revert NotTokenOwner();

        address[] memory addrs = new address[](1);
        addrs[0] = SPLITTER;
        uint8[] memory ratios = new uint8[](1);
        ratios[0] = 100;

        BAZAAR.configureAuction(
            AUCTION_TYPE,
            COLLECTION,
            tokenId,
            startingPrice,
            address(0), // ETH currency
            duration,
            0, // startTime 0 = starts on first bid (Coldie)
            addrs,
            ratios
        );
    }

    // -------------------------------------------------------
    // Recovery paths (writer OR DEPLOYER_A)
    // -------------------------------------------------------

    /// @notice Cancel an auction. Callable by any writer or by DEPLOYER_A directly.
    /// @dev DEPLOYER_A backup path ensures revoked-bot / lost-bot-key does not lock up live listings.
    function cancelAuction(uint256 tokenId) external {
        if (!writer[msg.sender] && msg.sender != DEPLOYER_A) revert NotAuthorized();
        BAZAAR.cancelAuction(COLLECTION, tokenId);
    }

    /// @notice Pull a stuck token out of this contract. Destination HARDCODED to TREASURY.
    /// @dev A compromised writer CANNOT use this to withdraw to themselves.
    ///      Use case: Rare Bazaar decommissioned, listing failed weirdly, etc.
    function emergencyWithdraw(uint256 tokenId) external {
        if (!writer[msg.sender] && msg.sender != DEPLOYER_A) revert NotAuthorized();
        IERC721Like(COLLECTION).transferFrom(address(this), TREASURY, tokenId);
    }

    /// @notice ERC-721 receiver hook so `safeTransferFrom(..., SplitGuard)` works.
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
