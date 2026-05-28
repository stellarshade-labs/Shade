use soroban_sdk::{contracttype, Address, BytesN};

/// Meta-address entry stored in the registry
#[derive(Clone)]
#[contracttype]
pub struct MetaAddressEntry {
    /// Owner of this meta-address
    pub owner: Address,
    /// 32-byte spending public key
    pub spend_pub_key: BytesN<32>,
    /// 32-byte viewing public key
    pub view_pub_key: BytesN<32>,
    /// Timestamp when registered
    pub registered_at: u64,
}

/// Announcement entry for stealth payments
#[derive(Clone)]
#[contracttype]
pub struct AnnouncementEntry {
    /// 32-byte ephemeral public key R
    pub ephemeral_pub_key: BytesN<32>,
    /// Single byte view tag (stored as u32)
    pub view_tag: u32,
    /// Stealth account address
    pub stealth_address: Address,
    /// Transaction hash (optional)
    pub tx_hash: Option<BytesN<32>>,
    /// Timestamp when announced
    pub announced_at: u64,
}