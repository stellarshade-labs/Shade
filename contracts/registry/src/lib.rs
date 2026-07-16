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
    /// A single announcement stored at its own index (O(1) append, no history rewrite)
    Announcement(u64),
    /// Counter for total announcements
    AnnouncementCount,
}

/// TTL constants for persistent storage.
///
/// `TTL_EXTEND_TO` is deliberately large (~1 year) to support a cold-savings
/// custody pattern: a recipient may receive a deposit and stay idle for a long
/// time. Combined with read-path TTL extension in `get_balance`/`get_nonce`
/// (each read bumps the entry back up to this floor), a passively-scanning
/// recipient keeps their Balance and Nonce entries live and never archives.
const TTL_THRESHOLD: u32 = 518_400; // ~30 days
const TTL_EXTEND_TO: u32 = 6_312_000; // ~365 days

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

        // Keep the contract instance callable even after long idle periods.
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        // Transfer tokens from sender to contract
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        // Update balance.
        // Explicit checked add: fail loudly on i128 overflow in the code itself
        // rather than relying on the `overflow-checks = true` release profile
        // (hardens against build-profile drift; unreachable for real token supplies).
        let bal_key = DataKey::Balance(stealth_pk.clone(), token_addr.clone());
        let current: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let new_balance = current.checked_add(amount).expect("balance overflow");
        env.storage().persistent().set(&bal_key, &new_balance);
        env.storage().persistent().extend_ttl(&bal_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Append announcement as its OWN keyed entry at index == current count.
        // This is O(1): we never read or rewrite prior history, so deposit cost
        // does not scale with the number of past announcements.
        let count: u64 = env.storage().persistent().get(&DataKey::AnnouncementCount).unwrap_or(0);
        let entry = AnnouncementEntry {
            ephemeral_pk: ephemeral_pk.clone(),
            view_tag,
            stealth_pk: stealth_pk.clone(),
            token: token_addr.clone(),
            amount,
            sequence: env.ledger().sequence(),
        };
        let ann_key = DataKey::Announcement(count);
        env.storage().persistent().set(&ann_key, &entry);
        env.storage().persistent().extend_ttl(&ann_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Increment counter
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
    /// Message format:
    ///   SHA256(stealth_pk || token || amount || destination || nonce
    ///          || contract_address || network_id)
    /// This binds the signature to a specific contract deployment and network,
    /// preventing cross-deployment / cross-network replay.
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

        // Keep the contract instance callable even after long idle periods.
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

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

        // Check balance
        let bal_key = DataKey::Balance(stealth_pk.clone(), token_addr.clone());
        let current: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        assert!(current >= amount, "insufficient balance");

        // Checks-effects-interactions: commit ALL state changes (nonce + balance)
        // BEFORE the external token transfer, so a malicious token contract cannot
        // reenter and replay this withdrawal.
        env.storage().persistent().set(&nonce_key, &nonce);
        env.storage().persistent().extend_ttl(&nonce_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        let new_balance = current - amount;
        if new_balance > 0 {
            env.storage().persistent().set(&bal_key, &new_balance);
            env.storage().persistent().extend_ttl(&bal_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        } else {
            env.storage().persistent().remove(&bal_key);
        }

        // Interaction: transfer tokens from contract to destination LAST.
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        // Emit event
        env.events().publish(
            (symbol_short!("withdraw"), destination),
            (stealth_pk, token_addr, amount),
        );
    }

    /// Build the message bytes for withdraw signature verification.
    ///
    /// Format (fixed-width fields concatenated, then SHA-256):
    ///   stealth_pk[32] || token_strkey_ascii[56] || amount_be_i128[16]
    ///   || dest_strkey_ascii[56] || nonce_be_u64[8]
    ///   || contract_strkey_ascii[56] || network_id[32]
    ///
    /// The trailing contract address and network id provide domain separation so a
    /// signature cannot be replayed on a different deployment or network.
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

        // Domain separation: this contract's address as StrKey bytes (56 chars)
        let contract_str = env.current_contract_address().to_string();
        let mut contract_buf = [0u8; 56];
        contract_str.copy_into_slice(&mut contract_buf);
        msg.append(&Bytes::from_slice(env, &contract_buf));

        // Domain separation: 32-byte network id (SHA-256 of the network passphrase)
        msg.append(&Bytes::from_slice(env, &env.ledger().network_id().to_array()));

        env.crypto().sha256(&msg).into()
    }

    /// Get balance for a stealth key + token pair.
    ///
    /// Reading a live Balance entry EXTENDS its persistent-entry TTL back up to
    /// `TTL_EXTEND_TO`. Because a passive recipient polls `get_balance` while
    /// scanning, this read path keeps their funds from ever archiving, so a
    /// later `withdraw` never fails on an archived entry. If an entry has already
    /// lapsed to the archived state (e.g. it was never read within the TTL
    /// window), a client-side `RestoreFootprint` operation restores it before the
    /// next read/write — the SDK performs this automatically.
    pub fn get_balance(env: Env, stealth_pk: BytesN<32>, token_addr: Address) -> i128 {
        let bal_key = DataKey::Balance(stealth_pk, token_addr);
        let balance = env.storage().persistent().get(&bal_key).unwrap_or(0);
        // Extend TTL only for entries that actually exist; unwrap_or(0) above
        // returns 0 for a missing entry, and extending a nonexistent key is a
        // no-op we skip to avoid needless host calls.
        if env.storage().persistent().has(&bal_key) {
            env.storage()
                .persistent()
                .extend_ttl(&bal_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        balance
    }

    /// Get the current nonce for a stealth key (for constructing withdraw messages).
    ///
    /// Like `get_balance`, reading a live Nonce entry EXTENDS its TTL back up to
    /// `TTL_EXTEND_TO`. Scan/withdraw preparation reads the nonce, so this keeps
    /// the replay-protection entry live for a passive recipient and prevents it
    /// from archiving out from under a later `withdraw`.
    pub fn get_nonce(env: Env, stealth_pk: BytesN<32>) -> u64 {
        let nonce_key = DataKey::Nonce(stealth_pk);
        let nonce = env.storage().persistent().get(&nonce_key).unwrap_or(0);
        if env.storage().persistent().has(&nonce_key) {
            env.storage()
                .persistent()
                .extend_ttl(&nonce_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        nonce
    }

    /// Get announcements with pagination.
    ///
    /// Reads each announcement from its own keyed persistent entry, so it only
    /// deserializes the requested `start..min(start+limit, count)` window rather
    /// than the entire history.
    pub fn get_announcements(env: Env, start: u64, limit: u64) -> Vec<AnnouncementEntry> {
        let total: u64 = env.storage().persistent().get(&DataKey::AnnouncementCount).unwrap_or(0);
        if start >= total {
            return vec![&env];
        }

        // saturating_add avoids u64 overflow (e.g. limit == u64::MAX).
        let end = core::cmp::min(start.saturating_add(limit), total);
        let mut result = vec![&env];
        for i in start..end {
            if let Some(entry) = env
                .storage()
                .persistent()
                .get(&DataKey::Announcement(i))
            {
                result.push_back(entry);
            }
        }
        result
    }

    /// Get announcements filtered by view tag, with pagination.
    ///
    /// Like `get_announcements`, this reads only the keyed entries in the
    /// `start..min(start.saturating_add(limit), count)` index window — bounded
    /// storage reads per call, so it stays within the Soroban resource budget
    /// no matter how large the pool grows — and returns the entries in that
    /// window whose `view_tag` matches. Callers page through history
    /// window-by-window. (The SDK normally filters by view tag client-side
    /// after paging through `get_announcements`; this helper mirrors that
    /// pattern on-chain.)
    pub fn get_announcements_by_tag(
        env: Env,
        view_tag: u32,
        start: u64,
        limit: u64,
    ) -> Vec<AnnouncementEntry> {
        let total: u64 = env.storage().persistent().get(&DataKey::AnnouncementCount).unwrap_or(0);
        if start >= total {
            return vec![&env];
        }

        // saturating_add avoids u64 overflow (e.g. limit == u64::MAX).
        let end = core::cmp::min(start.saturating_add(limit), total);
        let mut result = vec![&env];
        for i in start..end {
            if let Some(entry) = env
                .storage()
                .persistent()
                .get::<DataKey, AnnouncementEntry>(&DataKey::Announcement(i))
            {
                if entry.view_tag == view_tag {
                    result.push_back(entry);
                }
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
    use soroban_sdk::{
        testutils::{storage::Persistent as _, Address as _, Ledger as _},
        Address, Env,
    };

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

        let message = env.as_contract(&contract_id, || {
            StealthPoolContract::build_withdraw_message(
                &env,
                &stealth_pk,
                &token_id,
                amount,
                &destination,
                nonce,
            )
        });

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
        let msg1 = env.as_contract(&contract_id, || {
            StealthPoolContract::build_withdraw_message(
                &env, &stealth_pk, &token_id, 50, &destination, 1,
            )
        });
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
        let msg = env.as_contract(&contract_id, || {
            StealthPoolContract::build_withdraw_message(
                &env, &stealth_pk, &token_id, 200, &destination, 1,
            )
        });
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
        let msg = env.as_contract(&contract_id, || {
            StealthPoolContract::build_withdraw_message(
                &env, &stealth_pk, &token_id, 100, &destination, 1,
            )
        });
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
    fn test_get_announcements_paging_edges() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &100000);

        // Seed 7 announcements with distinct ephemeral keys so windows can be
        // compared for stability and non-overlap.
        let count: u8 = 7;
        for i in 0u8..count {
            let stealth_pk = BytesN::from_array(&env, &[i + 1; 32]);
            let eph = BytesN::from_array(&env, &[i + 100; 32]);
            client.deposit(&sender, &token_id, &100, &stealth_pk, &eph, &(i as u32));
        }
        assert_eq!(client.get_announcement_count(), count as u64);

        // start exactly at count -> empty
        assert_eq!(client.get_announcements(&(count as u64), &10).len(), 0);
        // start beyond count -> empty
        assert_eq!(client.get_announcements(&50, &10).len(), 0);
        // zero limit -> empty even for a valid start
        assert_eq!(client.get_announcements(&0, &0).len(), 0);

        // Consecutive windows of size 3: [0,3), [3,6), [6,9)
        let w0 = client.get_announcements(&0, &3);
        let w1 = client.get_announcements(&3, &3);
        let w2 = client.get_announcements(&6, &3);
        assert_eq!(w0.len(), 3);
        assert_eq!(w1.len(), 3);
        assert_eq!(w2.len(), 1); // only index 6 remains

        // Windows are non-overlapping: their ephemeral keys are all distinct and
        // together cover exactly the full set once.
        let mut seen: Vec<BytesN<32>> = vec![&env];
        for w in [&w0, &w1, &w2] {
            for entry in w.iter() {
                assert!(!seen.contains(&entry.ephemeral_pk), "windows overlapped");
                seen.push_back(entry.ephemeral_pk.clone());
            }
        }
        assert_eq!(seen.len(), count as u32);

        // Windows are stable: re-fetching the same window yields the same slice.
        let w1_again = client.get_announcements(&3, &3);
        assert_eq!(w1, w1_again);

        // A window straddling the end returns only the in-range remainder.
        let tail = client.get_announcements(&5, &10);
        assert_eq!(tail.len(), 2); // indices 5 and 6

        // A full-span window equals the concatenation start..count.
        let full = client.get_announcements(&0, &(count as u64));
        assert_eq!(full.len(), count as u32);
        assert_eq!(full.get(0).unwrap().ephemeral_pk, w0.get(0).unwrap().ephemeral_pk);
        assert_eq!(full.get(6).unwrap().ephemeral_pk, w2.get(0).unwrap().ephemeral_pk);
    }

    #[test]
    fn test_get_announcements_empty_pool() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        // No deposits yet: any window (including start 0) is empty.
        assert_eq!(client.get_announcement_count(), 0);
        assert_eq!(client.get_announcements(&0, &10).len(), 0);
        assert_eq!(client.get_announcements(&5, &10).len(), 0);
    }

    #[test]
    fn test_get_announcements_by_tag_pagination() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &100000);

        // 10 mixed-tag announcements: tag = i % 3.
        // tag 0 -> indices 0, 3, 6, 9; tag 1 -> 1, 4, 7; tag 2 -> 2, 5, 8.
        for i in 0u8..10 {
            let stealth_pk = BytesN::from_array(&env, &[i + 1; 32]);
            let eph = BytesN::from_array(&env, &[i + 50; 32]);
            let tag = (i % 3) as u32;
            client.deposit(&sender, &token_id, &100, &stealth_pk, &eph, &tag);
        }
        assert_eq!(client.get_announcement_count(), 10);

        // Full-span windows preserve the old full-scan behavior.
        assert_eq!(client.get_announcements_by_tag(&0, &0, &100).len(), 4);
        assert_eq!(client.get_announcements_by_tag(&1, &0, &100).len(), 3);
        assert_eq!(client.get_announcements_by_tag(&2, &0, &100).len(), 3);
        assert_eq!(client.get_announcements_by_tag(&99, &0, &100).len(), 0);

        // start/limit window [0, 5): tag-0 matches at indices 0 and 3.
        let w0 = client.get_announcements_by_tag(&0, &0, &5);
        assert_eq!(w0.len(), 2);
        assert_eq!(w0.get(0).unwrap().ephemeral_pk.get(0).unwrap(), 50u8); // index 0
        assert_eq!(w0.get(1).unwrap().ephemeral_pk.get(0).unwrap(), 53u8); // index 3

        // Next window [5, 10): tag-0 matches at indices 6 and 9.
        let w1 = client.get_announcements_by_tag(&0, &5, &5);
        assert_eq!(w1.len(), 2);
        assert_eq!(w1.get(0).unwrap().ephemeral_pk.get(0).unwrap(), 56u8); // index 6
        assert_eq!(w1.get(1).unwrap().ephemeral_pk.get(0).unwrap(), 59u8); // index 9

        // Consecutive windows tile the full span: no gaps, no overlap.
        let full = client.get_announcements_by_tag(&0, &0, &10);
        assert_eq!(full.len(), w0.len() + w1.len());
        assert_eq!(full.get(0).unwrap(), w0.get(0).unwrap());
        assert_eq!(full.get(1).unwrap(), w0.get(1).unwrap());
        assert_eq!(full.get(2).unwrap(), w1.get(0).unwrap());
        assert_eq!(full.get(3).unwrap(), w1.get(1).unwrap());

        // Edge windows behave exactly like get_announcements: start at/past
        // the end and zero limit are empty, never a panic.
        assert_eq!(client.get_announcements_by_tag(&0, &10, &5).len(), 0);
        assert_eq!(client.get_announcements_by_tag(&0, &100, &5).len(), 0);
        assert_eq!(client.get_announcements_by_tag(&0, &0, &0).len(), 0);

        // --- Large-N no-panic case ---
        // Bulk-seed keyed entries directly (bypassing deposit) so the read
        // path is exercised against a big pool without 1000 token transfers.
        // Bulk tags live in 200..205 so they never collide with tags 0..3.
        // The old unbounded 1-arg form scanned every index 0..total on each
        // call, which exceeds the per-invocation resource budget at this size
        // (a full-history single call still does, by design); bounded windows
        // must stay affordable no matter how large the pool grows.
        let n: u64 = 1000;
        let mut expected_202: u32 = 0;
        // Seeding 990 entries in one host context is test setup, not the
        // behavior under test — run it unmetered, then restore the default
        // budget so the windowed reads below are asserted under realistic
        // resource limits.
        env.cost_estimate().budget().reset_unlimited();
        env.as_contract(&contract_id, || {
            for i in 10..n {
                let tag = 200 + (i % 5) as u32;
                if tag == 202 {
                    expected_202 += 1;
                }
                let entry = AnnouncementEntry {
                    ephemeral_pk: BytesN::from_array(&env, &[(i % 251) as u8; 32]),
                    view_tag: tag,
                    stealth_pk: BytesN::from_array(&env, &[9u8; 32]),
                    token: token_id.clone(),
                    amount: 1,
                    sequence: 0,
                };
                env.storage().persistent().set(&DataKey::Announcement(i), &entry);
            }
            env.storage().persistent().set(&DataKey::AnnouncementCount, &n);
        });
        env.cost_estimate().budget().reset_default();
        assert_eq!(client.get_announcement_count(), n);

        // Page through the entire large pool in bounded windows of 50: every
        // window fits the default per-call budget (no panic), and the pages
        // together find exactly every matching entry.
        let page: u64 = 50;
        let mut found_202: u32 = 0;
        let mut cursor: u64 = 0;
        while cursor < n {
            found_202 += client.get_announcements_by_tag(&202, &cursor, &page).len();
            cursor += page;
        }
        assert_eq!(found_202, expected_202);

        // Deep bounded window near the end with start + limit far beyond
        // u64::MAX: saturating_add clamps to total instead of panicking.
        // [980, 1000) holds i % 5 == 2 at 982, 987, 992, 997.
        let deep = client.get_announcements_by_tag(&202, &(n - 20), &u64::MAX);
        assert_eq!(deep.len(), 4);

        // The original small-set query still works as a bounded window over
        // the first 10 indices, unaffected by the 990 later entries.
        assert_eq!(client.get_announcements_by_tag(&0, &0, &10).len(), 4);
    }

    #[test]
    fn test_keyed_storage_deposit_does_not_scale_with_history() {
        // With keyed announcement entries, deposit is O(1): it never reads or
        // rewrites prior history. Many deposits still succeed and windows read
        // back correctly regardless of how much history precedes them.
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &1_000_000);

        let n: u64 = 300;
        for i in 0..n {
            let stealth_pk = BytesN::from_array(&env, &[(i % 251) as u8 + 1; 32]);
            let mut eph = [0u8; 32];
            eph[0] = (i & 0xff) as u8;
            eph[1] = ((i >> 8) & 0xff) as u8;
            let eph_pk = BytesN::from_array(&env, &eph);
            client.deposit(&sender, &token_id, &10, &stealth_pk, &eph_pk, &((i % 256) as u32));
        }

        assert_eq!(client.get_announcement_count(), n);

        // A window deep into history reads back exactly and independently.
        let window = client.get_announcements(&250, &10);
        assert_eq!(window.len(), 10);
        let first = window.get(0).unwrap();
        assert_eq!(first.ephemeral_pk.get(0).unwrap(), 250u8); // 250 & 0xff
        assert_eq!(first.ephemeral_pk.get(1).unwrap(), 0u8); // (250 >> 8) == 0

        // A window straddling the 256 boundary also reads back correctly.
        let cross = client.get_announcements(&255, &2);
        assert_eq!(cross.len(), 2);
        assert_eq!(cross.get(0).unwrap().ephemeral_pk.get(0).unwrap(), 255u8);
        assert_eq!(cross.get(0).unwrap().ephemeral_pk.get(1).unwrap(), 0u8);
        assert_eq!(cross.get(1).unwrap().ephemeral_pk.get(0).unwrap(), 0u8); // 256 & 0xff
        assert_eq!(cross.get(1).unwrap().ephemeral_pk.get(1).unwrap(), 1u8); // 256 >> 8

        // The very last announcement is present at index n-1.
        let tail = client.get_announcements(&(n - 1), &10);
        assert_eq!(tail.len(), 1);
    }

    #[test]
    fn test_get_announcements_limit_overflow_no_panic() {
        // start + limit would overflow u64; saturating_add must clamp instead of panic.
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &10000);

        for i in 0u8..3 {
            let stealth_pk = BytesN::from_array(&env, &[i + 1; 32]);
            let eph = BytesN::from_array(&env, &[i + 20; 32]);
            client.deposit(&sender, &token_id, &100, &stealth_pk, &eph, &(i as u32));
        }

        // start=1, limit=u64::MAX -> tail window [1, 3) without overflow panic.
        let tail = client.get_announcements(&1, &u64::MAX);
        assert_eq!(tail.len(), 2);
    }

    #[test]
    fn test_get_balance_read_extends_ttl() {
        // A passive recipient who only reads (never writes) must keep their
        // Balance/Nonce persistent entries live. Reading via get_balance and
        // get_nonce must EXTEND the entry TTL (live-until ledger increases),
        // so the entry never archives before a later withdraw.
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        sac.mint(&sender, &1000);

        let stealth_pk = BytesN::from_array(&env, &[7u8; 32]);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);
        client.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);

        let bal_key = DataKey::Balance(stealth_pk.clone(), token_id.clone());

        // Advance the ledger far enough that the deposit's remaining TTL drops
        // below TTL_THRESHOLD, so the read-path extend_ttl actually fires.
        // get_ttl returns the *remaining* ledgers before archival, which shrinks
        // as ledgers pass; extend_ttl only bumps entries whose remaining TTL has
        // fallen below the threshold.
        env.ledger().with_mut(|li| {
            li.sequence_number += TTL_EXTEND_TO - TTL_THRESHOLD + 100;
        });

        // Remaining TTL just before the read (decayed below the threshold).
        let ttl_before_read = env.as_contract(&contract_id, || {
            env.storage().persistent().get_ttl(&bal_key)
        });
        assert!(
            ttl_before_read < TTL_THRESHOLD,
            "precondition: TTL must have decayed below threshold, got {}",
            ttl_before_read
        );

        // Reading the balance must extend (restore) the remaining TTL.
        assert_eq!(client.get_balance(&stealth_pk, &token_id), 100);
        let ttl_after_read = env.as_contract(&contract_id, || {
            env.storage().persistent().get_ttl(&bal_key)
        });
        assert!(
            ttl_after_read > ttl_before_read,
            "get_balance must extend Balance TTL: {} !> {}",
            ttl_after_read,
            ttl_before_read
        );
    }

    #[test]
    fn test_get_nonce_read_extends_ttl() {
        // get_nonce on an existing Nonce entry must extend its TTL so the
        // replay-protection entry stays live for a passive recipient.
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let destination = Address::generate(&env);
        sac.mint(&sender, &1000);

        // Establish a real Nonce entry via a valid withdraw.
        let signing_key = SigningKey::from_bytes(&[71u8; 32]);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let stealth_pk = BytesN::from_array(&env, &pub_bytes);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);
        client.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);

        let message = env.as_contract(&contract_id, || {
            StealthPoolContract::build_withdraw_message(
                &env, &stealth_pk, &token_id, 50, &destination, 1,
            )
        });
        let mut msg_raw = [0u8; 32];
        message.copy_into_slice(&mut msg_raw);
        let sig = signing_key.sign(&msg_raw);
        let signature = BytesN::from_array(&env, &sig.to_bytes());
        client.withdraw(&stealth_pk, &token_id, &50, &destination, &1, &signature);

        let nonce_key = DataKey::Nonce(stealth_pk.clone());

        // Advance the ledger far enough that the withdraw's remaining TTL drops
        // below TTL_THRESHOLD, so the read-path extend_ttl actually fires.
        env.ledger().with_mut(|li| {
            li.sequence_number += TTL_EXTEND_TO - TTL_THRESHOLD + 100;
        });

        let ttl_before_read = env.as_contract(&contract_id, || {
            env.storage().persistent().get_ttl(&nonce_key)
        });
        assert!(
            ttl_before_read < TTL_THRESHOLD,
            "precondition: TTL must have decayed below threshold, got {}",
            ttl_before_read
        );

        assert_eq!(client.get_nonce(&stealth_pk), 1);
        let ttl_after_read = env.as_contract(&contract_id, || {
            env.storage().persistent().get_ttl(&nonce_key)
        });
        assert!(
            ttl_after_read > ttl_before_read,
            "get_nonce must extend Nonce TTL: {} !> {}",
            ttl_after_read,
            ttl_before_read
        );
    }

    #[test]
    fn test_deposit_withdraw_still_pass_after_read_ttl_change() {
        // Sanity: read-path TTL extension must not break the deposit/withdraw
        // flow. A full deposit -> get_balance -> get_nonce -> withdraw succeeds.
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StealthPoolContract, ());
        let client = StealthPoolContractClient::new(&env, &contract_id);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let destination = Address::generate(&env);
        sac.mint(&sender, &1000);

        let signing_key = SigningKey::from_bytes(&[72u8; 32]);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let stealth_pk = BytesN::from_array(&env, &pub_bytes);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);

        client.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);

        // Reads happen during scan/withdraw preparation.
        assert_eq!(client.get_balance(&stealth_pk, &token_id), 100);
        let nonce = client.get_nonce(&stealth_pk);
        assert_eq!(nonce, 0);

        let message = env.as_contract(&contract_id, || {
            StealthPoolContract::build_withdraw_message(
                &env, &stealth_pk, &token_id, 100, &destination, nonce + 1,
            )
        });
        let mut msg_raw = [0u8; 32];
        message.copy_into_slice(&mut msg_raw);
        let sig = signing_key.sign(&msg_raw);
        let signature = BytesN::from_array(&env, &sig.to_bytes());
        client.withdraw(&stealth_pk, &token_id, &100, &destination, &(nonce + 1), &signature);

        assert_eq!(client.get_balance(&stealth_pk, &token_id), 0);
        assert_eq!(client.get_nonce(&stealth_pk), 1);
        let token_client = token::Client::new(&env, &token_id);
        assert_eq!(token_client.balance(&destination), 100);
    }

    #[test]
    fn test_withdraw_message_binds_contract_and_network() {
        // A signature built for one contract deployment must NOT verify on another,
        // even with identical token/amount/destination/nonce.
        let env = Env::default();
        env.mock_all_auths();

        let contract_a = env.register(StealthPoolContract, ());
        let contract_b = env.register(StealthPoolContract, ());
        let client_a = StealthPoolContractClient::new(&env, &contract_a);
        let client_b = StealthPoolContractClient::new(&env, &contract_b);

        let (token_id, _admin, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let destination = Address::generate(&env);
        sac.mint(&sender, &1000);

        let signing_key = SigningKey::from_bytes(&[46u8; 32]);
        let pub_bytes = signing_key.verifying_key().to_bytes();
        let stealth_pk = BytesN::from_array(&env, &pub_bytes);
        let ephemeral_pk = BytesN::from_array(&env, &[2u8; 32]);

        client_a.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);
        client_b.deposit(&sender, &token_id, &100, &stealth_pk, &ephemeral_pk, &42);

        // Sign a message bound to contract A.
        let msg_a = env.as_contract(&contract_a, || {
            StealthPoolContract::build_withdraw_message(
                &env, &stealth_pk, &token_id, 50, &destination, 1,
            )
        });
        let mut raw_a = [0u8; 32];
        msg_a.copy_into_slice(&mut raw_a);
        let sig_a = signing_key.sign(&raw_a);
        let sig_a_bytes = BytesN::from_array(&env, &sig_a.to_bytes());

        // Valid on A.
        client_a.withdraw(&stealth_pk, &token_id, &50, &destination, &1, &sig_a_bytes);
        assert_eq!(client_a.get_balance(&stealth_pk, &token_id), 50);

        // Same signature must be rejected on B (different contract address).
        let res = client_b.try_withdraw(&stealth_pk, &token_id, &50, &destination, &1, &sig_a_bytes);
        assert!(res.is_err(), "signature must not replay across deployments");
    }
}
