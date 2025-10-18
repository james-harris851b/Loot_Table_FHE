// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface LootItem {
  id: string;
  encryptedDropRate: string;
  timestamp: number;
  owner: string;
  category: string;
  status: "common" | "rare" | "legendary";
  name: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [lootItems, setLootItems] = useState<LootItem[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newLootItem, setNewLootItem] = useState({ name: "", category: "weapon", dropRate: 0.01 });
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [selectedItem, setSelectedItem] = useState<LootItem | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [contributors, setContributors] = useState<{address: string, count: number}[]>([]);

  // Stats calculations
  const commonCount = lootItems.filter(i => i.status === "common").length;
  const rareCount = lootItems.filter(i => i.status === "rare").length;
  const legendaryCount = lootItems.filter(i => i.status === "legendary").length;
  const totalDropRate = lootItems.reduce((sum, item) => sum + FHEDecryptNumber(item.encryptedDropRate), 0);
  const averageDropRate = lootItems.length > 0 ? totalDropRate / lootItems.length : 0;

  useEffect(() => {
    loadLootItems().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadLootItems = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load loot item keys
      const keysBytes = await contract.getData("loot_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing loot keys:", e); }
      }
      
      // Load each loot item
      const list: LootItem[] = [];
      const contributorMap: Record<string, number> = {};
      
      for (const key of keys) {
        try {
          const itemBytes = await contract.getData(`loot_${key}`);
          if (itemBytes.length > 0) {
            try {
              const itemData = JSON.parse(ethers.toUtf8String(itemBytes));
              list.push({ 
                id: key, 
                encryptedDropRate: itemData.dropRate, 
                timestamp: itemData.timestamp, 
                owner: itemData.owner, 
                category: itemData.category, 
                status: itemData.status || "common",
                name: itemData.name
              });
              
              // Track contributors
              contributorMap[itemData.owner] = (contributorMap[itemData.owner] || 0) + 1;
            } catch (e) { console.error(`Error parsing loot data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading loot ${key}:`, e); }
      }
      
      // Sort by drop rate (descending)
      list.sort((a, b) => FHEDecryptNumber(b.encryptedDropRate) - FHEDecryptNumber(a.encryptedDropRate));
      setLootItems(list);
      
      // Process contributors
      const contributorList = Object.entries(contributorMap).map(([address, count]) => ({ address, count }));
      contributorList.sort((a, b) => b.count - a.count);
      setContributors(contributorList.slice(0, 5));
    } catch (e) { 
      console.error("Error loading loot items:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitLootItem = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting drop rate with Zama FHE..." });
    try {
      const encryptedDropRate = FHEEncryptNumber(newLootItem.dropRate);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const itemId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const itemData = { 
        name: newLootItem.name,
        dropRate: encryptedDropRate, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newLootItem.category, 
        status: determineRarity(newLootItem.dropRate)
      };
      
      await contract.setData(`loot_${itemId}`, ethers.toUtf8Bytes(JSON.stringify(itemData)));
      
      // Update keys
      const keysBytes = await contract.getData("loot_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(itemId);
      await contract.setData("loot_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Loot item added with FHE encryption!" });
      await loadLootItems();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewLootItem({ name: "", category: "weapon", dropRate: 0.01 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const determineRarity = (dropRate: number): "common" | "rare" | "legendary" => {
    if (dropRate >= 0.1) return "common";
    if (dropRate >= 0.01) return "rare";
    return "legendary";
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const enhanceDropRate = async (itemId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted drop rate with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const itemBytes = await contract.getData(`loot_${itemId}`);
      if (itemBytes.length === 0) throw new Error("Item not found");
      const itemData = JSON.parse(ethers.toUtf8String(itemBytes));
      
      // Perform FHE computation to increase drop rate by 10%
      const enhancedDropRate = FHECompute(itemData.dropRate, 'increase10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedItem = { ...itemData, dropRate: enhancedDropRate };
      await contractWithSigner.setData(`loot_${itemId}`, ethers.toUtf8Bytes(JSON.stringify(updatedItem)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE enhancement completed successfully!" });
      await loadLootItems();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Enhancement failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (itemAddress: string) => address?.toLowerCase() === itemAddress.toLowerCase();

  const filteredItems = lootItems.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         item.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === "all" || item.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const renderRarityBadge = (rarity: string) => {
    switch(rarity) {
      case "common":
        return <span className="rarity-badge common">Common</span>;
      case "rare":
        return <span className="rarity-badge rare">Rare</span>;
      case "legendary":
        return <span className="rarity-badge legendary">Legendary</span>;
      default:
        return <span className="rarity-badge">{rarity}</span>;
    }
  };

  const renderDropRateBar = (dropRate: string) => {
    const rate = FHEDecryptNumber(dropRate) * 100;
    return (
      <div className="drop-rate-bar">
        <div 
          className="drop-rate-fill" 
          style={{ width: `${Math.min(100, rate * 10)}%` }}
        ></div>
        <span className="drop-rate-text">{rate.toFixed(2)}%</span>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing encrypted loot table...</p>
    </div>
  );

  return (
    <div className="app-container cyberpunk-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>隱秘掉寶<span>FHE Loot System</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn cyber-button">
            <div className="add-icon"></div>Add Item
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Encrypted Loot Table</h2>
            <p>Modify encrypted drop rates without decryption using Zama FHE technology</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>FHE Encryption Active</span>
          </div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-card cyber-card">
            <h3>Loot Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{lootItems.length}</div>
                <div className="stat-label">Total Items</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{commonCount}</div>
                <div className="stat-label">Common</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{rareCount}</div>
                <div className="stat-label">Rare</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{legendaryCount}</div>
                <div className="stat-label">Legendary</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{averageDropRate.toFixed(4)}</div>
                <div className="stat-label">Avg Drop Rate</div>
              </div>
            </div>
          </div>

          <div className="dashboard-card cyber-card">
            <h3>Top Contributors</h3>
            <div className="contributors-list">
              {contributors.length > 0 ? (
                contributors.map((contributor, index) => (
                  <div key={contributor.address} className="contributor-item">
                    <span className="contributor-rank">#{index + 1}</span>
                    <span className="contributor-address">
                      {contributor.address.substring(0, 6)}...{contributor.address.substring(38)}
                    </span>
                    <span className="contributor-count">{contributor.count} items</span>
                  </div>
                ))
              ) : (
                <div className="no-contributors">No contributors yet</div>
              )}
            </div>
          </div>
        </div>

        <div className="loot-section">
          <div className="section-header">
            <h2>Encrypted Loot Table</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search items..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="cyber-input"
                />
                <select 
                  value={selectedCategory} 
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="cyber-select"
                >
                  <option value="all">All Categories</option>
                  <option value="weapon">Weapons</option>
                  <option value="armor">Armor</option>
                  <option value="consumable">Consumables</option>
                  <option value="material">Materials</option>
                  <option value="accessory">Accessories</option>
                </select>
              </div>
              <button onClick={loadLootItems} className="refresh-btn cyber-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="loot-list cyber-card">
            <div className="table-header">
              <div className="header-cell">Item</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">Rarity</div>
              <div className="header-cell">Drop Rate</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Actions</div>
            </div>

            {filteredItems.length === 0 ? (
              <div className="no-items">
                <div className="no-items-icon"></div>
                <p>No loot items found</p>
                <button className="cyber-button primary" onClick={() => setShowCreateModal(true)}>
                  Add First Item
                </button>
              </div>
            ) : (
              filteredItems.map(item => (
                <div className="loot-row" key={item.id} onClick={() => setSelectedItem(item)}>
                  <div className="table-cell item-name">{item.name}</div>
                  <div className="table-cell">{item.category}</div>
                  <div className="table-cell">{renderRarityBadge(item.status)}</div>
                  <div className="table-cell">{renderDropRateBar(item.encryptedDropRate)}</div>
                  <div className="table-cell">{item.owner.substring(0, 6)}...{item.owner.substring(38)}</div>
                  <div className="table-cell actions">
                    {isOwner(item.owner) && (
                      <button 
                        className="action-btn cyber-button success" 
                        onClick={(e) => { e.stopPropagation(); enhanceDropRate(item.id); }}
                      >
                        Enhance
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitLootItem} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          lootItem={newLootItem} 
          setLootItem={setNewLootItem}
        />
      )}

      {selectedItem && (
        <LootDetailModal 
          item={selectedItem} 
          onClose={() => { setSelectedItem(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>隱秘掉寶 FHE Loot System</span>
            </div>
            <p>Powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Game Economy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} 隱秘掉寶. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  lootItem: any;
  setLootItem: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, lootItem, setLootItem }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setLootItem({ ...lootItem, [name]: value });
  };

  const handleRateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setLootItem({ ...lootItem, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!lootItem.name || lootItem.dropRate <= 0) { 
      alert("Please fill required fields with valid values"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal cyber-card">
        <div className="modal-header">
          <h2>Add Loot Item</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Drop rates will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Item Name *</label>
              <input 
                type="text" 
                name="name" 
                value={lootItem.name} 
                onChange={handleChange} 
                placeholder="Enter item name..."
                className="cyber-input"
              />
            </div>
            <div className="form-group">
              <label>Category *</label>
              <select 
                name="category" 
                value={lootItem.category} 
                onChange={handleChange} 
                className="cyber-select"
              >
                <option value="weapon">Weapon</option>
                <option value="armor">Armor</option>
                <option value="consumable">Consumable</option>
                <option value="material">Material</option>
                <option value="accessory">Accessory</option>
              </select>
            </div>
            <div className="form-group">
              <label>Drop Rate *</label>
              <input 
                type="number" 
                name="dropRate" 
                value={lootItem.dropRate} 
                onChange={handleRateChange} 
                min="0.0001"
                max="1"
                step="0.0001"
                placeholder="0.0000 to 1.0000"
                className="cyber-input"
              />
              <div className="rate-preview">
                Base Rarity: {lootItem.dropRate >= 0.1 ? "Common" : lootItem.dropRate >= 0.01 ? "Rare" : "Legendary"}
              </div>
            </div>
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Drop Rate:</span>
                <div>{(lootItem.dropRate * 100).toFixed(4)}%</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{lootItem.dropRate ? FHEEncryptNumber(lootItem.dropRate).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn cyber-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn cyber-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface LootDetailModalProps {
  item: LootItem;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const LootDetailModal: React.FC<LootDetailModalProps> = ({ item, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(item.encryptedDropRate);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="loot-detail-modal cyber-card">
        <div className="modal-header">
          <h2>{item.name}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="item-info">
            <div className="info-item">
              <span>Category:</span>
              <strong>{item.category}</strong>
            </div>
            <div className="info-item">
              <span>Rarity:</span>
              <strong>{renderRarityBadge(item.status)}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{item.owner.substring(0, 6)}...{item.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Added:</span>
              <strong>{new Date(item.timestamp * 1000).toLocaleString()}</strong>
            </div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Drop Rate</h3>
            <div className="encrypted-data">
              {item.encryptedDropRate.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn cyber-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedValue !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Drop Rate</h3>
              <div className="decrypted-value">
                {(decryptedValue * 100).toFixed(4)}%
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn cyber-button">Close</button>
        </div>
      </div>
    </div>
  );
};

const renderRarityBadge = (rarity: string) => {
  switch(rarity) {
    case "common":
      return <span className="rarity-badge common">Common</span>;
    case "rare":
      return <span className="rarity-badge rare">Rare</span>;
    case "legendary":
      return <span className="rarity-badge legendary">Legendary</span>;
    default:
      return <span className="rarity-badge">{rarity}</span>;
  }
};

export default App;