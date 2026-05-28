#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Bytes, BytesN, Env, Vec, vec,
    symbol_short,
};

/// Announcement entry for stealth payments.
/// Created atomically with each deposit — no deposit, no announcement.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnnouncementEntry {
    /// 32-byte ephemeral public key (R = r*G)
    pub ephemeral_pk: BytesN<32>,
    /// View tag for fast scanning (0-255, stored as u32)
    pub view_tag: u32,
    /// 32-byte stealth public key
    pub stealth_pk: BytesN<32>,
    /// Token address that was deposited
    pub token: Address,
    /// Amount deposited (in smallest unit)
    pub amount: i128,
    /// Ledger sequence number when deposited
    pub sequence: u32,
}

/// Storage keys for the contract.
#[contracttype]
pub enum DataKey {
    /// Balance for a (stealth_pk, token) pair
    Balance(BytesN<32>, Address),
    /// Replay-protection nonce per stealth key
    Nonce(BytesN<32>),
    /// Append-only list of all announcements
    Announcements,
    /// Counter for total announcements
    AnnouncementCount,
}

/// TTL constants for persistent storage.
const TTL_THRESHOLD: u32 = 518_400; // ~30 days
const TTL_EXTEND_TO: u32 = 1_555_200; // ~90 days

#[contract]
pub struct StealthPoolContract;

#[contractimpl]
impl StealthPoolContract {
    /// Deposit tokens into the stealth pool and create an announcement.
    ///
    /// This atomically transfers tokens from the sender to the contract
    /// and records the announcement. No deposit = no announcement (spam-proof).
    pub fn deposit(
        env: Env,
        sender: Address,
        token_addr: Address,
        amount: i128,
        stealth_pk: BytesN<32>,
        ephemeral_pk: BytesN<32>,
        view_tag: u32,
    ) {
        sender.require_auth();
        assert!(amount > 0, "amount must be positive");

        // Transfer tokens from sender to contract
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        // Update balance
        let bal_key = DataKey::Balance(stealth_pk.clone(), token_addr.clone());
        let current: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        env.storage().persistent().set(&bal_key, &(current + amount));
        env.storage().persistent().extend_ttl(&bal_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Append announcement
        let entry = AnnouncementEntry {
            ephemeral_pk: ephemeral_pk.clone(),
            view_tag,
            stealth_pk: stealth_pk.clone(),
            token: token_addr.clone(),
            amount,
            sequence: env.ledger().sequence(),
        };

        let mut announcements: Vec<AnnouncementEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::Announcements)
            .unwrap_or_else(|| vec![&env]);
        announcements.push_back(entry);
        env.storage().persistent().set(&DataKey::Announcements, &announcements);
        env.storage().persistent().extend_ttl(&DataKey::Announcements, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Increment counter
        let count: u64 = env.storage().persistent().get(&DataKey::AnnouncementCount).unwrap_or(0);
        env.storage().persistent().set(&DataKey::AnnouncementCount, &(count + 1));
        env.storage().persistent().extend_ttl(&DataKey::AnnouncementCount, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Emit event
        env.events().publish(
            (symbol_short!("deposit"), sender),
            (token_addr, amount, stealth_pk, ephemeral_pk, view_tag),
        );
    }

    /// Withdraw tokens from the stealth pool.
    ///
    /// Authorization is via ed25519 signature verification on the stealth key,
    /// NOT via Soroban require_auth. This allows anyone (including a relayer)
    /// to submit the transaction on behalf of the recipient.
    ///
    /// Message format: SHA256(stealth_pk || token || amount || destination || nonce)
    /// All fields are concatenated as raw bytes.
    pub fn withdraw(
        env: Env,
        stealth_pk: BytesN<32>,
        token_addr: Address,
        amount: i128,
        destination: Address,
        nonce: u64,
        signature: BytesN<64>,
    ) {
        assert!(amount > 0, "amount must be positive");

        // Replay protection: nonce must be strictly greater than stored
        let nonce_key = DataKey::Nonce(stealth_pk.clone());
        let stored_nonce: u64 = env.storage().persistent().get(&nonce_key).unwrap_or(0);
        assert!(nonce > stored_nonce, "nonce too low");

        // Build the message that was signed
        let message = Self::build_withdraw_message(
            &env,
            &stealth_pk,
            &token_addr,
            amount,
            &destination,
            nonce,
        );

        // Verify ed25519 signature — panics if invalid
        env.crypto().ed25519_verify(&stealth_pk, &message, &signature);

        // Check and decrement balance
        let bal_key = DataKey::Balance(stealth_pk.clone(), token_addr.clone());
        let current: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        assert!(current >= amount, "insufficient balance");
        let new_balance = current - amount;
        if new_balance > 0 {
            env.storage().persistent().set(&bal_key, &new_balance);
            env.storage().persistent().extend_ttl(&bal_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        } else {
            env.storage().persistent().remove(&bal_key);
        }

        // Transfer tokens from contract to destination
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        // Update nonce
        env.storage().persistent().set(&nonce_key, &nonce);
        env.storage().persistent().extend_ttl(&nonce_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Emit event
        env.events().publish(
            (symbol_short!("withdraw"), destination),
            (stealth_pk, token_addr, amount),
        );
    }

    /// Build the message bytes for withdraw signature verification.
    /// Format: SHA256(stealth_pk(32) || token_str_bytes || amount_be(16) || dest_str_bytes || nonce_be(8))
    fn build_withdraw_message(
        env: &Env,
        stealth_pk: &BytesN<32>,
        token_addr: &Address,
        amount: i128,
        destination: &Address,
        nonce: u64,
    ) -> Bytes {
        let mut msg = Bytes::new(env);

        // stealth_pk: 32 bytes
        msg.append(&Bytes::from_slice(env, &stealth_pk.to_array()));

        // token address as StrKey bytes (always 56 chars for G.../C... addresses)
        let token_str = token_addr.to_string();
        let mut token_buf = [0u8; 56];
        token_str.copy_into_slice(&mut token_buf);
        msg.append(&Bytes::from_slice(env, &token_buf));

        // amount: 16 bytes big-endian i128
        msg.append(&Bytes::from_slice(env, &amount.to_be_bytes()));

        // destination address as StrKey bytes (always 56 chars)
        let dest_str = destination.to_string();
        let mut dest_buf = [0u8; 56];
        dest_str.copy_into_slice(&mut dest_buf);
        msg.append(&Bytes::from_slice(env, &dest_buf));

        // nonce: 8 bytes big-endian u64
        msg.append(&Bytes::from_slice(env, &nonce.to_be_bytes()));

        env.crypto().sha256(&msg).into()
    }

    /// Get balance for a stealth key + token pair.
    pub fn get_balance(env: Env, stealth_pk: BytesN<32>, token_addr: Address) -> i128 {
        let bal_key = DataKey::Balance(stealth_pk, token_addr);
        env.storage().persistent().get(&bal_key).unwrap_or(0)
    }

    /// Get the current nonce for a stealth key (for constructing withdraw messages).
    pub fn get_nonce(env: Env, stealth_pk: BytesN<32>) -> u64 {
        let nonce_key = DataKey::Nonce(stealth_pk);
        env.storage().persistent().get(&nonce_key).unwrap_or(0)
    }

    /// Get announcements with pagination.
    pub fn get_announcements(env: Env, start: u64, limit: u64) -> Vec<AnnouncementEntry> {
        let announcements: Vec<AnnouncementEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::Announcements)
            .unwrap_or_else(|| vec![&env]);

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

    /// Get announcements filtered by view tag.
    pub fn get_announcements_by_tag(env: Env, view_tag: u32) -> Vec<AnnouncementEntry> {
        let announcements: Vec<AnnouncementEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::Announcements)
            .unwrap_or_else(|| vec![&env]);

        let mut result = vec![&env];
        for announcement in announcements.iter() {
            if announcement.view_tag == view_tag {
                result.push_back(announcement);
            }
        }
        result
    }

    /// Get total number of announcements.
    pub fn get_announcement_count(env: Env) -> u64 {
        env.storage().persistent().get(&DataKey::AnnouncementCount).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup_token(env: &Env) -> (Address, Address, token::StellarAssetClient<'_>) {
        let admin = Address::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone()).address().clone();
        let sac = token::StellarAssetClient::new(env, &token_id);
        (token_id, admin, sac)
    }

    #[test]
    fn test_deposit_creates_balance_and_announcement() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &1000);

        let stealth_pk = BytesN::from_array(&env, &[1u8; 32]);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);

        client.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);

        // Balance stored
        assert_eq!(client.get_balance(&stealth_pk, &token_id), 100);

        // Announcement created
        assert_eq!(client.get_announcement_count(), 1);
        let anns = client.get_announcements(&0, &10);
        assert_eq!(anns.len(), 1);
        let ann = anns.get(0).unwrap();
        assert_eq!(ann.ephemeral_pk, ephemeral_pk);
        assert_eq!(ann.view_tag, 42);
        assert_eq!(ann.stealth_pk, stealth_pk);
        assert_eq!(ann.token, token_id);
        assert_eq!(ann.amount, 100);
    }

    #[test]
    fn test_deposit_increments_balance() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &1000);

        let stealth_pk = BytesN::from_array(&env, &[1u8; 32]);
        let eph1 = BytesN::from_array(&env, &[2u8; 32]);
        let eph2 = BytesN::from_array(&env, &[3u8; 32]);

        client.deposit(&sender, &token_id, &100, &stealth_pk, &eph1, &10);
        client.deposit(&sender, &token_id, &200, &stealth_pk, &eph2, &20);

        assert_eq!(client.get_balance(&stealth_pk, &token_id), 300);
        assert_eq!(client.get_announcement_count(), 2);
    }

    #[test]
    fn test_multi_token_deposits() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_a, _admin_a, sac_a) = setup_token(&env);
        let (token_b, _admin_b, sac_b) = setup_token(&env);
        let sender = Address::generate(&env);
        sac_a.mint(&sender, &1000);
        sac_b.mint(&sender, &2000);

        let stealth_pk = BytesN::from_array(&env, &[1u8; 32]);
        let eph1 = BytesN::from_array(&env, &[2u8; 32]);
        let eph2 = BytesN::from_array(&env, &[3u8; 32]);

        client.deposit(&sender, &token_a, &100, &stealth_pk, &eph1, &10);
        client.deposit(&sender, &token_b, &500, &stealth_pk, &eph2, &20);

        assert_eq!(client.get_balance(&stealth_pk, &token_a), 100);
        assert_eq!(client.get_balance(&stealth_pk, &token_b), 500);
    }

    #[test]
    fn test_withdraw_valid_signature() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let destination = Address::generate(&env);
        sac.mint(&sender, &1000);

        // Generate a real ed25519 keypair for the stealth key
        let signing_key = SigningKey::from_bytes(&[42u8; 32]);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let stealth_pk = BytesN::from_array(&env, &pub_bytes);

        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);

        // Deposit
        client.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);
        assert_eq!(client.get_balance(&stealth_pk, &token_id), 100);

        // Build withdraw message (must match contract's build_withdraw_message)
        let nonce: u64 = 1;
        let amount: i128 = 50;

        let message = StealthPoolContract::build_withdraw_message(
            &env,
            &stealth_pk,
            &token_id,
            amount,
            &destination,
            nonce,
        );

        // Extract raw bytes and sign with ed25519_dalek
        let mut msg_raw = [0u8; 32];
        message.copy_into_slice(&mut msg_raw);
        let sig = signing_key.sign(&msg_raw);
        let signature = BytesN::from_array(&env, &sig.to_bytes());

        // Withdraw
        client.withdraw(&stealth_pk, &token_id, &amount, &destination, &nonce, &signature);

        // Balance decremented
        assert_eq!(client.get_balance(&stealth_pk, &token_id), 50);

        // Nonce updated
        assert_eq!(client.get_nonce(&stealth_pk), 1);

        // Destination received tokens
        let token_client = token::Client::new(&env, &token_id);
        assert_eq!(token_client.balance(&destination), 50);
    }

    #[test]
    #[should_panic]
    fn test_withdraw_invalid_signature() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let destination = Address::generate(&env);
        sac.mint(&sender, &1000);

        let stealth_pk = BytesN::from_array(&env, &[1u8; 32]);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);

        client.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);

        // Bad signature
        let bad_sig = BytesN::from_array(&env, &[0u8; 64]);
        client.withdraw(&stealth_pk, &token_id, &50, &destination, &1, &bad_sig);
    }

    #[test]
    #[should_panic(expected = "nonce too low")]
    fn test_withdraw_replay_protection() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let destination = Address::generate(&env);
        sac.mint(&sender, &1000);

        let signing_key = SigningKey::from_bytes(&[43u8; 32]);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let stealth_pk = BytesN::from_array(&env, &pub_bytes);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);

        client.deposit(&sender, &token_id, &200, &stealth_pk, &ephemeral_pk, &42);

        // First withdraw with nonce 1
        let msg1 = StealthPoolContract::build_withdraw_message(
            &env, &stealth_pk, &token_id, 50, &destination, 1,
        );
        let mut msg1_raw = [0u8; 32];
        msg1.copy_into_slice(&mut msg1_raw);
        let sig1 = signing_key.sign(&msg1_raw);
        let sig1_bytes = BytesN::from_array(&env, &sig1.to_bytes());
        client.withdraw(&stealth_pk, &token_id, &50, &destination, &1, &sig1_bytes);

        // Replay with same nonce — should panic
        client.withdraw(&stealth_pk, &token_id, &50, &destination, &1, &sig1_bytes);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn test_withdraw_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let destination = Address::generate(&env);
        sac.mint(&sender, &1000);

        let signing_key = SigningKey::from_bytes(&[44u8; 32]);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let stealth_pk = BytesN::from_array(&env, &pub_bytes);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);

        client.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);

        // Withdraw more than balance
        let msg = StealthPoolContract::build_withdraw_message(
            &env, &stealth_pk, &token_id, 200, &destination, 1,
        );
        let mut msg_raw = [0u8; 32];
        msg.copy_into_slice(&mut msg_raw);
        let sig = signing_key.sign(&msg_raw);
        let sig_bytes = BytesN::from_array(&env, &sig.to_bytes());
        client.withdraw(&stealth_pk, &token_id, &200, &destination, &1, &sig_bytes);
    }

    #[test]
    fn test_withdraw_clears_zero_balance() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let destination = Address::generate(&env);
        sac.mint(&sender, &1000);

        let signing_key = SigningKey::from_bytes(&[45u8; 32]);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let stealth_pk = BytesN::from_array(&env, &pub_bytes);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);

        client.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);

        // Withdraw full amount
        let msg = StealthPoolContract::build_withdraw_message(
            &env, &stealth_pk, &token_id, 100, &destination, 1,
        );
        let mut msg_raw = [0u8; 32];
        msg.copy_into_slice(&mut msg_raw);
        let sig = signing_key.sign(&msg_raw);
        let sig_bytes = BytesN::from_array(&env, &sig.to_bytes());
        client.withdraw(&stealth_pk, &token_id, &100, &destination, &1, &sig_bytes);

        assert_eq!(client.get_balance(&stealth_pk, &token_id), 0);
    }

    #[test]
    fn test_pagination() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &10000);

        // Create 5 deposits
        for i in 0u8..5 {
            let stealth_pk = BytesN::from_array(&env, &[i + 1; 32]);
            let eph = BytesN::from_array(&env, &[i + 10; 32]);
            client.deposit(&sender, &token_id, &100, &stealth_pk, &eph, &(i as u32));
        }

        assert_eq!(client.get_announcement_count(), 5);

        let page1 = client.get_announcements(&0, &2);
        assert_eq!(page1.len(), 2);

        let page2 = client.get_announcements(&2, &2);
        assert_eq!(page2.len(), 2);

        let page3 = client.get_announcements(&4, &2);
        assert_eq!(page3.len(), 1);

        let empty = client.get_announcements(&10, &2);
        assert_eq!(empty.len(), 0);
    }

    #[test]
    fn test_get_announcements_by_tag() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &100000);

        for i in 0u8..10 {
            let stealth_pk = BytesN::from_array(&env, &[i + 1; 32]);
            let eph = BytesN::from_array(&env, &[i + 50; 32]);
            let tag = (i % 3) as u32;
            client.deposit(&sender, &token_id, &100, &stealth_pk, &eph, &tag);
        }

        let tag0 = client.get_announcements_by_tag(&0);
        assert_eq!(tag0.len(), 4); // 0, 3, 6, 9

        let tag1 = client.get_announcements_by_tag(&1);
        assert_eq!(tag1.len(), 3); // 1, 4, 7

        let tag2 = client.get_announcements_by_tag(&2);
        assert_eq!(tag2.len(), 3); // 2, 5, 8

        let tag99 = client.get_announcements_by_tag(&99);
        assert_eq!(tag99.len(), 0);
    }
}
