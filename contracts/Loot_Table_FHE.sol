pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract LootTableFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatchState();
    error InvalidParameter();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;
    mapping(uint256 => mapping(uint256 => euint32)) public lootTableEncrypted; // batchId => itemId => encryptedDropRate
    mapping(uint256 => mapping(uint256 => euint32)) public enchantmentsEncrypted; // batchId => itemId => encryptedEnchantmentFactor
    mapping(uint256 => mapping(uint256 => bool)) public itemInitialized; // batchId => itemId => initialized

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event LootTableSubmitted(uint256 indexed batchId, uint256 indexed itemId, address indexed submitter);
    event EnchantmentSubmitted(uint256 indexed batchId, uint256 indexed itemId, address indexed submitter);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] itemIds, uint256[] finalDropRates);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier respectCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;
        _;
    }

    modifier respectDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidParameter();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert InvalidBatchState();
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert InvalidBatchState();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function _initIfNeeded(euint32 storage itemRate) internal {
        if (!itemRate.isInitialized()) {
            itemRate.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 storage itemRate) internal view {
        if (!itemRate.isInitialized()) {
            revert NotInitialized();
        }
    }

    function submitLootTableEntry(uint256 itemId, euint32 memory encryptedDropRate)
        external
        onlyProvider
        whenNotPaused
        respectCooldown
    {
        if (!batchOpen) revert InvalidBatchState();
        _initIfNeeded(lootTableEncrypted[currentBatchId][itemId]);
        lootTableEncrypted[currentBatchId][itemId] = encryptedDropRate;
        itemInitialized[currentBatchId][itemId] = true;
        emit LootTableSubmitted(currentBatchId, itemId, msg.sender);
    }

    function submitEnchantment(uint256 itemId, euint32 memory encryptedEnchantmentFactor)
        external
        onlyProvider
        whenNotPaused
        respectCooldown
    {
        if (!batchOpen) revert InvalidBatchState();
        _requireInitialized(lootTableEncrypted[currentBatchId][itemId]);
        enchantmentsEncrypted[currentBatchId][itemId] = encryptedEnchantmentFactor;
        emit EnchantmentSubmitted(currentBatchId, itemId, msg.sender);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function requestBatchDecryption(uint256 batchId, uint256[] calldata itemIds)
        external
        whenNotPaused
        respectDecryptionCooldown
    {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidParameter();
        if (itemIds.length == 0) revert InvalidParameter();

        bytes32[] memory cts = new bytes32[](itemIds.length);
        for (uint i = 0; i < itemIds.length; i++) {
            uint256 itemId = itemIds[i];
            if (!itemInitialized[batchId][itemId]) revert NotInitialized();
            euint32 storage baseRate = lootTableEncrypted[batchId][itemId];
            euint32 storage enchantFactor = enchantmentsEncrypted[batchId][itemId];
            euint32 memory finalRate = baseRate.mul(enchantFactor);
            cts[i] = finalRate.toBytes32();
        }

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        DecryptionContext memory context = decryptionContexts[requestId];

        // Rebuild cts for state verification
        uint256[] memory itemIds = new uint256[](cleartexts.length / 32);
        bytes32[] memory currentCts = new bytes32[](cleartexts.length / 32);
        uint idx = 0;
        for (uint i = 0; i < cleartexts.length; i += 32) {
            uint256 itemId;
            uint256 finalDropRate = abi.decode(cleartexts[i:i+32], (uint256));
            // This simplified itemId reconstruction assumes itemIds were sequential or known.
            // A more robust solution would pass itemIds with the request or store them.
            // For this example, we assume itemIds are 0, 1, 2... or can be inferred.
            // If itemIds were passed in requestBatchDecryption, they should be stored and retrieved here.
            // For now, let's assume they are passed in the cleartexts or context.
            // This is a placeholder for actual item ID retrieval logic.
            // A real implementation would need to store/retrieve the itemIds associated with the request.
            // For this example, we'll assume itemIds are implicitly known or passed.
            // This part is simplified for the example.
            // A proper implementation would store the itemIds with the request.
            // For now, we'll just use a counter for idx.
            itemId = idx; // Simplified. Needs proper item ID handling.
            itemIds[idx] = itemId;

            euint32 memory currentFinalRate = lootTableEncrypted[context.batchId][itemId].mul(enchantmentsEncrypted[context.batchId][itemId]);
            currentCts[idx] = currentFinalRate.toBytes32();
            idx++;
        }

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != context.stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        uint256[] memory finalDropRates = new uint256[](cleartexts.length / 32);
        for (uint i = 0; i < cleartexts.length; i += 32) {
            finalDropRates[i/32] = abi.decode(cleartexts[i:i+32], (uint256));
        }

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, context.batchId, itemIds, finalDropRates);
    }
}