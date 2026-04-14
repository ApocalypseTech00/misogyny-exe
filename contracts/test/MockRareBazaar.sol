// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Test-only mock of the Rare Protocol Bazaar.
 * Records calls to configureAuction and cancelAuction so tests can assert args.
 */
contract MockRareBazaar {
    struct AuctionCall {
        bytes32 auctionType;
        address originContract;
        uint256 tokenId;
        uint256 startingAmount;
        address currencyAddress;
        uint256 lengthOfAuction;
        uint256 startTime;
        address[] splitAddresses;
        uint8[] splitRatios;
    }

    AuctionCall[] internal _calls;
    mapping(bytes32 => bool) internal _cancelled;

    event AuctionConfigured(address indexed originContract, uint256 indexed tokenId);
    event AuctionCancelled(address indexed originContract, uint256 indexed tokenId);

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
    ) external {
        _calls.push(AuctionCall({
            auctionType: _auctionType,
            originContract: _originContract,
            tokenId: _tokenId,
            startingAmount: _startingAmount,
            currencyAddress: _currencyAddress,
            lengthOfAuction: _lengthOfAuction,
            startTime: _startTime,
            splitAddresses: _splitAddresses,
            splitRatios: _splitRatios
        }));
        emit AuctionConfigured(_originContract, _tokenId);
    }

    function cancelAuction(address _originContract, uint256 _tokenId) external {
        _cancelled[keccak256(abi.encode(_originContract, _tokenId))] = true;
        emit AuctionCancelled(_originContract, _tokenId);
    }

    // --- Test helpers ---

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function getCall(uint256 i) external view returns (AuctionCall memory) {
        return _calls[i];
    }

    function isCancelled(address originContract, uint256 tokenId) external view returns (bool) {
        return _cancelled[keccak256(abi.encode(originContract, tokenId))];
    }
}
