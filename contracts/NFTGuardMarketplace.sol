// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  NFTGuardMarketplace
 * @author Tan Weng Liang & Koid Cheng Chun — BMCS3413 Project II (NFTGuard)
 *
 * @notice ERC-721 marketplace prototype deployed on the Ethereum Sepolia testnet.
 *         Designed to support the NFTGuard verification pipeline described in the
 *         FYP report:
 *
 *         1. NFT Authenticity Verification Module (Sprint 1)
 *            - The SHA-256 hash of the metadata JSON is stored ON-CHAIN at mint
 *              time (`metadataHash`). The backend recomputes the hash of the
 *              off-chain (IPFS) metadata and compares it against this value to
 *              detect tampering (FR 1.2 / 1.3).
 *            - The contract is fully ERC-721 + ERC-165 compliant so the backend
 *              can verify standard compliance via `supportsInterface` (FR 1.1).
 *
 *         2. Transaction Simulation Module (Sprint 2)
 *            - mint / list / cancel / buy flows emit indexed events with prices
 *              and timestamps, which the backend ingests as the transaction
 *              dataset for fraud detection and price anomaly analysis (FR 2.x).
 */
contract NFTGuardMarketplace is ERC721URIStorage, Ownable, ReentrancyGuard {
    uint256 private _nextTokenId;

    struct Listing {
        uint256 price;   // in wei
        bool active;
    }

    /// tokenId => SHA-256 hash of the canonical metadata JSON (integrity anchor)
    mapping(uint256 => bytes32) public metadataHash;

    /// tokenId => active marketplace listing
    mapping(uint256 => Listing) public listings;

    /// tokenId => original creator (never changes after mint)
    mapping(uint256 => address) public creatorOf;

    event Minted(
        uint256 indexed tokenId,
        address indexed creator,
        string tokenURI,
        bytes32 metadataHash,
        uint256 timestamp
    );

    event Listed(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price,
        uint256 timestamp
    );

    event ListingCancelled(uint256 indexed tokenId, address indexed seller);

    event Purchased(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 price,
        uint256 timestamp
    );

    constructor() ERC721("NFTGuard Collection", "NFTG") Ownable(msg.sender) {}

    // ---------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------

    /**
     * @param uri            Token URI (typically ipfs://<CID> of the metadata JSON)
     * @param _metadataHash  SHA-256 hash of the exact metadata JSON bytes,
     *                       computed off-chain by the backend before pinning.
     */
    function mintNFT(string calldata uri, bytes32 _metadataHash)
        external
        returns (uint256 tokenId)
    {
        tokenId = ++_nextTokenId;
        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
        metadataHash[tokenId] = _metadataHash;
        creatorOf[tokenId] = msg.sender;
        emit Minted(tokenId, msg.sender, uri, _metadataHash, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Listing  (FR 2.3)
    // ---------------------------------------------------------------------

    function listForSale(uint256 tokenId, uint256 price) external {
        require(ownerOf(tokenId) == msg.sender, "NFTGuard: caller is not owner");
        require(price > 0, "NFTGuard: price must be > 0");
        listings[tokenId] = Listing(price, true);
        emit Listed(tokenId, msg.sender, price, block.timestamp);
    }

    function cancelListing(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "NFTGuard: caller is not owner");
        require(listings[tokenId].active, "NFTGuard: not listed");
        delete listings[tokenId];
        emit ListingCancelled(tokenId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Purchase  (FR 2.4 / 2.5)
    // ---------------------------------------------------------------------

    function buy(uint256 tokenId) external payable nonReentrant {
        Listing memory item = listings[tokenId];
        require(item.active, "NFTGuard: token not listed for sale");
        require(msg.value >= item.price, "NFTGuard: insufficient payment");

        address seller = ownerOf(tokenId);
        require(seller != msg.sender, "NFTGuard: cannot buy own token");

        // Effects before interactions (checks-effects-interactions pattern)
        delete listings[tokenId];
        _transfer(seller, msg.sender, tokenId);

        (bool ok, ) = payable(seller).call{value: msg.value}("");
        require(ok, "NFTGuard: payment transfer failed");

        emit Purchased(tokenId, seller, msg.sender, item.price, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Verification helpers  (FR 1.1 / 1.3) — consumed by the backend
    // ---------------------------------------------------------------------

    /// @notice Compare a recomputed off-chain metadata hash with the on-chain anchor.
    function verifyMetadataHash(uint256 tokenId, bytes32 hashToCheck)
        external
        view
        returns (bool)
    {
        _requireOwned(tokenId); // reverts if token does not exist
        return metadataHash[tokenId] == hashToCheck;
    }

    function getListing(uint256 tokenId)
        external
        view
        returns (uint256 price, bool active)
    {
        Listing memory item = listings[tokenId];
        return (item.price, item.active);
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }
}
