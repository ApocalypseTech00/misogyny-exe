// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IRareCollection {
    function mint(address to, string calldata tokenURI) external returns (uint256);
    function updateTokenURI(uint256 tokenId, string calldata uri) external;
    function setRoyaltyReceiver(address receiver) external;
    function transferOwnership(address newOwner) external;
}

/**
 * MISOGYNY.EXE — Collection Admin (V6)
 *
 * Writer-role wrapper around the Rare Protocol ERC-721 collection.
 *
 * Ownership + role model (V6 spec §5, §7.2):
 *   - owner  = DEPLOYER_A (cold-ish wallet, bookmark-only, grants/revokes writers + admin ops)
 *   - writer = BOT (hot Pi wallet)
 *
 * Bot can call:
 *   - mint(uri, quote)        mints on the Rare collection with recipient HARDCODED to SPLIT_GUARD.
 *                             `quote` is emitted in the MintRouted event only — the actual on-chain
 *                             quote record is written by the bot's separate call to
 *                             QuoteRegistry.registerQuote (V6 spec §6.1 step 19 + 20).
 *   - updateTokenURI(id, uri) forwards to the Rare collection (redemption).
 *
 * Bot CANNOT:
 *   - mint to any address other than SPLIT_GUARD (hardcoded immutable)
 *   - change SPLIT_GUARD, COLLECTION addresses (immutable)
 *   - transferOwnership, setRoyaltyReceiver (owner only)
 *
 * If bot key leaks, owner calls setWriter(bot, false). Revoked in one tx.
 */
contract CollectionAdmin is Ownable {
    IRareCollection public immutable COLLECTION;
    address public immutable SPLIT_GUARD;

    mapping(address => bool) public writer;

    event WriterUpdated(address indexed account, bool allowed);
    event MintRouted(uint256 indexed tokenId, string uri, string quote);

    error NotWriter();
    error ZeroAddress();

    constructor(address collection, address splitGuard) Ownable(msg.sender) {
        if (collection == address(0) || splitGuard == address(0)) revert ZeroAddress();
        COLLECTION = IRareCollection(collection);
        SPLIT_GUARD = splitGuard;
    }

    modifier onlyWriter() {
        if (!writer[msg.sender]) revert NotWriter();
        _;
    }

    // -------------------------------------------------------
    // Writer management (owner only)
    // -------------------------------------------------------

    function setWriter(address account, bool allowed) external onlyOwner {
        writer[account] = allowed;
        emit WriterUpdated(account, allowed);
    }

    // -------------------------------------------------------
    // Writes (writer only)
    // -------------------------------------------------------

    /// @notice Mint on the Rare collection with recipient hardcoded to SPLIT_GUARD.
    /// @param uri     IPFS metadata URI (ipfs://<cid>)
    /// @param quote   The misogynistic quote text (emitted in event for indexer convenience)
    /// @return tokenId the newly minted Rare token id
    function mint(string calldata uri, string calldata quote)
        external
        onlyWriter
        returns (uint256 tokenId)
    {
        tokenId = COLLECTION.mint(SPLIT_GUARD, uri);
        emit MintRouted(tokenId, uri, quote);
    }

    /// @notice Update a token's metadata URI (redemption).
    function updateTokenURI(uint256 tokenId, string calldata uri) external onlyWriter {
        COLLECTION.updateTokenURI(tokenId, uri);
    }

    // -------------------------------------------------------
    // Admin passthroughs (owner only)
    // -------------------------------------------------------

    function setRoyaltyReceiver(address receiver) external onlyOwner {
        COLLECTION.setRoyaltyReceiver(receiver);
    }

    function transferCollectionOwnership(address newOwner) external onlyOwner {
        COLLECTION.transferOwnership(newOwner);
    }
}
