#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Vec, vec, symbol_short};

/// Meta-address entry stored in the registry.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetaAddressEntry {
    /// 32-byte spend public key
    pub spend_pk: BytesN<32>,
    /// 32-byte view public key
    pub view_pk: BytesN<32>,
    /// Block height when registered
    pub registered_at: u32,
}

/// Announcement entry for stealth payments.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnnouncementEntry {
    /// Sender address
    pub sender: Address,
    /// 32-byte ephemeral public key (R = r*G)
    pub ephemeral_pk: BytesN<32>,
    /// View tag for fast scanning (0-255, stored as u32)
    pub view_tag: u32,
    /// 32-byte stealth public key
    pub stealth_pk: BytesN<32>,
    /// Ledger sequence number when announced
    pub sequence: u32,
}

/// Storage keys for the contract.
#[contracttype]
pub enum DataKey {
    /// Meta-address for a given owner
    MetaAddress(Address),
    /// List of all announcements (append-only)
    Announcements,
    /// Counter for total announcements
    AnnouncementCount,
}

#[contract]
pub struct RegistryContract;

#[contractimpl]
impl RegistryContract {
    /// Register a stealth meta-address for the owner.
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `owner` - Address registering the meta-address
    /// * `spend_pk` - 32-byte spend public key
    /// * `view_pk` - 32-byte view public key
    pub fn register(
        env: Env,
        owner: Address,
        spend_pk: BytesN<32>,
        view_pk: BytesN<32>,
    ) {
        // Require authorization from the owner
        owner.require_auth();

        // Get current ledger sequence
        let sequence = env.ledger().sequence();

        // Create meta-address entry
        let entry = MetaAddressEntry {
            spend_pk: spend_pk.clone(),
            view_pk: view_pk.clone(),
            registered_at: sequence,
        };

        // Store in persistent storage
        env.storage()
            .persistent()
            .set(&DataKey::MetaAddress(owner.clone()), &entry);

        // Emit event for off-chain indexing
        env.events().publish(
            (symbol_short!("register"), owner),
            (spend_pk, view_pk, sequence),
        );
    }

    /// Lookup a registered meta-address.
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `owner` - Address to lookup
    ///
    /// # Returns
    /// Meta-address entry if registered, panics otherwise
    pub fn lookup(env: Env, owner: Address) -> MetaAddressEntry {
        env.storage()
            .persistent()
            .get(&DataKey::MetaAddress(owner))
            .unwrap_or_else(|| panic!("Meta-address not found"))
    }

    /// Announce a stealth payment.
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `sender` - Address making the announcement
    /// * `ephemeral_pk` - 32-byte ephemeral public key
    /// * `view_tag` - View tag (0-255)
    /// * `stealth_pk` - 32-byte stealth public key
    pub fn announce(
        env: Env,
        sender: Address,
        ephemeral_pk: BytesN<32>,
        view_tag: u32,
        stealth_pk: BytesN<32>,
    ) {
        // Require authorization from the sender
        sender.require_auth();

        // Get current ledger sequence
        let sequence = env.ledger().sequence();

        // Create announcement entry
        let entry = AnnouncementEntry {
            sender: sender.clone(),
            ephemeral_pk: ephemeral_pk.clone(),
            view_tag,
            stealth_pk: stealth_pk.clone(),
            sequence,
        };

        // Get current announcements list
        let mut announcements: Vec<AnnouncementEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::Announcements)
            .unwrap_or_else(|| vec![&env]);

        // Append new announcement
        announcements.push_back(entry.clone());

        // Store updated list
        env.storage()
            .persistent()
            .set(&DataKey::Announcements, &announcements);

        // Update counter
        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::AnnouncementCount)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::AnnouncementCount, &(count + 1));

        // Emit event for off-chain indexing
        env.events().publish(
            (symbol_short!("announce"), sender),
            (ephemeral_pk, view_tag, stealth_pk, sequence),
        );
    }

    /// Get announcements with pagination.
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `start` - Starting index (0-based)
    /// * `limit` - Maximum number of announcements to return
    ///
    /// # Returns
    /// Vector of announcement entries
    pub fn get_announcements(env: Env, start: u64, limit: u64) -> Vec<AnnouncementEntry> {
        // Get all announcements
        let announcements: Vec<AnnouncementEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::Announcements)
            .unwrap_or_else(|| vec![&env]);

        // Apply pagination
        let total = announcements.len() as u64;
        if start >= total {
            return vec![&env];
        }

        let end = core::cmp::min(start + limit, total);
        let mut result = vec![&env];

        for i in start..end {
            if let Some(entry) = announcements.get(i as u32) {
                result.push_back(entry);
            }
        }

        result
    }

    /// Get total number of announcements.
    ///
    /// # Returns
    /// Total count of announcements
    pub fn get_announcement_count(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::AnnouncementCount)
            .unwrap_or(0)
    }

    /// Get announcements filtered by view tag.
    ///
    /// This enables efficient scanning by filtering announcements
    /// that match a specific view tag value (0-255).
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `view_tag` - View tag to filter by (0-255)
    ///
    /// # Returns
    /// Vector of announcement entries matching the view tag
    pub fn get_announcements_by_tag(env: Env, view_tag: u32) -> Vec<AnnouncementEntry> {
        // Get all announcements
        let announcements: Vec<AnnouncementEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::Announcements)
            .unwrap_or_else(|| vec![&env]);

        // Filter by view tag
        let mut result = vec![&env];
        for announcement in announcements.iter() {
            if announcement.view_tag == view_tag {
                result.push_back(announcement);
            }
        }

        result
    }

    /// Get the total announcement count.
    ///
    /// This is an alias for get_announcement_count for consistency.
    ///
    /// # Returns
    /// Total count of announcements stored
    pub fn announcement_count(env: Env) -> u64 {
        Self::get_announcement_count(env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn test_register_and_lookup() {
        let env = Env::default();
        let contract_id = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let spend_pk = BytesN::from_array(&env, &[1u8; 32]);
        let view_pk = BytesN::from_array(&env, &[2u8; 32]);

        // Mock authentication
        env.mock_all_auths();

        // Register meta-address
        client.register(&owner, &spend_pk, &view_pk);

        // Lookup and verify
        let entry = client.lookup(&owner);
        assert_eq!(entry.spend_pk, spend_pk);
        assert_eq!(entry.view_pk, view_pk);
    }

    #[test]
    fn test_announce_and_get() {
        let env = Env::default();
        let contract_id = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &contract_id);

        let sender = Address::generate(&env);
        let ephemeral_pk = BytesN::from_array(&env, &[3u8; 32]);
        let stealth_pk = BytesN::from_array(&env, &[4u8; 32]);
        let view_tag = 42u32;

        // Mock authentication
        env.mock_all_auths();

        // Make announcement
        client.announce(&sender, &ephemeral_pk, &view_tag, &stealth_pk);

        // Get announcements
        let announcements = client.get_announcements(&0, &10);
        assert_eq!(announcements.len(), 1);

        let entry = announcements.get(0).unwrap();
        assert_eq!(entry.sender, sender);
        assert_eq!(entry.ephemeral_pk, ephemeral_pk);
        assert_eq!(entry.view_tag, view_tag);
        assert_eq!(entry.stealth_pk, stealth_pk);

        // Check count
        let count = client.get_announcement_count();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_pagination() {
        let env = Env::default();
        let contract_id = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &contract_id);

        // Mock authentication
        env.mock_all_auths();

        // Create multiple announcements
        for i in 0..5 {
            let sender = Address::generate(&env);
            let ephemeral_pk = BytesN::from_array(&env, &[i as u8; 32]);
            let stealth_pk = BytesN::from_array(&env, &[(i + 10) as u8; 32]);
            client.announce(&sender, &ephemeral_pk, &i, &stealth_pk);
        }

        // Test pagination
        let page1 = client.get_announcements(&0, &2);
        assert_eq!(page1.len(), 2);

        let page2 = client.get_announcements(&2, &2);
        assert_eq!(page2.len(), 2);

        let page3 = client.get_announcements(&4, &2);
        assert_eq!(page3.len(), 1);

        // Test out of bounds
        let empty = client.get_announcements(&10, &2);
        assert_eq!(empty.len(), 0);

        // Check total count
        let count = client.get_announcement_count();
        assert_eq!(count, 5);
    }

    #[test]
    #[should_panic(expected = "Meta-address not found")]
    fn test_lookup_nonexistent() {
        let env = Env::default();
        let contract_id = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        client.lookup(&owner);
    }

    #[test]
    fn test_get_announcements_by_tag() {
        let env = Env::default();
        let contract_id = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &contract_id);

        // Mock authentication
        env.mock_all_auths();

        // Create announcements with different view tags
        for i in 0..10 {
            let sender = Address::generate(&env);
            let ephemeral_pk = BytesN::from_array(&env, &[i as u8; 32]);
            let stealth_pk = BytesN::from_array(&env, &[(i + 20) as u8; 32]);
            let view_tag = (i % 3) as u32; // Tags will be 0, 1, 2
            client.announce(&sender, &ephemeral_pk, &view_tag, &stealth_pk);
        }

        // Get announcements with tag 0 (should be indices 0, 3, 6, 9)
        let tag0_announcements = client.get_announcements_by_tag(&0);
        assert_eq!(tag0_announcements.len(), 4);

        // Get announcements with tag 1 (should be indices 1, 4, 7)
        let tag1_announcements = client.get_announcements_by_tag(&1);
        assert_eq!(tag1_announcements.len(), 3);

        // Get announcements with tag 2 (should be indices 2, 5, 8)
        let tag2_announcements = client.get_announcements_by_tag(&2);
        assert_eq!(tag2_announcements.len(), 3);

        // Get announcements with non-existent tag
        let tag99_announcements = client.get_announcements_by_tag(&99);
        assert_eq!(tag99_announcements.len(), 0);

        // Verify announcement_count alias
        let count1 = client.get_announcement_count();
        let count2 = client.announcement_count();
        assert_eq!(count1, count2);
        assert_eq!(count1, 10);
    }
}