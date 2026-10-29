//! # claim-registry (v0.10)
//!
//! Write-once Merkle roots for batches of delivery claims, with the ledger time at which each
//! root was anchored, plus permanent revocation of a batch by a separate revoker key.
//!
//! * `anchor(batch_id, root)`: issuer only; a batch id can be anchored once (`RootExists`).
//! * `anchored_at(batch_id)`: the anchor ledger timestamp; `Revoked` for a revoked batch.
//! * `verify(batch_id, leaf, proof, index)`: Merkle inclusion proof against the anchored root.
//!   Internal nodes are `sha256(0x02 || left || right)`; the side at each level is taken from the
//!   bits of `index` (LSB first), and every bit of `index` must be consumed by the proof.
//!   A revoked or unknown batch verifies `false`. Proofs longer than 32 levels are refused.
//! * `revoke(batch_id)`: revoker only; a revoked batch never verifies again.
//!
//! The leaf format for delivery claims (tag 0x01) is specified in `docs/leaf-format.md` and
//! computed on chain by `motored_escrow_guard::leaf`.
//!
//! **TTL upkeep (v0.10).** `anchor` extends the new root; `revoke` extends the revocation entry;
//! `verify` and `anchored_at` extend the revocation entry or the root they read; every call extends
//! the instance and code. The values ([`TTL_THRESHOLD`] / [`TTL_EXTEND_TO`], 120 / 150 days) sit at
//! or above mainnet's `min_persistent_ttl`. v0.8 used 1 / 2 days, below every network's minimum, so
//! its extensions were no-ops. An extension made on a path that then fails (for example
//! `anchored_at` on a revoked batch, or a guard authorization refused after `verify`) is rolled back
//! with it, so the off-chain keeper still lists revocation keys. An archived entry fails closed (no
//! verification, no anchor time).
//!
//! The issuer and revoker are fixed at construction. They are meant to be multisig G-accounts that
//! rotate their signers at the account level; a compromised account is handled by a new registry
//! (and a new guard pointing at it) for new escrows.
//!
//! **Status: unaudited. Testnet only.**
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    Env, Vec,
};

/// Domain tag for internal Merkle nodes (leaves use their own tag, 0x01 for delivery claims).
const TAG_NODE: u8 = 0x02;
/// Maximum proof length: 2^32 leaves per batch.
const MAX_DEPTH: u32 = 32;
/// Ledgers per day at the ~5 s target ledger close time.
pub const LEDGERS_PER_DAY: u32 = 17_280;
/// TTL upkeep threshold: an entry with 120 days (mainnet `min_persistent_ttl`) or less left is
/// extended, so a fresh entry is extended at its first touch on every network.
pub const TTL_THRESHOLD: u32 = 120 * LEDGERS_PER_DAY;
/// TTL upkeep target: 150 days from the current ledger (under every network's maximum entry TTL).
/// The off-chain keeper still extends roots and revocations that nobody reads for that long.
pub const TTL_EXTEND_TO: u32 = 150 * LEDGERS_PER_DAY;

#[contracttype]
enum Key {
    Issuer,
    Revoker,
    Root(u64),
    Revoked(u64),
}

/// An anchored root and the ledger timestamp at which it was anchored.
#[contracttype]
#[derive(Clone)]
pub struct RootRec {
    pub root: BytesN<32>,
    pub at: u64,
}

/// Registry errors. Codes are stable and part of the public interface.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 2,
    RootExists = 3,
    ProofTooLong = 4,
    NoRoot = 5,
    Revoked = 6,
}

#[contractevent]
pub struct BatchRevoked {
    pub batch_id: u64,
}

#[contract]
pub struct ClaimRegistry;

/// Extends the registry's instance and code TTL (no-op while above the threshold).
fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Extends one persistent entry's TTL if it exists (no-op while above the threshold). Returns
/// whether it exists.
fn bump_if_present(env: &Env, k: &Key) -> bool {
    let p = env.storage().persistent();
    if p.has(k) {
        p.extend_ttl(k, TTL_THRESHOLD, TTL_EXTEND_TO);
        true
    } else {
        false
    }
}

#[contractimpl]
impl ClaimRegistry {
    /// `issuer` anchors roots (the platform's online batching key); `revoker` is a separate,
    /// offline key that can only revoke.
    pub fn __constructor(env: Env, issuer: Address, revoker: Address) {
        env.storage().instance().set(&Key::Issuer, &issuer);
        env.storage().instance().set(&Key::Revoker, &revoker);
        bump_instance(&env);
    }

    /// Anchors `root` for `batch_id`, once. Records the current ledger timestamp.
    pub fn anchor(env: Env, batch_id: u64, root: BytesN<32>) -> Result<(), Error> {
        let issuer: Address = env
            .storage()
            .instance()
            .get(&Key::Issuer)
            .ok_or(Error::NotInitialized)?;
        issuer.require_auth();
        let key = Key::Root(batch_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::RootExists);
        }
        env.storage().persistent().set(
            &key,
            &RootRec {
                root,
                at: env.ledger().timestamp(),
            },
        );
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        bump_instance(&env);
        Ok(())
    }

    /// Permanently revokes `batch_id`. Separate (offline) revoker key.
    pub fn revoke(env: Env, batch_id: u64) -> Result<(), Error> {
        let r: Address = env
            .storage()
            .instance()
            .get(&Key::Revoker)
            .ok_or(Error::NotInitialized)?;
        r.require_auth();
        let key = Key::Revoked(batch_id);
        env.storage().persistent().set(&key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        bump_instance(&env);
        BatchRevoked { batch_id }.publish(&env);
        Ok(())
    }

    /// Ledger timestamp at which `batch_id` was anchored.
    pub fn anchored_at(env: Env, batch_id: u64) -> Result<u64, Error> {
        bump_instance(&env);
        if bump_if_present(&env, &Key::Revoked(batch_id)) {
            return Err(Error::Revoked);
        }
        bump_if_present(&env, &Key::Root(batch_id));
        let r: RootRec = env
            .storage()
            .persistent()
            .get(&Key::Root(batch_id))
            .ok_or(Error::NoRoot)?;
        Ok(r.at)
    }

    /// True if `leaf` at position `index` is included under the root anchored for `batch_id`.
    pub fn verify(
        env: Env,
        batch_id: u64,
        leaf: BytesN<32>,
        proof: Vec<BytesN<32>>,
        index: u32,
    ) -> Result<bool, Error> {
        if proof.len() > MAX_DEPTH {
            return Err(Error::ProofTooLong);
        }
        bump_instance(&env);
        if bump_if_present(&env, &Key::Revoked(batch_id)) {
            return Ok(false);
        }
        bump_if_present(&env, &Key::Root(batch_id));
        let Some(rec) = env
            .storage()
            .persistent()
            .get::<_, RootRec>(&Key::Root(batch_id))
        else {
            return Ok(false);
        };
        let mut h = leaf;
        let mut i = index as u64;
        for sib in proof.iter() {
            let mut buf = Bytes::from_array(&env, &[TAG_NODE]);
            if i & 1 == 1 {
                buf.append(&sib.into());
                buf.append(&h.into());
            } else {
                buf.append(&h.into());
                buf.append(&sib.into());
            }
            h = env.crypto().sha256(&buf).into();
            i >>= 1;
        }
        Ok(i == 0 && h == rec.root)
    }
}

#[cfg(test)]
mod test;
