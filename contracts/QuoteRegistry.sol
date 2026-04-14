// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * MISOGYNY.EXE — Quote Registry (V6)
 *
 * Companion contract for the Rare Protocol ERC-721 collection.
 * Stores misogynistic quotes (at mint) and comebacks (at redemption)
 * permanently on-chain as an accountability record.
 *
 * Ownership + role model (V6 spec §5, §7.3):
 *   - owner  = DEPLOYER_B (cold-ish wallet, bookmark-only, grants/revokes writers)
 *   - writer = BOT (hot Pi wallet) + CollectionAdmin (if used for atomic calls)
 *
 * Writes (registerQuote / inscribeComeback / registerBoth) are gated onlyWriter.
 * If the bot key leaks, owner calls setWriter(bot, false) — bot is neutered in one tx.
 *
 * The quotes are the shame. The comebacks are the answer.
 */
contract QuoteRegistry is Ownable {
    /// @notice Max string length in bytes (prevents unbounded gas cost)
    uint256 public constant MAX_STRING_BYTES = 1024;

    /// @notice The original misogynistic quote, set at mint time
    mapping(uint256 => string) public quoteOf;

    /// @notice The comeback (roast or feminist power quote), set at redemption
    mapping(uint256 => string) public comebackOf;

    /// @notice Whether a comeback has been inscribed for this token
    mapping(uint256 => bool) public redeemed;

    /// @notice Addresses authorised to write (registerQuote / inscribeComeback)
    mapping(address => bool) public writer;

    /// @notice Total quotes registered (monotonic, does not decrement)
    uint256 public totalQuotes;

    event QuoteRegistered(uint256 indexed tokenId, string quote);
    event ComebackInscribed(uint256 indexed tokenId, string comeback);
    event WriterUpdated(address indexed account, bool allowed);

    error AlreadyRegistered();
    error AlreadyRedeemed();
    error EmptyString();
    error StringTooLong();
    error NotRegistered();
    error NotWriter();

    constructor() Ownable(msg.sender) {}

    modifier onlyWriter() {
        if (!writer[msg.sender]) revert NotWriter();
        _;
    }

    // -------------------------------------------------------
    // Writer management (owner only)
    // -------------------------------------------------------

    /// @notice Grant or revoke writer access. Owner only.
    function setWriter(address account, bool allowed) external onlyOwner {
        writer[account] = allowed;
        emit WriterUpdated(account, allowed);
    }

    // -------------------------------------------------------
    // Writes (writer only)
    // -------------------------------------------------------

    /// @notice Register a misogynistic quote at mint time
    function registerQuote(
        uint256 tokenId,
        string calldata quote
    ) external onlyWriter {
        if (bytes(quoteOf[tokenId]).length > 0) revert AlreadyRegistered();
        if (bytes(quote).length == 0) revert EmptyString();
        if (bytes(quote).length > MAX_STRING_BYTES) revert StringTooLong();
        quoteOf[tokenId] = quote;
        totalQuotes++;
        emit QuoteRegistered(tokenId, quote);
    }

    /// @notice Inscribe the comeback after a token is purchased
    function inscribeComeback(
        uint256 tokenId,
        string calldata comeback
    ) external onlyWriter {
        if (bytes(quoteOf[tokenId]).length == 0) revert NotRegistered();
        if (redeemed[tokenId]) revert AlreadyRedeemed();
        if (bytes(comeback).length == 0) revert EmptyString();
        if (bytes(comeback).length > MAX_STRING_BYTES) revert StringTooLong();
        comebackOf[tokenId] = comeback;
        redeemed[tokenId] = true;
        emit ComebackInscribed(tokenId, comeback);
    }

    /// @notice Register quote and comeback in one call (for migration)
    function registerBoth(
        uint256 tokenId,
        string calldata quote,
        string calldata comeback
    ) external onlyWriter {
        if (bytes(quoteOf[tokenId]).length > 0) revert AlreadyRegistered();
        if (bytes(quote).length == 0) revert EmptyString();
        if (bytes(comeback).length == 0) revert EmptyString();
        if (bytes(quote).length > MAX_STRING_BYTES) revert StringTooLong();
        if (bytes(comeback).length > MAX_STRING_BYTES) revert StringTooLong();
        quoteOf[tokenId] = quote;
        comebackOf[tokenId] = comeback;
        redeemed[tokenId] = true;
        totalQuotes++;
        emit QuoteRegistered(tokenId, quote);
        emit ComebackInscribed(tokenId, comeback);
    }
}
